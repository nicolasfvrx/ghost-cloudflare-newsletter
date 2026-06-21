// Parsing et réécriture du HTML via HTMLRewriter (parseur en flux natif aux Workers).

/**
 * Passe A : collecte les attributs `src` de toutes les balises <img>.
 * On consomme entièrement le flux transformé pour déclencher les handlers.
 */
export async function extractImageSrcs(html: string): Promise<string[]> {
  const srcs = new Set<string>();
  const rewriter = new HTMLRewriter().on("img", {
    element(el) {
      const src = el.getAttribute("src");
      if (src) srcs.add(src);
    },
  });
  await rewriter.transform(new Response(html)).arrayBuffer();
  return [...srcs];
}

/**
 * Passe B : réécrit chaque `src` connu vers son URL CDN R2 et retire `srcset`
 * (qui pointerait sinon vers les originaux haute résolution).
 */
export async function rewriteImageSrcs(html: string, mapping: Map<string, string>): Promise<string> {
  if (mapping.size === 0) return html;
  const rewriter = new HTMLRewriter().on("img", {
    element(el) {
      const src = el.getAttribute("src");
      const next = src ? mapping.get(src) : undefined;
      if (next) {
        el.setAttribute("src", next);
        el.removeAttribute("srcset");
      }
    },
  });
  return rewriter.transform(new Response(html)).text();
}

// ---------------------------------------------------------------------------
// Gabarit email
// ---------------------------------------------------------------------------
export interface RenderEmailInput {
  title: string;
  contentHtml: string;
  postUrl?: string;
  fromName: string;
}

/**
 * Enveloppe le contenu de l'article dans une coquille email responsive
 * (table-based, compatible clients mail). Les marqueurs `%%UNSUBSCRIBE_URL%%`
 * et `%%NAME%%` sont remplacés par destinataire dans le Worker "sender".
 */
export function renderEmail({ title, contentHtml, postUrl, fromName }: RenderEmailInput): string {
  const safeTitle = escapeHtml(title);
  const safeFrom = escapeHtml(fromName);
  const year = new Date().getFullYear();
  const readLink = postUrl
    ? `<p style="margin:0 0 8px;"><a href="${escapeAttr(postUrl)}" style="color:#2563eb;">Lire sur le site</a></p>`
    : "";

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="light dark">
<title>${safeTitle}</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;">
    <tr>
      <td align="center" style="padding:24px 12px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:8px;overflow:hidden;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
          <tr>
            <td style="padding:32px 40px 8px;">
              <h1 style="margin:0;font-size:24px;line-height:1.3;color:#18181b;">${safeTitle}</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 40px 32px;font-size:16px;line-height:1.6;color:#27272a;">
              ${contentHtml}
            </td>
          </tr>
          <tr>
            <td style="padding:24px 40px;border-top:1px solid #e4e4e7;font-size:12px;line-height:1.6;color:#71717a;">
              <p style="margin:0 0 8px;">Bonjour %%NAME%%, vous recevez cet email car vous êtes abonné·e à ${safeFrom}.</p>
              ${readLink}
              <p style="margin:0;"><a href="%%UNSUBSCRIBE_URL%%" style="color:#71717a;text-decoration:underline;">Se désinscrire</a> &middot; &copy; ${year} ${safeFrom}</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

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

function escapeAttr(input: string): string {
  return input.replace(/"/g, "&quot;");
}
