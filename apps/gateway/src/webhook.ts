// Vérification de la signature des webhooks Ghost (Web Crypto, aucune dépendance).

const encoder = new TextEncoder();

/**
 * Vérifie la signature d'un webhook Ghost.
 *
 * En-tête attendu : `X-Ghost-Signature: sha256=<hex>, t=<timestamp_ms>`
 * Le HMAC-SHA256 est calculé sur `${body}${timestamp}` avec le secret du webhook.
 *
 * NB : l'ordre exact de concaténation peut varier selon la version de Ghost ;
 * vérifier contre l'instance cible si la validation échoue systématiquement.
 *
 * Si aucun secret n'est configuré, la vérification est ignorée (utile en dev).
 */
export async function verifyGhostSignature(
  body: string,
  header: string | null,
  secret: string | undefined,
): Promise<boolean> {
  if (!secret) {
    console.warn("[gateway] GHOST_WEBHOOK_SECRET non défini — vérification de signature ignorée");
    return true;
  }
  if (!header) return false;

  const { sha256, t } = parseSignatureHeader(header);
  if (!sha256 || !t) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(`${body}${t}`));
  return timingSafeEqual(toHex(new Uint8Array(mac)), sha256);
}

function parseSignatureHeader(header: string): { sha256?: string; t?: string } {
  const out: { sha256?: string; t?: string } = {};
  for (const segment of header.split(",")) {
    const idx = segment.indexOf("=");
    if (idx === -1) continue;
    const k = segment.slice(0, idx).trim();
    const v = segment.slice(idx + 1).trim();
    if (k === "sha256") out.sha256 = v;
    else if (k === "t") out.t = v;
  }
  return out;
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/** Comparaison à temps constant pour éviter les attaques temporelles. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
