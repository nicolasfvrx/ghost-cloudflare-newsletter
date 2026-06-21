import type {
  GatewayEnv,
  GhostPostPayload,
  MemberRow,
  NewsletterSendJob,
} from "@newsletter/shared";
import { verifyGhostSignature } from "./webhook";
import { extractImageSrcs, rewriteImageSrcs, renderEmail } from "./html";
import { optimizeAndStore } from "./images";

const MEMBER_ACTIONS = new Set(["added", "updated", "deleted"]);

/**
 * Worker "gateway" : point d'entrée public.
 * - Route les événements membres vers le Worker "sync" (service binding).
 * - Traite `post.published` : optimisation d'images -> R2 -> réécriture HTML
 *   -> cache KV -> fan-out vers la Queue -> télémétrie Analytics Engine.
 */
export default {
  async fetch(request: Request, env: GatewayEnv, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (request.method === "GET" && url.pathname === "/health") {
        return Response.json({ ok: true, worker: "gateway" });
      }

      if (request.method === "POST" && url.pathname === "/webhooks/post/published") {
        return await handlePostPublished(request, env);
      }

      const memberMatch = url.pathname.match(/^\/webhooks\/member\/([a-z]+)$/);
      if (request.method === "POST" && memberMatch && MEMBER_ACTIONS.has(memberMatch[1])) {
        return await forwardMemberEvent(memberMatch[1], request, env);
      }

      return new Response("Not found", { status: 404 });
    } catch (err) {
      // Toute exception non gérée remonte ici -> log structuré pour l'Observability.
      console.error("[gateway] unhandled error", {
        path: url.pathname,
        error: err instanceof Error ? (err.stack ?? err.message) : String(err),
      });
      return new Response("Internal Server Error", { status: 500 });
    }
  },
} satisfies ExportedHandler<GatewayEnv>;

// ---------------------------------------------------------------------------
// post.published : pipeline de traitement du contenu
// ---------------------------------------------------------------------------
async function handlePostPublished(request: Request, env: GatewayEnv): Promise<Response> {
  const raw = await request.text();
  if (!(await verifyGhostSignature(raw, request.headers.get("X-Ghost-Signature"), env.GHOST_WEBHOOK_SECRET))) {
    return new Response("Invalid signature", { status: 401 });
  }

  const payload = JSON.parse(raw) as GhostPostPayload;
  const post = payload.post?.current;
  if (!post || !post.html) {
    return new Response("No post content", { status: 422 });
  }

  const campaignId = crypto.randomUUID();
  const subject = post.title || "Newsletter";

  // 1. Extraction des URLs d'images d'origine (HTMLRewriter, passe A).
  const srcs = await extractImageSrcs(post.html);

  // 2-4. Optimisation (cf.image) -> PUT R2 -> table de correspondance des URLs.
  const { mapping, processed } = await optimizeAndStore(srcs, env, campaignId);

  // Réécriture des `src` vers le CDN R2 (HTMLRewriter, passe B).
  const rewritten = await rewriteImageSrcs(post.html, mapping);

  // Coquille email finale, avec marqueurs personnalisés par destinataire.
  const finalHtml = renderEmail({
    title: subject,
    contentHtml: rewritten,
    postUrl: post.url,
    fromName: env.FROM_NAME,
  });

  // 5. Mise en cache du HTML dans KV (7 jours).
  const htmlKey = `campaign:${campaignId}`;
  await env.HTML_CACHE.put(htmlKey, finalHtml, { expirationTtl: 60 * 60 * 24 * 7 });

  // 6. Sélection des destinataires éligibles + fan-out vers la Queue.
  const recipients = await getEligibleMembers(env, post.visibility);

  await env.DB.prepare(
    `INSERT INTO campaigns (id, post_id, title, html_key, status, recipients, images_count)
     VALUES (?, ?, ?, ?, 'queued', ?, ?)`,
  )
    .bind(campaignId, post.id, subject, htmlKey, recipients.length, processed)
    .run();

  await enqueueRecipients(env, { campaignId, postId: post.id, subject, htmlKey }, recipients);

  // 7. Télémétrie de traitement (Analytics Engine).
  env.ANALYTICS.writeDataPoint({
    indexes: [campaignId],
    blobs: ["newsletter_processed", campaignId, post.id, post.visibility ?? "public"],
    doubles: [processed, recipients.length, srcs.length],
  });

  console.log("[gateway] post processed", {
    campaignId,
    postId: post.id,
    images: `${processed}/${srcs.length}`,
    recipients: recipients.length,
  });

  return Response.json({ campaignId, imagesProcessed: processed, recipients: recipients.length });
}

// ---------------------------------------------------------------------------
// Événements membres : transmission au Worker "sync" via service binding
// ---------------------------------------------------------------------------
async function forwardMemberEvent(action: string, request: Request, env: GatewayEnv): Promise<Response> {
  const raw = await request.text();
  if (!(await verifyGhostSignature(raw, request.headers.get("X-Ghost-Signature"), env.GHOST_WEBHOOK_SECRET))) {
    return new Response("Invalid signature", { status: 401 });
  }

  // Le gateway a authentifié l'appel : "sync" fait confiance au service binding.
  return env.SYNC.fetch(`https://sync/members/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw,
  });
}

// ---------------------------------------------------------------------------
// Helpers D1 / Queue
// ---------------------------------------------------------------------------
type Recipient = Pick<MemberRow, "id" | "email" | "name" | "unsubscribe_token">;

async function getEligibleMembers(env: GatewayEnv, visibility: string | undefined): Promise<Recipient[]> {
  // Pour un post payant, on restreint aux membres payants / offerts.
  const paidOnly = visibility === "paid" || visibility === "tiers";
  const sql = paidOnly
    ? `SELECT id, email, name, unsubscribe_token FROM members
       WHERE subscribed = 1 AND status IN ('paid', 'comped')`
    : `SELECT id, email, name, unsubscribe_token FROM members WHERE subscribed = 1`;

  const { results } = await env.DB.prepare(sql).all<Recipient>();
  return results ?? [];
}

interface JobBase {
  campaignId: string;
  postId: string;
  subject: string;
  htmlKey: string;
}

async function enqueueRecipients(env: GatewayEnv, base: JobBase, recipients: Recipient[]): Promise<void> {
  const BATCH = 100; // taille max d'un sendBatch Cloudflare Queues
  for (let i = 0; i < recipients.length; i += BATCH) {
    const slice = recipients.slice(i, i + BATCH);
    const messages = slice.map((r) => {
      const body: NewsletterSendJob = {
        ...base,
        recipient: {
          memberId: r.id,
          email: r.email,
          name: r.name,
          unsubscribeToken: r.unsubscribe_token,
        },
      };
      return { body };
    });
    await env.SEND_QUEUE.sendBatch(messages);
  }
}
