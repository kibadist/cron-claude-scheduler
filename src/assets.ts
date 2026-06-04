import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TicketInfo } from './types.js';

/** Fetches a private Linear upload; resolves null on any failure. */
export type ImageDownloader = (url: string) => Promise<Buffer | null>;

const IMAGE_MD = /!\[[^\]]*\]\((https:\/\/uploads\.linear\.app\/[^)\s]+)\)/g;

/** Linear-hosted images embedded in markdown (`![alt](https://uploads.linear.app/...)`). */
export function extractImageUrls(markdown: string): string[] {
  return [...markdown.matchAll(IMAGE_MD)].map((m) => m[1]);
}

export interface PreparedAssets {
  /** the ticket with image URLs rewritten to local file paths */
  ticket: TicketInfo;
  /** absolute paths of the downloaded images, in ticket order */
  imagePaths: string[];
}

/**
 * Download the ticket's embedded images (description + comments) into
 * assetsDir and rewrite their URLs to the local paths, so a multimodal agent
 * can actually look at them with the Read tool. Images that fail to download
 * are left as URLs; a ticket without images passes through untouched.
 */
export async function prepareTicketAssets(
  ticket: TicketInfo,
  assetsDir: string,
  download: ImageDownloader,
): Promise<PreparedAssets> {
  const texts = [ticket.description, ...ticket.comments.map((c) => c.body)];
  const urls = [...new Set(texts.flatMap((t) => extractImageUrls(t)))];
  if (urls.length === 0) return { ticket, imagePaths: [] };

  mkdirSync(assetsDir, { recursive: true });
  const replacements = new Map<string, string>();
  const imagePaths: string[] = [];
  for (const [i, url] of urls.entries()) {
    const data = await download(url);
    if (!data) continue;
    const file = join(assetsDir, `image-${i + 1}${extensionFor(url)}`);
    writeFileSync(file, data);
    replacements.set(url, file);
    imagePaths.push(file);
  }
  if (imagePaths.length === 0) return { ticket, imagePaths: [] };

  const rewrite = (text: string): string => {
    let out = text;
    for (const [url, file] of replacements) out = out.replaceAll(url, file);
    return out;
  };
  return {
    ticket: {
      ...ticket,
      description: rewrite(ticket.description),
      comments: ticket.comments.map((c) => ({ ...c, body: rewrite(c.body) })),
    },
    imagePaths,
  };
}

function extensionFor(url: string): string {
  try {
    const match = new URL(url).pathname.match(/\.(png|jpe?g|gif|webp)$/i);
    return match ? match[0].toLowerCase() : '.png';
  } catch {
    return '.png';
  }
}
