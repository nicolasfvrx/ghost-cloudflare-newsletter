import type { GhostMember } from "@newsletter/shared";

// Client minimal pour l'API Ghost Admin (lecture des membres + désinscription).
// Authentification : JWT HS256 signé avec le secret de la clé Admin (format "id:secret"),
// audience "/admin/", validité courte. Aucune dépendance externe (Web Crypto).

export interface GhostAdminConfig {
  /** URL de base du blog Ghost, ex. https://nortek.wtf */
  url: string;
  /** Clé Admin API au format "id:secret" (secret en hexadécimal). */
  adminKey: string;
  /** Version d'API ciblée (défaut v5.0). */
  version?: string;
}

interface MembersResponse {
  members: GhostMember[];
  meta?: { pagination?: { page: number; pages: number } };
}

export class GhostAdminClient {
  private readonly base: string;
  private readonly keyId: string;
  private readonly keySecret: string;
  private readonly version: string;

  constructor(cfg: GhostAdminConfig) {
    const [id, secret] = cfg.adminKey.split(":");
    if (!id || !secret) {
      throw new Error('GHOST_ADMIN_API_KEY invalide (format attendu "id:secret")');
    }
    this.base = cfg.url.replace(/\/$/, "");
    this.keyId = id;
    this.keySecret = secret;
    this.version = cfg.version ?? "v5.0";
  }

  /** Parcourt tous les membres, page par page (générateur asynchrone). */
  async *iterateMembers(): AsyncGenerator<GhostMember> {
    let page = 1;
    for (;;) {
      const res = await this.request(`members/?limit=100&page=${page}&include=newsletters`);
      const json = (await res.json()) as MembersResponse;
      for (const member of json.members ?? []) yield member;

      const pages = json.meta?.pagination?.pages ?? page;
      if (page >= pages) break;
      page++;
    }
  }

  /** Récupère un membre par email (pour obtenir son id Admin). */
  async findMemberByEmail(email: string): Promise<GhostMember | null> {
    const filter = encodeURIComponent(`email:'${email.replace(/'/g, "\\'")}'`);
    const res = await this.request(`members/?filter=${filter}&include=newsletters&limit=1`);
    const json = (await res.json()) as MembersResponse;
    return json.members?.[0] ?? null;
  }

  /**
   * Désabonne un membre côté Ghost.
   * Par défaut, retire toutes les newsletters ; on peut conserver une liste d'ids.
   */
  async unsubscribeMember(memberId: string, keepNewsletterIds: string[] = []): Promise<void> {
    await this.request(`members/${memberId}/`, {
      method: "PUT",
      body: JSON.stringify({
        members: [{ newsletters: keepNewsletterIds.map((id) => ({ id })) }],
      }),
    });
  }

  // -------------------------------------------------------------------------
  private async request(path: string, opts: { method?: string; body?: string } = {}): Promise<Response> {
    const token = await this.token();
    const res = await fetch(`${this.base}/ghost/api/admin/${path}`, {
      method: opts.method ?? "GET",
      body: opts.body,
      headers: {
        Authorization: `Ghost ${token}`,
        "Accept-Version": this.version,
        "Content-Type": "application/json",
      },
    });
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`Ghost API ${res.status} ${opts.method ?? "GET"} ${path}: ${detail.slice(0, 200)}`);
    }
    return res;
  }

  /** Génère un JWT Ghost Admin (HS256, validité 5 min). */
  private async token(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: "HS256", typ: "JWT", kid: this.keyId };
    const payload = { iat: now, exp: now + 5 * 60, aud: "/admin/" };
    const data = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;

    const key = await crypto.subtle.importKey(
      "raw",
      hexToBytes(this.keySecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
    return `${data}.${b64urlBytes(new Uint8Array(sig))}`;
  }
}

// ---------------------------------------------------------------------------
// Helpers d'encodage
// ---------------------------------------------------------------------------
function b64urlBytes(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64url(str: string): string {
  return b64urlBytes(new TextEncoder().encode(str));
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
