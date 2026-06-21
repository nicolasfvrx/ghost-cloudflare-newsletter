// Types des payloads de webhooks Ghost.
// Ghost enveloppe chaque ressource dans un objet { current, previous }.

export type GhostMemberStatus = "free" | "paid" | "comped";

export interface GhostMember {
  id: string;
  uuid: string;
  email: string;
  name: string | null;
  status?: GhostMemberStatus;
  /** true si le membre est abonné à la newsletter. */
  subscribed?: boolean;
  newsletters?: Array<{ id: string; name: string; status: string }>;
  created_at?: string;
  updated_at?: string;
}

export interface GhostPost {
  id: string;
  uuid: string;
  title: string;
  html: string;
  url: string;
  excerpt?: string;
  feature_image?: string | null;
  /** "public" | "members" | "paid" | "tiers" ... */
  visibility?: string;
  published_at?: string;
}

/** Payload du webhook `post.published`. */
export interface GhostPostPayload {
  post: {
    current: GhostPost;
    previous?: Partial<GhostPost>;
  };
}

/** Payload des webhooks `member.added` / `member.edited` / `member.deleted`. */
export interface GhostMemberPayload {
  member: {
    current?: GhostMember;
    /** Renseigné notamment lors d'une suppression. */
    previous?: Partial<GhostMember> & { email?: string };
  };
}
