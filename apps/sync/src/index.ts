import type { SyncEnv, GhostMemberPayload, GhostMemberStatus } from "@newsletter/shared";

/**
 * Worker "sync" : propriétaire de la base D1.
 * - Reçoit les événements membres transmis par le Worker "gateway".
 * - Gère ajout / mise à jour / suppression + génération des unsubscribe_token.
 * - Sert l'endpoint public de désinscription.
 */
export default {
  async fetch(request: Request, env: SyncEnv): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (request.method === "GET" && url.pathname === "/health") {
        return Response.json({ ok: true, worker: "sync" });
      }

      if (request.method === "GET" && url.pathname === "/unsubscribe") {
        return await unsubscribe(url, env);
      }

      if (request.method === "POST") {
        switch (url.pathname) {
          case "/members/added":
          case "/members/updated":
            return await upsertMember(request, env);
          case "/members/deleted":
            return await deleteMember(request, env);
        }
      }

      return new Response("Not found", { status: 404 });
    } catch (err) {
      console.error("[sync] unhandled error", {
        path: url.pathname,
        error: err instanceof Error ? (err.stack ?? err.message) : String(err),
      });
      return new Response("Internal Server Error", { status: 500 });
    }
  },
} satisfies ExportedHandler<SyncEnv>;

// ---------------------------------------------------------------------------
// Ajout / mise à jour d'un membre
// ---------------------------------------------------------------------------
async function upsertMember(request: Request, env: SyncEnv): Promise<Response> {
  const payload = (await request.json()) as GhostMemberPayload;
  const member = payload.member?.current;
  if (!member?.email) {
    return new Response("Invalid member payload", { status: 422 });
  }

  const id = member.uuid ?? member.id;
  const subscribed = member.subscribed ? 1 : 0;
  const status = normalizeStatus(member.status);
  const token = generateToken();

  // INSERT ... ON CONFLICT : on conserve le unsubscribe_token existant
  // (il n'est défini qu'à la création de la ligne).
  await env.DB.prepare(
    `INSERT INTO members (id, email, name, status, subscribed, unsubscribe_token)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET
       id = excluded.id,
       name = excluded.name,
       status = excluded.status,
       subscribed = excluded.subscribed,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  )
    .bind(id, member.email, member.name ?? null, status, subscribed, token)
    .run();

  return Response.json({ ok: true, id, email: member.email });
}

// ---------------------------------------------------------------------------
// Suppression d'un membre
// ---------------------------------------------------------------------------
async function deleteMember(request: Request, env: SyncEnv): Promise<Response> {
  const payload = (await request.json()) as GhostMemberPayload;
  // À la suppression, Ghost renseigne généralement `previous`.
  const member = payload.member?.current ?? payload.member?.previous;
  if (!member?.email) {
    return new Response("Invalid member payload", { status: 422 });
  }

  await env.DB.prepare(`DELETE FROM members WHERE email = ?`).bind(member.email).run();
  return Response.json({ ok: true, email: member.email });
}

// ---------------------------------------------------------------------------
// Désinscription (lien public dans les emails)
// ---------------------------------------------------------------------------
async function unsubscribe(url: URL, env: SyncEnv): Promise<Response> {
  const token = url.searchParams.get("token");
  if (!token) return htmlPage("Lien invalide.", 400);

  const result = await env.DB.prepare(
    `UPDATE members SET subscribed = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE unsubscribe_token = ?`,
  )
    .bind(token)
    .run();

  if ((result.meta.changes ?? 0) === 0) {
    return htmlPage("Ce lien de désinscription n'est plus valide.", 404);
  }
  return htmlPage("Vous avez bien été désinscrit·e. Vous ne recevrez plus nos newsletters.", 200);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function normalizeStatus(status: string | undefined): GhostMemberStatus {
  return status === "paid" || status === "comped" ? status : "free";
}

/** Jeton de désinscription : 32 octets aléatoires en hexadécimal (non devinable). */
function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function htmlPage(message: string, status: number): Response {
  const body = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Désinscription</title>
</head>
<body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f4f4f5;margin:0;padding:48px 16px;text-align:center;color:#27272a;">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:8px;padding:40px;">
    <h1 style="font-size:20px;margin:0 0 12px;">Newsletter</h1>
    <p style="font-size:16px;line-height:1.6;margin:0;">${message}</p>
  </div>
</body>
</html>`;
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
