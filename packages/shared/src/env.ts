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
// Worker "sync" : gestion de la base D1 + réconciliation via l'API Ghost Admin.
// ---------------------------------------------------------------------------
export interface SyncEnv {
  // Binding
  DB: D1Database;

  // API Ghost Admin (réconciliation + sync-back de désinscription)
  GHOST_API_URL: string; // ex: https://nortek.wtf
  GHOST_ADMIN_API_KEY: string; // secret, format "id:secret"

  // Optionnel : cibler une newsletter précise (sinon « abonné » = au moins une newsletter)
  GHOST_NEWSLETTER_ID?: string;
  // Optionnel : "false" pour désactiver la suppression des membres absents de Ghost
  RECONCILE_DELETE?: string;
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
