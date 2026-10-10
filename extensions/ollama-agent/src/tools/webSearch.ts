/**
 * Local web_search (Astra WebSearch gap). No Cursor/API keys.
 * Uses DuckDuckGo HTML results; falls back to Instant Answer JSON.
 */

export type WebSearchHit = {
  title: string;
  url: string;
  snippet: string;
};

function decodeHtml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function unwrapDdgRedirect(href: string): string {
  try {
    const u = new URL(href, "https://duckduckgo.com");
    const uddg = u.searchParams.get("uddg");
    if (uddg) return decodeURIComponent(uddg);
    return u.toString();
  } catch {
    return href;
  }
}

export function parseDdgHtml(html: string, max: number): WebSearchHit[] {
  const hits: WebSearchHit[] = [];
  // Classic DDG HTML: result__a + result__snippet
  const blockRe =
    /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|td|div)> )?/gi;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(html)) && hits.length < max) {
    const url = unwrapDdgRedirect(decodeHtml(m[1]));
    const title = decodeHtml(m[2].replace(/<[^>]+>/g, "")).trim();
    const snippet = decodeHtml((m[3] || "").replace(/<[^>]+>/g, "")).trim();
    if (!url || !title || /^https?:\/\/duckduckgo\.com/i.test(url)) continue;
    hits.push({ title, url, snippet });
  }
  if (hits.length) return hits;

  // Lite / alternate markup: links with uddg=
  const liteRe =
    /<a[^>]*href="(https?:\/\/duckduckgo\.com\/l\/[^"]+|\/\/duckduckgo\.com\/l\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  while ((m = liteRe.exec(html)) && hits.length < max) {
    const url = unwrapDdgRedirect(decodeHtml(m[1].startsWith("//") ? `https:${m[1]}` : m[1]));
    const title = decodeHtml(m[2].replace(/<[^>]+>/g, "")).trim();
    if (!url || !title) continue;
    hits.push({ title, url, snippet: "" });
  }
  return hits;
}

async function fetchText(url: string, timeoutMs = 12_000): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/json,*/*",
      },
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

async function ddgInstantAnswer(query: string, max: number): Promise<WebSearchHit[]> {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
  const raw = await fetchText(url);
  let data: {
    AbstractText?: string;
    AbstractURL?: string;
    Heading?: string;
    RelatedTopics?: Array<{ Text?: string; FirstURL?: string; Topics?: Array<{ Text?: string; FirstURL?: string }> }>;
    Results?: Array<{ Text?: string; FirstURL?: string }>;
  };
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  const hits: WebSearchHit[] = [];
  if (data.AbstractText && data.AbstractURL) {
    hits.push({
      title: data.Heading || data.AbstractURL,
      url: data.AbstractURL,
      snippet: data.AbstractText,
    });
  }
  const push = (text?: string, link?: string) => {
    if (!text || !link || hits.length >= max) return;
    const title = text.split(" - ")[0]?.trim() || text.slice(0, 80);
    hits.push({ title, url: link, snippet: text });
  };
  for (const r of data.Results || []) push(r.Text, r.FirstURL);
  for (const t of data.RelatedTopics || []) {
    if (t.FirstURL) push(t.Text, t.FirstURL);
    for (const sub of t.Topics || []) push(sub.Text, sub.FirstURL);
  }
  return hits.slice(0, max);
}

export async function runWebSearch(
  query: string,
  maxResults = 5
): Promise<{ ok: true; hits: WebSearchHit[]; source: string } | { ok: false; error: string }> {
  const q = String(query || "").trim();
  if (!q) return { ok: false, error: "empty query — pass query or search_term" };
  const max = Math.min(10, Math.max(1, Number(maxResults) || 5));

  try {
    const html = await fetchText(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`
    );
    const hits = parseDdgHtml(html, max);
    if (hits.length) return { ok: true, hits, source: "duckduckgo_html" };
  } catch {
    /* fall through */
  }

  try {
    const hits = await ddgInstantAnswer(q, max);
    if (hits.length) return { ok: true, hits, source: "duckduckgo_instant" };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }

  return { ok: false, error: "no search results (network blocked or empty)" };
}

export function formatWebSearchHits(hits: WebSearchHit[], source: string): string {
  if (!hits.length) return `(no results) source=${source}`;
  return (
    hits
      .map(
        (h, i) =>
          `${i + 1}. ${h.title}\n   ${h.url}${h.snippet ? `\n   ${h.snippet}` : ""}`
      )
      .join("\n\n") + `\n\n--- source: ${source}; use native fetch/browser to read a URL ---`
  );
}
