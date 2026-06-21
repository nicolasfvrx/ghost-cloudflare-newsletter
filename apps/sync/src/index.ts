import type { SyncEnv, GhostMemberPayload, GhostMember, GhostMemberStatus } from "@newsletter/shared";
import { GhostAdminClient } from "./ghost";

/**
 * Worker "sync" : propriétaire de la base D1.
 * - fetch : événements membres transmis par "gateway" + endpoint de désinscription.
 * - scheduled (cron) : réconciliation Ghost -> D1 (rattrape les webhooks manqués).
 */
export default {
  async fetch(request: Request, env: SyncEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (request.method === "GET" && url.pathname === "/health") {
        return Response.json({ ok: true, worker: "sync" });
      }

      if (request.method === "GET" && url.pathname === "/unsubscribe") {
        return await unsubscribe(url, env, ctx);
      }

      if (request.method === "POST") {
        switch (url.pathname) {
          case "/members/added":
          case "/members/updated":
            return await upsertFromWebhook(request, env);
          case "/members/deleted":
            return await deleteMember(request, env);
          // Déclenchement manuel de la réconciliation (utile pour tester / forcer).
          case "/reconcile":
            return Response.json(await reconcile(env));
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

  // Cron : réconciliation périodique Ghost -> D1.
  async scheduled(_controller: ScheduledController, env: SyncEnv, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      reconcile(env)
        .then((r) => console.log("[sync] reconcile done", r))
        .catch((err) =>
          console.error("[sync] reconcile failed", {
            error: err instanceof Error ? (err.stack ?? err.message) : String(err),
          }),
        ),
    );
  },
} satisfies ExportedHandler<SyncEnv>;

// ---------------------------------------------------------------------------
// Webhooks membres
// ---------------------------------------------------------------------------
async function upsertFromWebhook(request: Request, env: SyncEnv): Promise<Response> {
  const payload = (await request.json()) as GhostMemberPayload;
  const member = payload.member?.current;
  if (!member?.email) {
    return new Response("Invalid member payload", { status: 422 });
  }
  await buildUpsert(env, member).run();
  return Response.json({ ok: true, email: member.email });
}

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
// Désinscription (lien public dans les emails) + sync-back vers Ghost
// ---------------------------------------------------------------------------
async function unsubscribe(url: URL, env: SyncEnv, ctx: ExecutionContext): Promise<Response> {
  const token = url.searchParams.get("token");
  if (!token) return htmlPage("Lien invalide.", 400);

  // On récupère l'email avant de mettre à jour, pour le sync-back vers Ghost.
  const row = await env.DB.prepare(`SELECT email FROM members WHERE unsubscribe_token = ?`)
    .bind(token)
    .first<{ email: string }>();

  if (!row) {
    return htmlPage("Ce lien de désinscription n'est plus valide.", 404);
  }

  // Effet local immédiat (on arrête d'emailer tout de suite).
  await env.DB.prepare(
    `UPDATE members SET subscribed = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE unsubscribe_token = ?`,
  )
    .bind(token)
    .run();

  // Sync-back vers Ghost (source de vérité) en arrière-plan : sinon la prochaine
  // réconciliation ré-abonnerait ce membre.
  if (env.GHOST_API_URL && env.GHOST_ADMIN_API_KEY) {
    ctx.waitUntil(syncUnsubscribeToGhost(row.email, env));
  } else {
    console.warn("[sync] Ghost API non configurée — sync-back de désinscription ignoré", { email: row.email });
  }

  return htmlPage("Vous avez bien été désinscrit·e. Vous ne recevrez plus nos newsletters.", 200);
}

async function syncUnsubscribeToGhost(email: string, env: SyncEnv): Promise<void> {
  try {
    const client = ghostClient(env);
    const member = await client.findMemberByEmail(email);
    if (!member) {
      console.warn("[sync] membre introuvable côté Ghost lors du sync-back", { email });
      return;
    }
    // Si une newsletter précise est ciblée, on conserve les autres ; sinon on retire tout.
    const keep = env.GHOST_NEWSLETTER_ID
      ? (member.newsletters ?? []).filter((n) => n.id !== env.GHOST_NEWSLETTER_ID).map((n) => n.id)
      : [];
    await client.unsubscribeMember(member.id, keep);
    console.log("[sync] désinscription propagée vers Ghost", { email, memberId: member.id });
  } catch (err) {
    console.error("[sync] sync-back de désinscription échoué", {
      email,
      error: err instanceof Error ? (err.stack ?? err.message) : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// Réconciliation Ghost -> D1
// ---------------------------------------------------------------------------
interface ReconcileResult {
  fetched: number;
  upserted: number;
  deleted: number;
}

async function reconcile(env: SyncEnv): Promise<ReconcileResult> {
  if (!env.GHOST_API_URL || !env.GHOST_ADMIN_API_KEY) {
    throw new Error("Ghost API non configurée (GHOST_API_URL / GHOST_ADMIN_API_KEY)");
  }

  const client = ghostClient(env);
  const seen = new Set<string>();
  const statements: D1PreparedStatement[] = [];

  // 1. On parcourt tous les membres Ghost et on prépare les upserts.
  for await (const member of client.iterateMembers()) {
    if (!member.email) continue;
    seen.add(member.email.toLowerCase());
    statements.push(buildUpsert(env, member));
  }

  // 2. Upserts par lots (limite raisonnable de statements par batch D1).
  await runInChunks(env, statements, 50);

  // 3. Suppression des membres absents de Ghost (webhook delete manqué).
  //    Garde-fou : on ne supprime que si la récupération a renvoyé des membres.
  let deleted = 0;
  if (deletionEnabled(env) && seen.size > 0) {
    const existing = await env.DB.prepare(`SELECT email FROM members`).all<{ email: string }>();
    const toDelete = (existing.results ?? []).filter((r) => !seen.has(r.email.toLowerCase()));
    if (toDelete.length > 0) {
      await runInChunks(
        env,
        toDelete.map((r) => env.DB.prepare(`DELETE FROM members WHERE email = ?`).bind(r.email)),
        50,
      );
      deleted = toDelete.length;
    }
  }

  return { fetched: seen.size, upserted: statements.length, deleted };
}

async function runInChunks(env: SyncEnv, statements: D1PreparedStatement[], size: number): Promise<void> {
  for (let i = 0; i < statements.length; i += size) {
    await env.DB.batch(statements.slice(i, i + size));
  }
}

function deletionEnabled(env: SyncEnv): boolean {
  return (env.RECONCILE_DELETE ?? "true").toLowerCase() !== "false";
}

// ---------------------------------------------------------------------------
// Upsert partagé (webhook + réconciliation)
// ---------------------------------------------------------------------------
function buildUpsert(env: SyncEnv, member: GhostMember): D1PreparedStatement {
  const id = member.uuid ?? member.id;
  const subscribed = computeSubscribed(member, env.GHOST_NEWSLETTER_ID) ? 1 : 0;
  const status = normalizeStatus(member.status);
  const token = generateToken(); // utilisé uniquement à l'INSERT (conservé en cas de conflit)

  return env.DB.prepare(
    `INSERT INTO members (id, email, name, status, subscribed, unsubscribe_token)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET
       id = excluded.id,
       name = excluded.name,
       status = excluded.status,
       subscribed = excluded.subscribed,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  ).bind(id, member.email, member.name ?? null, status, subscribed, token);
}

/** Détermine l'état d'abonnement à partir des newsletters Ghost (ou du flag legacy). */
function computeSubscribed(member: GhostMember, newsletterId?: string): boolean {
  if (newsletterId) {
    return (member.newsletters ?? []).some(
      (n) => n.id === newsletterId && (n.status ? n.status === "active" : true),
    );
  }
  if (Array.isArray(member.newsletters)) return member.newsletters.length > 0;
  return !!member.subscribed;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function ghostClient(env: SyncEnv): GhostAdminClient {
  return new GhostAdminClient({ url: env.GHOST_API_URL, adminKey: env.GHOST_ADMIN_API_KEY });
}

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
