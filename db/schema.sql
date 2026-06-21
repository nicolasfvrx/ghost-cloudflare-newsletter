-- Schéma d'initialisation D1 pour le système de newsletter.
-- Exécution : wrangler d1 execute newsletter --remote --file=./db/schema.sql
-- (utiliser --local pour la base de développement locale)

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Membres (synchronisés depuis les webhooks Ghost par le Worker "sync")
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS members (
  id                 TEXT PRIMARY KEY,                 -- uuid du membre Ghost
  email              TEXT NOT NULL UNIQUE,
  name               TEXT,
  status             TEXT NOT NULL DEFAULT 'free'
                       CHECK (status IN ('free', 'paid', 'comped')),
  subscribed         INTEGER NOT NULL DEFAULT 1
                       CHECK (subscribed IN (0, 1)),   -- 1 = abonné à la newsletter
  unsubscribe_token  TEXT NOT NULL UNIQUE,             -- jeton unique de désinscription
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Index partiel : la requête de fan-out ne sélectionne que les abonnés actifs.
CREATE INDEX IF NOT EXISTS idx_members_subscribed
  ON members (subscribed) WHERE subscribed = 1;

-- Recherche rapide lors d'une désinscription.
CREATE INDEX IF NOT EXISTS idx_members_token
  ON members (unsubscribe_token);

-- ---------------------------------------------------------------------------
-- Campagnes (une par post.published traité par le Worker "gateway")
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS campaigns (
  id            TEXT PRIMARY KEY,                       -- uuid de campagne (clé de corrélation Analytics)
  post_id       TEXT NOT NULL,
  title         TEXT NOT NULL,
  html_key      TEXT NOT NULL,                          -- clé KV du HTML mis en cache
  status        TEXT NOT NULL DEFAULT 'queued',
  recipients    INTEGER NOT NULL DEFAULT 0,
  images_count  INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_campaigns_post
  ON campaigns (post_id);
