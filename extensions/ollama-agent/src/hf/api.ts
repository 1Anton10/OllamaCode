export interface HfModelHit {
  id: string;
  author: string;
  name: string;
  downloads: number;
  likes: number;
  tags: string[];
  pipeline_tag?: string;
  lastModified?: string;
}

export type HfSort = "downloads" | "likes" | "trending" | "created" | "modified";

export interface HfSearchOptions {
  query?: string;
  author?: string;
  sort?: HfSort;
  limit?: number;
  filter?: string;
}

function authorOf(id: string): string {
  const i = id.indexOf("/");
  return i > 0 ? id.slice(0, i) : id;
}

function nameOf(id: string): string {
  const i = id.indexOf("/");
  return i > 0 ? id.slice(i + 1) : id;
}

export async function searchHfModels(opts: HfSearchOptions = {}): Promise<HfModelHit[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
  const sort = opts.sort || "downloads";
  const params = new URLSearchParams();
  params.set("filter", opts.filter || "gguf");
  params.set("sort", sort);
  params.set("limit", String(limit));
  params.set("full", "true");
  if (opts.query?.trim()) params.set("search", opts.query.trim());
  if (opts.author?.trim()) params.set("author", opts.author.trim());

  const url = `https://huggingface.co/api/models?${params.toString()}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "OllamaCode/0.5" },
  });
  if (!res.ok) throw new Error(`HF search failed: ${res.status}`);
  const data = (await res.json()) as any[];
  return (data || []).map((m) => {
    const id = String(m.id || m.modelId || "");
    return {
      id,
      author: authorOf(id),
      name: nameOf(id),
      downloads: Number(m.downloads || 0),
      likes: Number(m.likes || 0),
      tags: Array.isArray(m.tags) ? m.tags : [],
      pipeline_tag: m.pipeline_tag,
      lastModified: m.lastModified,
    };
  });
}

/** Popular GGUF publishers for dropdown shortcuts. */
export const POPULAR_AUTHORS = [
  "bartowski",
  "unsloth",
  "lmstudio-community",
  "TheBloke",
  "QuantFactory",
  "huihui-ai",
  "Qwen",
  "mlx-community",
  "ggml-org",
  "MaziyarPanahi",
  "mradermacher",
  "cognitivecomputations",
  "NousResearch",
  "second-state",
];

export function authorsFromHits(hits: HfModelHit[]): string[] {
  const map = new Map<string, number>();
  for (const h of hits) {
    map.set(h.author, (map.get(h.author) || 0) + (h.downloads || 0));
  }
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([a]) => a);
}

export async function listHfGgufFiles(repoId: string): Promise<string[]> {
  const url = `https://huggingface.co/api/models/${encodeURIComponent(repoId)}/tree/main?recursive=true`;
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "OllamaCode/0.5" },
  });
  if (!res.ok) throw new Error(`HF tree failed: ${res.status}`);
  const data = (await res.json()) as Array<{ path?: string; type?: string }>;
  return (data || [])
    .map((x) => x.path || "")
    .filter((p) => p.toLowerCase().endsWith(".gguf") && !p.toLowerCase().includes("mmproj"));
}

export function rankQuants(files: string[]): string[] {
  return [...files].sort((a, b) => {
    const score = (p: string) => {
      const n = p.toUpperCase();
      if (n.includes("Q4_K_M")) return 0;
      if (n.includes("Q5_K_M")) return 1;
      if (n.includes("Q4_K_S")) return 2;
      if (n.includes("Q6_K")) return 3;
      if (n.includes("Q3_K_M")) return 4;
      if (n.includes("Q8_0")) return 5;
      return 10;
    };
    return score(a) - score(b);
  });
}

export function quantFromFilename(file: string): string {
  const base = file.split(/[\\/]/).pop()!.replace(/\.gguf$/i, "");
  const m = base.match(/(UD-)?(IQ|Q)\d[^-\s]*([-_][A-Z0-9]+)?/i);
  return m ? m[0] : "Q4_K_M";
}
