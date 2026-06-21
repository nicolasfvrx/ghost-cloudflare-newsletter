import type {
  SenderEnv,
  NewsletterSendJob,
  EmailSendOptions,
  EmailSendResult,
} from "@newsletter/shared";

type SendStatus = "success" | "bounce" | "dropped" | "error";

/**
 * Worker "sender" : consumer de la Queue.
 * - Récupère le HTML depuis KV (mis en cache par lot pour une seule lecture par campagne).
 * - Personnalise le lien de désinscription par destinataire.
 * - Expédie via le binding Cloudflare Email Sending.
 * - Écrit un datapoint Analytics Engine par envoi (statut, membre, campagne).
 */
export default {
  async queue(batch: MessageBatch<NewsletterSendJob>, env: SenderEnv, _ctx: ExecutionContext): Promise<void> {
    const htmlCache = new Map<string, string>();
    for (const message of batch.messages) {
      await processMessage(message, env, htmlCache);
    }
  },
} satisfies ExportedHandler<SenderEnv, NewsletterSendJob>;

async function processMessage(
  message: Message<NewsletterSendJob>,
  env: SenderEnv,
  htmlCache: Map<string, string>,
): Promise<void> {
  const job = message.body;
  const r = job.recipient;

  try {
    const template = await getCachedHtml(job.htmlKey, env, htmlCache);

    const base = env.UNSUBSCRIBE_BASE_URL.replace(/\/$/, "");
    const unsubUrl = `${base}/unsubscribe?token=${encodeURIComponent(r.unsubscribeToken)}`;

    const html = template
      .replaceAll("%%UNSUBSCRIBE_URL%%", unsubUrl)
      .replaceAll("%%NAME%%", escapeHtml(r.name ?? ""));

    const result = await sendEmail(env, {
      to: r.email,
      from: formatFrom(env.FROM_NAME, env.FROM_EMAIL),
      subject: job.subject,
      html,
      text: htmlToText(html),
      headers: {
        // Conformité anti-spam : désinscription en un clic (RFC 8058).
        "List-Unsubscribe": `<${unsubUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    });

    writeDatapoint(env, {
      status: "success",
      campaignId: job.campaignId,
      memberId: r.memberId,
      email: r.email,
      detail: result.messageId ?? "",
    });

    message.ack();
  } catch (err) {
    const status = classifyError(err);

    writeDatapoint(env, {
      status,
      campaignId: job.campaignId,
      memberId: r.memberId,
      email: r.email,
      detail: err instanceof Error ? err.message : String(err),
    });

    // Le log structuré remonte dans l'Observability.
    console.error("[sender] send failed", {
      campaignId: job.campaignId,
      memberId: r.memberId,
      status,
      error: err instanceof Error ? (err.stack ?? err.message) : String(err),
    });

    // Bounce permanent : inutile de réessayer. Sinon retry (puis DLQ après max_retries).
    if (status === "bounce") {
      message.ack();
    } else {
      message.retry();
    }
  }
}

// ---------------------------------------------------------------------------
// Envoi : wrapper fin autour du binding (substituable par un autre fournisseur).
// ---------------------------------------------------------------------------
async function sendEmail(env: SenderEnv, options: EmailSendOptions): Promise<EmailSendResult> {
  return env.EMAIL.send(options);
}

// ---------------------------------------------------------------------------
// Télémétrie
// ---------------------------------------------------------------------------
interface SendOutcome {
  status: SendStatus;
  campaignId: string;
  memberId: string;
  email: string;
  detail: string; // messageId en cas de succès, message d'erreur sinon
}

function writeDatapoint(env: SenderEnv, o: SendOutcome): void {
  env.ANALYTICS.writeDataPoint({
    // Clé d'échantillonnage (1 index max, <= 96 octets) : permet de filtrer par campagne.
    indexes: [o.campaignId],
    blobs: [o.campaignId, o.memberId, o.status, o.email, o.detail],
    doubles: [o.status === "success" ? 1 : 0, o.status === "success" ? 0 : 1],
  });
}

/** Classement grossier des erreurs d'envoi pour la télémétrie et la décision de retry. */
function classifyError(err: unknown): Exclude<SendStatus, "success"> {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (/invalid|no such user|mailbox|recipient|address|bounce|550|5\.1\.1/.test(msg)) return "bounce";
  if (/reject|spam|block|quota|rate/.test(msg)) return "dropped";
  return "error";
}

// ---------------------------------------------------------------------------
// KV : lecture du HTML mise en cache par lot
// ---------------------------------------------------------------------------
async function getCachedHtml(htmlKey: string, env: SenderEnv, cache: Map<string, string>): Promise<string> {
  const cached = cache.get(htmlKey);
  if (cached !== undefined) return cached;

  const stored = await env.HTML_CACHE.get(htmlKey);
  if (stored === null) {
    throw new Error(`HTML introuvable dans KV pour la clé ${htmlKey}`);
  }
  cache.set(htmlKey, stored);
  return stored;
}

// ---------------------------------------------------------------------------
// Helpers de présentation
// ---------------------------------------------------------------------------
const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

/** Version texte brut minimale pour le multipart (améliore la délivrabilité). */
function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<head[\s\S]*?<\/head>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function formatFrom(name: string | undefined, email: string): string {
  return name ? `${name} <${email}>` : email;
}
