/**
 * Remote images in generated HTML. The model may only show images whose URLs
 * it actually saw (evidence or the person's own messages). The sanitizer
 * removes every other http(s) URL from the document, and the frame's CSP then
 * allows exactly the URLs that remain, so script-built URLs can't load either.
 */

const URL_RE = /\bhttps?:\/\/[^\s"'<>()\\`]+/gi;
const TRAILING = /[.,;:!?]+$/;
const MAX_IMAGES = 30;

export type SanitizedHtml = { html: string; images: string[] };

/** Strip unknown remote URLs; return the document and the remote URLs it may load. */
export function sanitizeGeneratedHtml(html: string, isKnown: (url: string) => boolean): SanitizedHtml {
  // srcset holds several candidates; keep the known ones, drop the rest whole.
  let out = html.replace(/\bsrcset\s*=\s*(["'])([\s\S]*?)\1/gi, (_m, q: string, value: string) => {
    const kept = value
      .split(",")
      .map((c) => c.trim())
      .filter((c) => {
        const url = c.split(/\s+/)[0] ?? "";
        if (/^https?:\/\//i.test(url)) return isKnown(url);
        return url !== "" && !url.startsWith("//");
      });
    return `srcset=${q}${kept.join(", ")}${q}`;
  });

  // Every other remote URL, in any context (attributes, CSS url(), image-set, script strings).
  out = out.replace(URL_RE, (match) => {
    const tail = match.match(TRAILING)?.[0] ?? "";
    const url = tail ? match.slice(0, -tail.length) : match;
    return isKnown(url) ? match : tail;
  });

  // Protocol-relative URLs resolve against the app's origin; never keep them.
  out = out.replace(/(["'(]\s*)\/\/[^\s"'<>()\\`]+/g, "$1");

  // Images left without a source would render as broken icons.
  out = out.replace(/<img\b[^>]*?\bsrc\s*=\s*(["'])\s*\1[^>]*>/gi, "");

  const images = [...new Set((out.match(URL_RE) ?? []).map((u) => u.replace(TRAILING, "")))]
    .map(cspSource)
    .filter((s): s is string => s !== null)
    .slice(0, MAX_IMAGES);
  return { html: out, images };
}

/**
 * A CSP source matching exactly this URL's https origin and path (CSP ignores
 * the query). Null for anything that isn't a clean https URL.
 */
export function cspSource(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" || u.username || u.password) return null;
    const source = `${u.origin}${u.pathname}`;
    return /[\s;,'"]/.test(source) ? null : source;
  } catch {
    return null;
  }
}

/** A matcher over text the person or the evidence actually contained. */
export function knownIn(corpus: string): (url: string) => boolean {
  return (url) => url.length > 10 && corpus.includes(url);
}
