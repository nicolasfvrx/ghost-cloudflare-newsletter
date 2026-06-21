// Type du message d'envoi transitant par Cloudflare Queues
// (produit par "gateway", consommé par "sender").

export interface SendRecipient {
  /** uuid du membre Ghost (utilisé comme dimension dans Analytics Engine). */
  memberId: string;
  email: string;
  name: string | null;
  unsubscribeToken: string;
}

export interface NewsletterSendJob {
  campaignId: string;
  postId: string;
  subject: string;
  /** Clé KV du HTML pré-rendu et mis en cache. */
  htmlKey: string;
  recipient: SendRecipient;
}
