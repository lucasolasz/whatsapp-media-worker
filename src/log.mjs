const MB = 1024 * 1024;

/**
 * Uma linha por etapa, sempre com o id curto da conversão na frente: dá para
 * seguir uma conversão do recebimento ao destino. Nunca token, segredo nem URL assinada.
 */
export function registrar(id, mensagem, nivel = "info") {
  log(nivel, `[${id.slice(0, 8)}] ${mensagem}`);
}

export function registrarFalha(id, mensagem, erro) {
  log("error", `[${id.slice(0, 8)}] ${mensagem}`, erro);
}

const doisDigitos = (numero) => String(numero).padStart(2, "0");

/**
 * Hora local com o deslocamento ("2026-10-06T09:15:02-03:00"): o fuso vem da variável
 * TZ do deploy, e o deslocamento permite cruzar com logs em UTC (Traefik, WAHA, n8n).
 */
function dataHora(data) {
  const deslocamento = -data.getTimezoneOffset();
  const local = new Date(data.getTime() + deslocamento * 60_000).toISOString().slice(0, 19);
  const minutos = Math.abs(deslocamento);
  return `${local}${deslocamento < 0 ? "-" : "+"}${doisDigitos(Math.floor(minutos / 60))}:${doisDigitos(minutos % 60)}`;
}

/** Mensagem do erro seguida das causas, como "Não foi possível ler o vídeo ← ffprobe falhou (1): …". */
function descreverErro(erro) {
  const partes = [];
  for (let atual = erro; atual != null; atual = atual.cause) {
    partes.push(String(atual.message ?? atual).trim());
  }
  return partes.join(" ← ");
}

/**
 * Toda linha que o worker escreve passa por aqui, com data e hora. Quebras de linha
 * (stderr do ffmpeg, stack) viram " | " para cada chamada continuar sendo uma linha só.
 * Exceções não tratadas o Node escreve direto, sem passar por aqui.
 */
export function log(nivel, mensagem, erro) {
  const detalhe = erro == null ? "" : ` ${descreverErro(erro)}`;
  console[nivel](`${dataHora(new Date())} ${mensagem}${detalhe}`.replace(/\s*\n\s*/g, " | "));
}

export const emMb = (bytes) =>
  Number.isFinite(bytes) ? `${(bytes / MB).toFixed(1).replace(".", ",")} MB` : "? MB";

export const segundosDesde = (inicio) => (Date.now() - inicio) / 1000;

export const emSegundos = (segundos) => `${segundos.toFixed(1).replace(".", ",")} s`;

export const velocidade = (bytes, segundos) =>
  segundos > 0 ? `${(bytes / MB / segundos).toFixed(2).replace(".", ",")} MB/s` : "-";
