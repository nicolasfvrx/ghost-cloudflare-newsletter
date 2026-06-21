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

# Clé Admin API Ghost, format "id:secret" (à définir pour le sync) :
cd apps/sync && wrangler secret put GHOST_ADMIN_API_KEY
```

## Synchronisation Ghost ↔ Cloudflare

Les webhooks (temps réel) sont complétés par une **réconciliation périodique** via l'API Ghost
Admin, pour rattraper les webhooks éventuellement manqués.

- **Réconciliation Ghost → D1** : le Worker `sync` tourne via cron (`apps/sync/wrangler.toml`,
  défaut `0 */6 * * *`). Il parcourt tous les membres Ghost, fait un `upsert` dans D1, puis
  **supprime les membres absents de Ghost** (webhook `member.deleted` manqué). Cette suppression a
  un garde-fou (jamais déclenchée si Ghost ne renvoie aucun membre) et peut être désactivée via
  la variable `RECONCILE_DELETE = "false"`. Déclenchement manuel possible : `POST /reconcile`.
- **Sync-back de désinscription Cloudflare → Ghost** : quand un membre clique « Se désinscrire »,
  `sync` met `subscribed = 0` dans D1 **et** propage la désinscription vers Ghost (source de
  vérité), sinon la réconciliation suivante le ré-abonnerait.
- Variables (`apps/sync/wrangler.toml`) : `GHOST_API_URL` (URL du blog Ghost), `GHOST_NEWSLETTER_ID`
  (optionnel, pour cibler une newsletter précise), `RECONCILE_DELETE` (optionnel).

### Côté Ghost

Dans **Ghost Admin → Settings → Integrations → Add custom integration** :
1. Récupérer l'**Admin API Key** (format `id:secret`) → secret `GHOST_ADMIN_API_KEY` du `sync`.
2. Renseigner l'URL du blog dans `GHOST_API_URL`.
3. Désactiver l'envoi natif des newsletters par Ghost (Mailgun) pour éviter les doublons : la
   diffusion est désormais assurée par les Workers.

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
