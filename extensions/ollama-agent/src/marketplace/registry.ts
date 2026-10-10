import * as fs from "fs";
import * as path from "path";
import { ensureDir, registryPath } from "./paths";
import { MarketplaceRegistry, InstalledRecord } from "./types";

const EMPTY: MarketplaceRegistry = { version: 1, items: {} };

export function loadRegistry(): MarketplaceRegistry {
  const p = registryPath();
  ensureDir(path.dirname(p));
  if (!fs.existsSync(p)) return { ...EMPTY, items: { ...EMPTY.items } };
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as MarketplaceRegistry;
    return raw.version === 1 ? raw : { ...EMPTY };
  } catch {
    return { ...EMPTY };
  }
}

export function saveRegistry(reg: MarketplaceRegistry): void {
  const p = registryPath();
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(reg, null, 2), "utf8");
}

export function getRecord(reg: MarketplaceRegistry, id: string): InstalledRecord | undefined {
  return reg.items[id];
}

export function setRecord(
  reg: MarketplaceRegistry,
  id: string,
  patch: Partial<InstalledRecord>
): MarketplaceRegistry {
  const prev = reg.items[id] || { installed: false, enabled: false };
  return {
    ...reg,
    items: {
      ...reg.items,
      [id]: { ...prev, ...patch },
    },
  };
}
