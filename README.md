# Newsletter serverless sur Cloudflare (remplacement de Mailgun pour Ghost)

Monorepo pnpm de trois Cloudflare Workers qui remplacent Mailgun pour l'envoi des newsletters
d'un blog Ghost, en s'appuyant uniquement sur l'écosystème Cloudflare (D1, KV, Queues, R2,
Image Resizing, Analytics Engine, Email Sending, Observability).

## Architecture

```
Ghost ──webhooks──▶ gateway ──member.*──▶ sync ──▶ D1 (membres)
                       │
                       │ post.published
                       ├─ optimise les images (cf.image) ──▶ R2 (CDN public)
                       ├─ réécrit le HTML, le met en cache ──▶ KV
                       ├─ sélectionne les abonnés ─────────── D1
                       ├─ fan-out (1 message/membre) ───────▶ Queue ──▶ sender
                       └─ datapoint « newsletter_processed » ▶ Analytics Engine

sender ◀── Queue ── récupère le HTML (KV), injecte le lien de désinscription,
                    envoie via Email Sending (env.EMAIL.send),
                    écrit un datapoint par envoi ──▶ Analytics Engine
```

| Worker    | Rôle                                                         |
|-----------|--------------------------------------------------------------|
| `gateway` | Routeur public + processeur de contenu (images, HTML, queue) |
| `sync`    | Propriétaire de D1 (membres, tokens, désinscription)         |
| `sender`  | Consumer de queue, envoi des emails, télémétrie              |

## Prérequis

- **Node 22+** (requis par Wrangler 4.x), pnpm 10+
- `wrangler` (fourni en devDependency) et un compte Cloudflare **payant** (Email Sending est en
  bêta publique, offre payante uniquement).
- `wrangler login`

## Installation

```bash
pnpm install
```

## Création des ressources Cloudflare

Reporter les identifiants renvoyés dans les `wrangler.toml` correspondants
(placeholders `REMPLACER_PAR_ID_*`).

```bash
wrangler d1 create newsletter            # -> database_id (gateway + sync, même id)
wrangler kv namespace create HTML_CACHE  # -> id (gateway + sender, même id)
wrangler r2 bucket create newsletter-media
wrangler queues create newsletter-send
wrangler queues create newsletter-send-dlq
```

- **R2 → domaine public** : attacher un domaine personnalisé au bucket `newsletter-media`
  (ex. `cdn-newsletter.mondomaine.com`) puis renseigner `CDN_BASE_URL` dans
  `apps/gateway/wrangler.toml`.
- **Email Sending** : ajouter le domaine d'envoi dans le dashboard Cloudflare Email Service
  (SPF/DKIM/DMARC configurés automatiquement) ; ajuster `FROM_EMAIL` / `FROM_NAME` dans
  `apps/sender/wrangler.toml`.
- **Image Resizing** : activer les transformations d'images sur la zone servant les images
  d'origine (requis pour que les options `cf.image` prennent effet).

## Initialisation de la base D1

```bash
pnpm db:init          # base distante (production)
pnpm db:init:local    # base locale (développement)
```

## Secrets

```bash
# Secret de signature des webhooks Ghost (à définir pour le gateway) :
cd apps/gateway && wrangler secret put GHOST_WEBHOOK_SECRET
```

## Vérification des types

```bash
pnpm typecheck
```

## Déploiement

L'ordre importe : `sync` d'abord (le service binding du `gateway` doit pouvoir le résoudre).

```bash
pnpm deploy
# équivaut à :
#   pnpm --filter @newsletter/sync deploy
#   pnpm --filter @newsletter/sender deploy
#   pnpm --filter @newsletter/gateway deploy
```

## Configuration des webhooks Ghost

Dans **Ghost Admin → Settings → Integrations → Custom integration → Webhooks**, créer :

| Événement         | URL cible                                            |
|-------------------|------------------------------------------------------|
| `post.published`  | `https://<gateway>/webhooks/post/published`          |
| `member.added`    | `https://<gateway>/webhooks/member/added`            |
| `member.edited`   | `https://<gateway>/webhooks/member/updated`          |
| `member.deleted`  | `https://<gateway>/webhooks/member/deleted`          |

(Le secret du webhook doit correspondre à `GHOST_WEBHOOK_SECRET`.)

## Observabilité & métriques

- **Logs / traces** : `[observability]` est activé sur chaque Worker ; consultables dans le
  dashboard Workers (ou `pnpm --filter @newsletter/<app> tail`).
- **Analytics Engine** : dataset `newsletter_events`.
  - `newsletter_processed` (gateway) : `blobs = [type, campaignId, postId, visibility]`,
    `doubles = [imagesProcessed, recipients, imagesTotal]`.
  - envoi (sender) : `blobs = [campaignId, memberId, status, email, detail]`,
    `doubles = [delivered, failed]`, `index = campaignId`.
  - Interrogeable via l'API GraphQL Analytics ou un dashboard Cloudflare.

## Notes

- **Optimisation d'images** : réalisée via les options `cf.image` de `fetch` (JPEG, largeur
  `EMAIL_IMAGE_WIDTH`, `quality 82`). Le binding `env.IMAGES` est une alternative (commentée dans
  `apps/gateway/wrangler.toml`) qui opère sur les octets bruts.
- **HTML** : parsing et réécriture via `HTMLRewriter` (natif, en flux). Les marqueurs
  `%%UNSUBSCRIBE_URL%%` et `%%NAME%%` sont remplacés par destinataire dans le `sender`.
- **Reprise sur erreur** : le `sender` distingue bounces permanents (ack) et erreurs transitoires
  (retry → DLQ `newsletter-send-dlq`).
```
