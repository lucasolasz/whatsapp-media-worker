const MB = 1024 * 1024;

/**
 * Uma linha por etapa, sempre com o id curto da conversão na frente: dá para
 * seguir uma conversão do recebimento ao destino. Nunca token, segredo nem URL assinada.
 */
export function registrar(id, mensagem) {
  console.info(`[${id.slice(0, 8)}] ${mensagem}`);
}

export function registrarFalha(id, mensagem, erro) {
  console.error(`[${id.slice(0, 8)}] ${mensagem}`, erro ?? "");
}

export const emMb = (bytes) =>
  Number.isFinite(bytes) ? `${(bytes / MB).toFixed(1).replace(".", ",")} MB` : "? MB";

export const segundosDesde = (inicio) => (Date.now() - inicio) / 1000;

export const emSegundos = (segundos) => `${segundos.toFixed(1).replace(".", ",")} s`;

export const velocidade = (bytes, segundos) =>
  segundos > 0 ? `${(bytes / MB / segundos).toFixed(2).replace(".", ",")} MB/s` : "-";
