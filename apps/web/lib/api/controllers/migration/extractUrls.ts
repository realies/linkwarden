/**
 * Pull URLs out of an arbitrary block of text pasted by the user.
 *
 * Accepts newline-separated, comma-separated, and space-separated lists, plus
 * lines that contain a URL embedded in surrounding text. Strips markdown /
 * HTML / quote wrappers around tokens, normalises bare `www.` hosts to
 * `https://`, skips non-http(s) schemes, and de-duplicates across the whole
 * input.
 *
 * This module is kept dependency-free (no Prisma, no FS) so it can be
 * unit-tested in isolation without a live database.
 */

/**
 * Try to parse a candidate string as an http(s) URL, optionally prepending
 * `https://` for bare `www.` hosts. Returns the normalised URL string on
 * success, or `null` if the candidate is not a valid http(s) URL.
 *
 * FQDN trailing dots (e.g. `foo.test.`) are stripped from the hostname so
 * that sentence-ending periods aren't misinterpreted as part of the host.
 */
function tryParseHttpUrl(candidate: string): string | null {
  let c = candidate;
  if (/^www\./i.test(c)) c = `https://${c}`;
  try {
    const parsed = new URL(c);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    // Normalise FQDN trailing dot — "foo.test." → "foo.test" — so that
    // a sentence-ending period in "visit https://foo.test." doesn't get
    // preserved as part of the hostname.
    if (parsed.hostname.endsWith(".")) {
      parsed.hostname = parsed.hostname.slice(0, -1);
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

export function extractUrlsFromText(raw: string): string[] {
  if (!raw) return [];

  const seen = new Set<string>();
  const out: string[] = [];

  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    // Split on whitespace only. Commas and semicolons are legal URL
    // characters (query-string value separators, matrix parameters,
    // coordinate pairs like `?q=48.85,2.35`) so treating them as token
    // delimiters silently truncates valid URLs. Users wanting
    // "CSV-style" paste can use newlines; single-line `url1, url2`
    // still works because the trailing comma gets stripped by the
    // wrapper-punctuation fallback below.
    const tokens = line.split(/\s+/);
    for (const rawToken of tokens) {
      if (!rawToken.trim()) continue;

      // Strip trailing `,` and `;` before the raw parse. Inside a URL
      // these are legal (query value separators, matrix params,
      // coordinate pairs) but at the end of a token they're almost
      // always CSV-paste separators the user left attached — e.g.
      // `"https://a.example.com,"` in `"url1, url2"` paste. Stripping
      // here is the only place we touch these characters; middle
      // occurrences survive because `line.split(/\s+/)` never breaks
      // on them.
      const deTrailedToken = rawToken.trim().replace(/[,;]+$/, "");
      if (!deTrailedToken) continue;

      // Try the raw (de-trailed) token first so that URLs with
      // legitimate internal punctuation (Wikipedia paths with
      // parentheses, query strings with commas, matrix params with
      // semicolons) are preserved.
      let normalized = tryParseHttpUrl(deTrailedToken);

      // If the raw token didn't parse, strip markdown / HTML / quote
      // wrappers and retry. This handles inputs like `<https://example.com>`
      // or `(https://github.com)` where the punctuation is wrapping syntax
      // rather than part of the URL path.
      if (normalized === null) {
        const stripped = rawToken
          .replace(/^[<("'\[]+|[>)"'\].,;:!?]+$/g, "")
          .trim();
        if (!stripped) continue;
        normalized = tryParseHttpUrl(stripped);
        if (normalized === null) continue;
      }

      if (seen.has(normalized)) continue;
      seen.add(normalized);
      out.push(normalized);
    }
  }

  return out;
}
