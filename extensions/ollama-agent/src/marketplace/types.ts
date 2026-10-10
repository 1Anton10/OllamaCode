export type MarketplaceKind = "mcp" | "skill" | "rule" | "link";

/** How tightly the item should bind to the active local model. */
export type MarketplaceFit = "required" | "recommended" | "optional" | "external";

export interface MarketplaceItem {
  id: string;
  kind: MarketplaceKind;
  name: string;
  description: string;
  source: string;
  region?: string[];
  popularity: number;
  /** Tags that make this item relevant for a model family. */
  modelTags: string[];
  /**
   * If set, item is hidden/disabled when the active model has ANY of these tags
   * (e.g. sequential-thinking vs native qwen3 thinking).
   */
  excludeIfTags?: string[];
  /** Minimum overlap with model tags to count as compatible (default 1 for non-external). */
  minTagOverlap?: number;
  fit?: MarketplaceFit;
  defaultInstall?: boolean;
  needsEnv?: string[];
  url?: string;
  mcp?: {
    key: string;
    command: string;
    args: string[];
    env?: Record<string, string>;
  };
  install?: {
    type: "git-sparse" | "builtin";
    repo?: string;
    paths?: string[];
    files?: { dest: string; content: string }[];
  };
}

export interface MarketplaceCatalog {
  version: number;
  updated?: string;
  items: MarketplaceItem[];
}

export interface InstalledRecord {
  installed: boolean;
  enabled: boolean;
  installedAt?: string;
  path?: string;
  mcpKey?: string;
}

export interface MarketplaceRegistry {
  version: 1;
  items: Record<string, InstalledRecord>;
}

export type FitStatus = "compatible" | "conflict" | "needs-env" | "external";
