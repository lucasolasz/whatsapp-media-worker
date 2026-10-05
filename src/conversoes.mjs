import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { ErroMidia, converterMidia } from "./conversao.mjs";

const conversoes = new Map();

/**
 * Uma conversão por vez: o ffmpeg usa toda a CPU que encontra, e o WAHA costuma
 * dividir a máquina. Estado em memória basta: conversão perdida num restart volta
 * como 404 no status, e quem chamou envia de novo.
 */
let fila = Promise.resolve();

export function registrarConversao({ jti, pasta, entrada, contentTypeEntrada, destinoUrl }) {
  const conversao = {
    id: randomUUID(),
    jti,
    pasta,
    destinoUrl,
    status: "processando",
    progresso: 0,
    criadaEm: Date.now(),
  };
  conversoes.set(conversao.id, conversao);
  fila = fila.then(() => processar(conversao, entrada, contentTypeEntrada));
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

async function processar(conversao, entrada, contentTypeEntrada) {
  const inicio = Date.now();
  try {
    const resultado = await converterMidia(entrada, contentTypeEntrada, conversao.pasta, (progresso) => {
      conversao.progresso = progresso;
    });
    await rm(entrada, { force: true });

    if (conversao.destinoUrl) {
      await enviarAoDestino(conversao.destinoUrl, resultado);
      await rm(conversao.pasta, { recursive: true, force: true });
    } else {
      conversao.caminho = resultado.caminho;
    }

    Object.assign(conversao, {
      status: "pronta",
      progresso: 100,
      contentType: resultado.contentType,
      tamanho: resultado.tamanho,
    });
    console.info(`[conversao ${conversao.id}] pronta em ${Math.round((Date.now() - inicio) / 1000)} s`);
  } catch (erro) {
    console.error(`[conversao ${conversao.id}] falha:`, erro);
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
