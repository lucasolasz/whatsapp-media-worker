import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Token = base64url(payload JSON) + "." + base64url(HMAC-SHA256(segredo, parte1)).
 * Quem gera é o backend do app cliente, que conhece o segredo; o browser só
 * repassa. Payload: { exp (unix s), jti, destino_url?, tamanho_maximo? }.
 * Aceita vários segredos (um por app, ou o antigo e o novo durante uma troca).
 */
export function verificarToken(cabecalho, segredos) {
  const token = cabecalho?.startsWith("Bearer ") ? cabecalho.slice(7) : "";
  const [payload, assinatura] = token.split(".");
  if (!payload || !assinatura) return null;

  const recebida = Buffer.from(assinatura, "base64url");
  const valida = segredos.some((segredo) => {
    const esperada = createHmac("sha256", segredo).update(payload).digest();
    return esperada.length === recebida.length && timingSafeEqual(esperada, recebida);
  });
  if (!valida) return null;

  try {
    const dados = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (typeof dados.jti !== "string" || !(dados.exp > Date.now() / 1000)) return null;
    return dados;
  } catch {
    return null;
  }
}
