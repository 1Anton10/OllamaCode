import { MarketplaceItem, FitStatus } from "./types";

/** Score how well a catalog item fits the active chat model name. */
export function scoreForModel(model: string, tags: string[]): number {
  const modelTags = inferModelTags(model);
  let score = 0;
  for (const t of tags) {
    const tag = t.toLowerCase();
    if (modelTags.includes(tag)) score += 25;
    else if (tag === "general") score += 3;
  }
  return score;
}

export function inferModelTags(model: string): string[] {
  const m = model.toLowerCase();
  const tags = new Set<string>(["general", "agent"]);
  if (/qwen|agent35/.test(m)) {
    tags.add("qwen");
    tags.add("qwen3");
    tags.add("thinking");
    tags.add("tools");
  }
  if (/coder|code|dev/.test(m)) tags.add("coder");
  if (/vision|vl|llava/.test(m)) tags.add("vision");
  if (/r1|reason/.test(m) && !/qwen/.test(m)) tags.add("research");
  if (/abliterat|uncensor|dolphin|hermes/.test(m)) tags.add("uncensored");
  if (/\b(1b|3b|4b|7b|8b)\b/.test(m) && !/14b|32b|35b|70b/.test(m)) tags.add("small");
  return [...tags];
}

export function evaluateFit(
  item: MarketplaceItem,
  model: string
): { status: FitStatus; score: number; reason: string } {
  const modelTags = inferModelTags(model);
  const fit = item.fit || (item.kind === "link" ? "external" : "optional");

  if (fit === "external" || item.kind === "link") {
    return { status: "external", score: 0, reason: "внешняя ссылка / BYOK — не для локальной модели" };
  }

  const excluded = (item.excludeIfTags || []).filter((t) => modelTags.includes(t.toLowerCase()));
  if (excluded.length) {
    return {
      status: "conflict",
      score: -100,
      reason: `мешает модели (${excluded.join(", ")})`,
    };
  }

  if (item.needsEnv?.length) {
    const missing = item.needsEnv.filter((k) => !process.env[k]);
    if (missing.length) {
      return {
        status: "needs-env",
        score: scoreForModel(model, item.modelTags) - 20,
        reason: `нужен env: ${missing.join(", ")}`,
      };
    }
  }

  const overlap = item.modelTags.filter((t) => modelTags.includes(t.toLowerCase()));
  const min = item.minTagOverlap ?? (fit === "required" || fit === "recommended" ? 1 : 0);
  // "general" alone is weak — require another tag for recommended/required unless defaultInstall
  const strong = overlap.filter((t) => t !== "general");
  if (fit === "required" || fit === "recommended") {
    if (strong.length < Math.max(1, min) && !item.defaultInstall) {
      return {
        status: "conflict",
        score: -50,
        reason: "не подходит семейству текущей модели",
      };
    }
  }

  const score = scoreForModel(model, item.modelTags) + (item.defaultInstall ? 40 : 0) + (fit === "required" ? 50 : 0);
  return {
    status: "compatible",
    score,
    reason: strong.length ? `подходит: ${strong.join(", ")}` : "базовый для агента",
  };
}

export function isSafeForModel(item: MarketplaceItem, model: string): boolean {
  const { status } = evaluateFit(item, model);
  return status === "compatible";
}
