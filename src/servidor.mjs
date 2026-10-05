import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { FORMATOS_ENTRADA } from "./conversao.mjs";
import {
  buscarConversao,
  limparAntigas,
  registrarConversao,
  resumoConversao,
} from "./conversoes.mjs";
import { verificarToken } from "./token.mjs";

const MB = 1024 * 1024;
const lista = (valor) =>
  (valor ?? "").split(",").map((item) => item.trim()).filter(Boolean);

const semAspas = (valor) => valor.replace(/^["']|["']$/g, "");

/** Aceita com ou sem protocolo, barra final ou caminho: só o host (com porta, se houver) é comparado. */
function paraHost(entrada) {
  const valor = semAspas(entrada);
  return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(valor) ? valor : `http://${valor}`).host;
}

/** O browser manda Origin sem barra nem caminho. Sem protocolo não dá para saber se é http ou https. */
function paraOrigem(entrada) {
  const valor = semAspas(entrada);
  if (!/^https?:\/\//i.test(valor)) throw new Error("origem sem http:// ou https://");
  return new URL(valor).origin;
}

/** Valor que não dá para interpretar derruba a subida: melhor do que recusar requisições sem explicar. */
function lerConjunto(variavel, converter) {
  return new Set(
    lista(process.env[variavel]).map((item) => {
      try {
        return converter(item);
      } catch {
        console.error(`${variavel}: valor inválido "${item}"`);
        process.exit(1);
      }
    }),
  );
}

const PORTA = Number(process.env.PORT ?? 3000);
const SEGREDOS = lista(process.env.SEGREDOS_TOKEN);
const ORIGENS = lerConjunto("CORS_ORIGENS", paraOrigem);
const DESTINOS = lerConjunto("DESTINOS_PERMITIDOS", paraHost);
const TAMANHO_MAXIMO = Number(process.env.TAMANHO_MAXIMO_MB ?? 100) * MB;
const RETENCAO_MS = Number(process.env.RETENCAO_MINUTOS ?? 60) * 60 * 1000;

const TAMANHO_MINIMO_SEGREDO = 32;

// Segredo curto ou o placeholder do template deixaria qualquer um gerar tokens.
if (!SEGREDOS.length || SEGREDOS.some((segredo) => segredo.length < TAMANHO_MINIMO_SEGREDO)) {
  console.error(`SEGREDOS_TOKEN precisa de ao menos um segredo, cada um com ${TAMANHO_MINIMO_SEGREDO}+ caracteres`);
  process.exit(1);
}

/** Token é de uso único: um token vazado não vira cota ilimitada de conversões. */
const tokensUsados = new Map();

class ErroHttp extends Error {
  constructor(status, mensagem) {
    super(mensagem);
    this.status = status;
  }
}

function cabecalhosCors(origem) {
  if (!ORIGENS.has(origem)) return {};
  return {
    "Access-Control-Allow-Origin": origem,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

function responder(resposta, status, corpo) {
  resposta.writeHead(status, { "Content-Type": "application/json" });
  resposta.end(JSON.stringify(corpo));
}

function autenticar(requisicao) {
  const token = verificarToken(requisicao.headers.authorization, SEGREDOS);
  if (!token) throw new ErroHttp(401, "Token inválido ou expirado");
  return token;
}

/** O destino vem dentro do token assinado; a lista de hosts é uma segunda barreira contra SSRF. */
function validarDestino(destinoUrl) {
  if (destinoUrl === undefined) return undefined;
  let host;
  try {
    host = new URL(destinoUrl).host;
  } catch {
    throw new ErroHttp(400, "destino_url inválida");
  }
  // O host não é segredo (quem chamou gerou a URL) e mostrá-lo encurta o diagnóstico de configuração.
  if (!DESTINOS.has(host)) throw new ErroHttp(400, `Destino não permitido: ${host}`);
  return destinoUrl;
}

async function receberArquivo(requisicao, destino, limite) {
  if (Number(requisicao.headers["content-length"]) > limite) {
    throw new ErroHttp(413, `Arquivo acima de ${Math.floor(limite / MB)} MB`);
  }
  let recebidos = 0;
  requisicao.on("data", (pedaco) => {
    recebidos += pedaco.length;
    if (recebidos > limite) {
      requisicao.destroy(new ErroHttp(413, `Arquivo acima de ${Math.floor(limite / MB)} MB`));
    }
  });
  await pipeline(requisicao, createWriteStream(destino));
  if (!recebidos) throw new ErroHttp(400, "Arquivo vazio");
}

async function criarConversao(requisicao, resposta) {
  const token = autenticar(requisicao);
  if (tokensUsados.has(token.jti)) throw new ErroHttp(409, "Token já utilizado");

  const contentType = (requisicao.headers["content-type"] ?? "").split(";")[0].trim();
  if (!FORMATOS_ENTRADA.has(contentType)) {
    throw new ErroHttp(415, `Formato não suportado. Aceitos: ${[...FORMATOS_ENTRADA].join(", ")}`);
  }

  const destinoUrl = validarDestino(token.destino_url);
  const limite = Math.min(TAMANHO_MAXIMO, token.tamanho_maximo ?? TAMANHO_MAXIMO);
  tokensUsados.set(token.jti, token.exp);

  const pasta = await mkdtemp(join(tmpdir(), "conversao-"));
  const entrada = join(pasta, "entrada");
  try {
    await receberArquivo(requisicao, entrada, limite);
  } catch (erro) {
    await rm(pasta, { recursive: true, force: true });
    throw erro;
  }

  const conversao = registrarConversao({
    jti: token.jti,
    pasta,
    entrada,
    contentTypeEntrada: contentType,
    destinoUrl,
  });
  responder(resposta, 202, { id: conversao.id });
}

async function consultarConversao(requisicao, resposta, id, querArquivo) {
  const conversao = buscarConversao(id, autenticar(requisicao).jti);
  if (!conversao) throw new ErroHttp(404, "Conversão não encontrada");

  if (!querArquivo) return responder(resposta, 200, resumoConversao(conversao));

  if (conversao.status !== "pronta" || !conversao.caminho) {
    throw new ErroHttp(409, "Arquivo indisponível: conversão não terminou ou foi enviada ao destino");
  }
  resposta.writeHead(200, {
    "Content-Type": conversao.contentType,
    "Content-Length": conversao.tamanho,
  });
  await pipeline(createReadStream(conversao.caminho), resposta);
}

const ROTA_CONVERSAO = /^\/conversoes\/([0-9a-f-]{36})(\/arquivo)?$/;

const servidor = createServer(async (requisicao, resposta) => {
  for (const [nome, valor] of Object.entries(cabecalhosCors(requisicao.headers.origin))) {
    resposta.setHeader(nome, valor);
  }

  try {
    const { pathname } = new URL(requisicao.url, "http://localhost");
    if (requisicao.method === "OPTIONS") {
      resposta.writeHead(204).end();
    } else if (requisicao.method === "GET" && pathname === "/saude") {
      responder(resposta, 200, { ok: true });
    } else if (requisicao.method === "POST" && pathname === "/conversoes") {
      await criarConversao(requisicao, resposta);
    } else if (requisicao.method === "GET" && ROTA_CONVERSAO.test(pathname)) {
      const [, id, arquivo] = pathname.match(ROTA_CONVERSAO);
      await consultarConversao(requisicao, resposta, id, !!arquivo);
    } else {
      responder(resposta, 404, { error: "Não encontrado" });
    }
  } catch (erro) {
    if (!(erro instanceof ErroHttp)) console.error("Erro inesperado:", erro);
    // Upload acima do limite derruba a conexão: aí não há mais a quem responder.
    if (!resposta.headersSent && !requisicao.socket.destroyed) {
      responder(resposta, erro.status ?? 500, {
        error: erro instanceof ErroHttp ? erro.message : "Erro interno",
      });
    }
  }
});

// Upload de dezenas de MB em rede móvel passa fácil dos 5 min padrão do Node.
servidor.requestTimeout = 30 * 60 * 1000;
servidor.listen(PORTA, () => console.info(`whatsapp-media-worker ouvindo na porta ${PORTA}`));

setInterval(() => {
  const agora = Date.now() / 1000;
  for (const [jti, exp] of tokensUsados) if (exp < agora) tokensUsados.delete(jti);
  limparAntigas(RETENCAO_MS).catch((erro) => console.error("Falha na limpeza:", erro));
}, 5 * 60 * 1000).unref();
