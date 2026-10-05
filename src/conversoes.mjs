import { readFile, rm, stat } from "node:fs/promises";
import { ErroMidia, converterMidia } from "./conversao.mjs";
import { emMb, emSegundos, registrar, registrarFalha, segundosDesde } from "./log.mjs";

const conversoes = new Map();

/**
 * Uma conversão por vez: o ffmpeg usa toda a CPU que encontra, e o WAHA costuma
 * dividir a máquina. Estado em memória basta: conversão perdida num restart volta
 * como 404 no status, e quem chamou envia de novo.
 */
let fila = Promise.resolve();
let naFila = 0;

export function registrarConversao({ id, jti, pasta, entrada, contentTypeEntrada, destinoUrl }) {
  const conversao = {
    id,
    jti,
    pasta,
    destinoUrl,
    status: "processando",
    progresso: 0,
    criadaEm: Date.now(),
  };
  conversoes.set(conversao.id, conversao);
  registrar(id, naFila ? `na fila: ${naFila} conversão(ões) à frente` : "na fila: nenhuma à frente");
  naFila++;
  fila = fila
    .then(() => processar(conversao, entrada, contentTypeEntrada))
    .finally(() => naFila--);
  return conversao;
}

/** Só quem tem o token que criou a conversão a enxerga. */
export function buscarConversao(id, jti) {
  const conversao = conversoes.get(id);
  return conversao?.jti === jti ? conversao : null;
}

export function resumoConversao({ status, progresso, contentType, tamanho, erro }) {
  return { status, progresso, content_type: contentType, tamanho, erro };
}

/** Quartos do progresso que entram no log: conversão longa mostra que segue andando. */
const MARCOS_PROGRESSO = [25, 50, 75];

async function processar(conversao, entrada, contentTypeEntrada) {
  const { id } = conversao;
  const inicio = Date.now();
  let etapa = "conversão";
  try {
    const { size: tamanhoEntrada } = await stat(entrada);
    registrar(id, `conversão iniciada: ${contentTypeEntrada}, ${emMb(tamanhoEntrada)}`);

    const marcos = [...MARCOS_PROGRESSO];
    const resultado = await converterMidia(
      entrada,
      contentTypeEntrada,
      conversao.pasta,
      (progresso) => {
        conversao.progresso = progresso;
        while (marcos.length && progresso >= marcos[0]) {
          registrar(id, `convertendo: ${marcos.shift()}%`);
        }
      },
      (mensagem) => registrar(id, mensagem),
    );
    await rm(entrada, { force: true });

    const reducao = Math.round((1 - resultado.tamanho / tamanhoEntrada) * 100);
    registrar(
      id,
      `conversão concluída: ${resultado.contentType}, ${emMb(resultado.tamanho)} (${reducao >= 0 ? "-" : "+"}${Math.abs(reducao)}%) em ${emSegundos(segundosDesde(inicio))}`,
    );

    if (conversao.destinoUrl) {
      etapa = "gravação no destino";
      const inicioEnvio = Date.now();
      const host = new URL(conversao.destinoUrl).host;
      registrar(id, `gravando no destino ${host}`);
      await enviarAoDestino(conversao.destinoUrl, resultado);
      registrar(id, `gravado no destino ${host} em ${emSegundos(segundosDesde(inicioEnvio))}`);
      await rm(conversao.pasta, { recursive: true, force: true });
    } else {
      conversao.caminho = resultado.caminho;
      registrar(id, "aguardando download");
    }

    Object.assign(conversao, {
      status: "pronta",
      progresso: 100,
      contentType: resultado.contentType,
      tamanho: resultado.tamanho,
    });
    registrar(id, `pronta em ${emSegundos(segundosDesde(inicio))}`);
  } catch (erro) {
    registrarFalha(id, `falha na ${etapa} após ${emSegundos(segundosDesde(inicio))}:`, erro);
    Object.assign(conversao, {
      status: "erro",
      erro:
        erro instanceof ErroMidia
          ? erro.message
          : "Não foi possível converter o arquivo. Tente outro arquivo ou formato",
    });
    await rm(conversao.pasta, { recursive: true, force: true });
  }
}

/** O destino é uma URL de PUT já assinada por quem chamou: o worker não guarda credencial de bucket. */
async function enviarAoDestino(url, { caminho, contentType }) {
  const resposta = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: await readFile(caminho),
    signal: AbortSignal.timeout(120_000),
  }).catch((erro) => ({ ok: false, status: erro.message }));

  if (!resposta.ok) {
    throw new ErroMidia("Não foi possível gravar o arquivo convertido no destino", {
      cause: new Error(`destino respondeu ${resposta.status}`),
    });
  }
}

/** Resultado não baixado em `retencaoMs` é descartado; o token já expirou mesmo. */
export async function limparAntigas(retencaoMs) {
  const limite = Date.now() - retencaoMs;
  for (const conversao of conversoes.values()) {
    if (conversao.status === "processando" || conversao.criadaEm > limite) continue;
    conversoes.delete(conversao.id);
    await rm(conversao.pasta, { recursive: true, force: true });
  }
}
