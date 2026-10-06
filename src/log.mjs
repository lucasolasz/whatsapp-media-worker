const MB = 1024 * 1024;

/**
 * Uma linha por etapa, sempre com o id curto da conversão na frente: dá para
 * seguir uma conversão do recebimento ao destino. Nunca token, segredo nem URL assinada.
 */
export function registrar(id, mensagem) {
  log("info", `[${id.slice(0, 8)}] ${mensagem}`);
}

export function registrarFalha(id, mensagem, erro) {
  log("error", `[${id.slice(0, 8)}] ${mensagem}`, erro);
}

/** sv-SE formata como "2026-10-06 09:15:02". O container roda em UTC; o horário que importa é o de Brasília. */
const formatoData = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "America/Sao_Paulo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** Toda linha de log passa por aqui, para sair com data e hora. */
export function log(nivel, mensagem, erro) {
  const linha = `${formatoData.format(new Date())} ${mensagem}`;
  if (erro === undefined) console[nivel](linha);
  else console[nivel](linha, erro);
}

export const emMb = (bytes) =>
  Number.isFinite(bytes) ? `${(bytes / MB).toFixed(1).replace(".", ",")} MB` : "? MB";

export const segundosDesde = (inicio) => (Date.now() - inicio) / 1000;

export const emSegundos = (segundos) => `${segundos.toFixed(1).replace(".", ",")} s`;

export const velocidade = (bytes, segundos) =>
  segundos > 0 ? `${(bytes / MB / segundos).toFixed(2).replace(".", ",")} MB/s` : "-";
