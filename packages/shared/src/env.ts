// Interfaces des environnements (bindings + variables) de chaque Worker.
// Les types Cloudflare (D1Database, KVNamespace, ...) proviennent de @cloudflare/workers-types.

import type { NewsletterSendJob } from "./queue";

// ---------------------------------------------------------------------------
// Binding Cloudflare Email Sending (Email Service, bêta publique — avril 2026).
// API objet : env.EMAIL.send({ to, from, subject, html, text, headers }) -> { messageId }
// Typé localement car ce binding n'est pas encore couvert par workers-types.
// ---------------------------------------------------------------------------
export interface EmailSendOptions {
  to: string | string[];
  from: string;
  subject: string;
  html?: string;
  text?: string;
  cc?: string | string[];
  bcc?: string | string[];
  replyTo?: string;
  headers?: Record<string, string>;
}

export interface EmailSendResult {
  messageId?: string;
}

export interface EmailSendingBinding {
  send(options: EmailSendOptions): Promise<EmailSendResult>;
}

// ---------------------------------------------------------------------------
// Worker "gateway" : routeur public + processeur de contenu.
// ---------------------------------------------------------------------------
export interface GatewayEnv {
  // Bindings
  DB: D1Database;
  HTML_CACHE: KVNamespace;
  MEDIA: R2Bucket;
  SEND_QUEUE: Queue<NewsletterSendJob>;
  ANALYTICS: AnalyticsEngineDataset;
  SYNC: Fetcher; // service binding vers le Worker "sync"

  // Variables
  CDN_BASE_URL: string; // ex: https://cdn-newsletter.mondomaine.com
  FROM_NAME: string;
  EMAIL_IMAGE_WIDTH: string; // largeur cible (px) pour l'optimisation des images

  // Secret
  GHOST_WEBHOOK_SECRET?: string;
}

// ---------------------------------------------------------------------------
// Worker "sync" : gestion de la base D1.
// ---------------------------------------------------------------------------
export interface SyncEnv {
  DB: D1Database;
}

// ---------------------------------------------------------------------------
// Worker "sender" : consumer de queue + envoi + télémétrie.
// ---------------------------------------------------------------------------
export interface SenderEnv {
  // Bindings
  HTML_CACHE: KVNamespace;
  ANALYTICS: AnalyticsEngineDataset;
  EMAIL: EmailSendingBinding;

  // Variables
  FROM_EMAIL: string;
  FROM_NAME: string;
  UNSUBSCRIBE_BASE_URL: string; // base publique du lien de désinscription
}
