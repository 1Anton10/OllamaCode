import * as fs from "fs";
import * as path from "path";
import { MarketplaceCatalog, MarketplaceItem } from "./types";
import { evaluateFit } from "./modelMatch";

export function loadBundledCatalog(extensionPath: string): MarketplaceCatalog {
  const p = path.join(extensionPath, "data", "marketplace.json");
  return JSON.parse(fs.readFileSync(p, "utf8")) as MarketplaceCatalog;
}

export function sortForModel(items: MarketplaceItem[], model: string): MarketplaceItem[] {
  return [...items].sort((a, b) => {
    const fa = evaluateFit(a, model);
    const fb = evaluateFit(b, model);
    if (fa.score !== fb.score) return fb.score - fa.score;
    return b.popularity - a.popularity;
  });
}

export function filterKind(items: MarketplaceItem[], kind: string | "all"): MarketplaceItem[] {
  if (kind === "all") return items;
  return items.filter((i) => i.kind === kind);
}

export function filterForModelView(
  items: MarketplaceItem[],
  model: string,
  mode: "recommended" | "all" | string
): MarketplaceItem[] {
  if (mode === "all") return sortForModel(items, model);
  if (mode === "conflicts") {
    // Conflicts tab is filled by the Hub from the installed registry — keep catalog empty here
    return [];
  }
  if (mode === "recommended") {
    return sortForModel(items, model).filter((i) => {
      const f = evaluateFit(i, model);
      return f.status === "compatible" && (i.fit === "required" || i.fit === "recommended" || i.defaultInstall);
    });
  }
  if (mode === "link" || mode === "external") {
    return sortForModel(items, model).filter((i) => i.kind === "link" || i.fit === "external");
  }
  // MCP / skill / rule tabs: show everything of that kind, including "not ideal" catalog
  // entries — incompatibility is only surfaced when the item is installed.
  return sortForModel(filterKind(items, mode), model);
}
