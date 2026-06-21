import type { GatewayEnv } from "@newsletter/shared";

export interface OptimizeResult {
  /** URL d'origine -> URL CDN R2. */
  mapping: Map<string, string>;
  /** Nombre d'images effectivement optimisées et stockées. */
  processed: number;
}

const DEFAULT_WIDTH = 1200;

/**
 * Optimise puis stocke dans R2 chaque image, en parallèle.
 * Une image qui échoue est journalisée et conserve son URL d'origine
 * (pas d'entrée dans le mapping -> pas de réécriture).
 */
export async function optimizeAndStore(
  srcs: string[],
  env: GatewayEnv,
  campaignId: string,
): Promise<OptimizeResult> {
  const mapping = new Map<string, string>();
  const width = Number(env.EMAIL_IMAGE_WIDTH) || DEFAULT_WIDTH;
  const cdnBase = env.CDN_BASE_URL.replace(/\/$/, "");

  const settled = await Promise.allSettled(
    srcs.map(async (src) => {
      const cdnUrl = await optimizeOne(src, env, campaignId, width, cdnBase);
      mapping.set(src, cdnUrl);
    }),
  );

  settled.forEach((res, i) => {
    if (res.status === "rejected") {
      console.error("[gateway] image optimization failed", {
        src: srcs[i],
        reason: String(res.reason),
      });
    }
  });

  return { mapping, processed: mapping.size };
}

async function optimizeOne(
  originalUrl: string,
  env: GatewayEnv,
  campaignId: string,
  width: number,
  cdnBase: string,
): Promise<string> {
  // Optimisation à la volée via les options `cf.image` de fetch (Cloudflare Image Resizing).
  // Alternative possible : le binding `env.IMAGES` (Images API), qui opère sur les octets bruts.
  // JPEG retenu : format le plus largement supporté par les clients mail (WebP/AVIF mal gérés).
  const resized = await fetch(originalUrl, {
    cf: {
      image: {
        width,
        quality: 82,
        fit: "scale-down",
        format: "jpeg",
      },
    },
  });

  if (!resized.ok) {
    throw new Error(`resize HTTP ${resized.status} pour ${originalUrl}`);
  }

  const contentType = resized.headers.get("content-type") ?? "image/jpeg";
  const ext = extFromContentType(contentType);
  // Clé dérivée du hash de l'URL d'origine -> déduplication + cache immuable.
  const key = `${campaignId}/${await sha1(originalUrl)}.${ext}`;

  await env.MEDIA.put(key, await resized.arrayBuffer(), {
    httpMetadata: {
      contentType,
      cacheControl: "public, max-age=31536000, immutable",
    },
  });

  return `${cdnBase}/${key}`;
}

function extFromContentType(ct: string): string {
  if (ct.includes("png")) return "png";
  if (ct.includes("webp")) return "webp";
  if (ct.includes("gif")) return "gif";
  if (ct.includes("svg")) return "svg";
  return "jpg";
}

async function sha1(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(input));
  let out = "";
  for (const b of new Uint8Array(digest)) out += b.toString(16).padStart(2, "0");
  return out;
}
