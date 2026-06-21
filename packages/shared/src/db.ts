// Représentation d'une ligne de la table `members` (D1).

import type { GhostMemberStatus } from "./ghost";

export interface MemberRow {
  id: string;
  email: string;
  name: string | null;
  status: GhostMemberStatus;
  subscribed: number; // 0 | 1
  unsubscribe_token: string;
  created_at: string;
  updated_at: string;
}
