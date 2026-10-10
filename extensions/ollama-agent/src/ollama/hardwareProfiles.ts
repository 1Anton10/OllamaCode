/**
 * Smart hardware presets for Ollama layer offload (num_gpu) + context/batch knobs.
 *
 * Ollama has no separate "disk" knob: weights not in GPU/RAM are mmap'd from disk.
 * Presets choose how aggressively to pin layers on GPU vs leave them for CPU/RAM/mmap.
 */

export type HardwareProfile = "light" | "medium" | "max";

export interface HardwareProfileResolved {
  profile: HardwareProfile;
  /** Layers on GPU; null = leave unset (Ollama default / all) */
  numGpu: number | null;
  numCtx: number;
  numBatch: number;
  numPredict: number;
  numThread: number;
  keepAlive: string;
  label: string;
  blurb: string;
}

/** Fraction of model layers on GPU for each preset. */
const GPU_FRACTION: Record<HardwareProfile, number> = {
  light: 0.25, // mostly CPU/RAM (+ disk mmap)
  medium: 0.7, // prefer GPU on 8GB — CPU offload of MoE often OOMs (~1GB buffers)
  max: 1.0, // pin as many layers as possible on GPU
};

const BASE: Record<
  HardwareProfile,
  Omit<HardwareProfileResolved, "profile" | "numGpu" | "label" | "blurb">
> = {
  light: {
    // Fewer GPU layers → more VRAM for KV → longer real context
    numCtx: 32768,
    numBatch: 256,
    numPredict: -1,
    numThread: 0,
    keepAlive: "5m",
  },
  medium: {
    // ~8GB + 9B dense: 16–32k KV is normal; do not fake 32k with a 4k window
    numCtx: 16384,
    numBatch: 256,
    numPredict: -1,
    numThread: 0,
    keepAlive: "10m",
  },
  max: {
    // Max layers on GPU → less room for KV; still keep a usable window
    numCtx: 8192,
    numBatch: 128,
    numPredict: -1,
    numThread: 0,
    keepAlive: "30m",
  },
};

const LABELS: Record<HardwareProfile, { label: string; blurb: string }> = {
  light: {
    label: "Light · RAM/CPU (+ disk mmap)",
    blurb:
      "Мало слоёв на GPU → больше VRAM под KV-кэш и длинный контекст. Веса в RAM/CPU, остаток mmap с диска.",
  },
  medium: {
    label: "Medium · GPU + RAM/CPU",
    blurb: "Половина слоёв на GPU, остальное в системной памяти. Баланс скорости и устойчивости на 8 ГБ.",
  },
  max: {
    label: "Max · всё на GPU",
    blurb: "Максимум слоёв в VRAM — быстрее токены, но меньше места под контекст (риск OOM на больших MoE).",
  },
};

export function resolveHardwareProfile(
  profile: HardwareProfile,
  layerCount?: number
): HardwareProfileResolved {
  const base = BASE[profile];
  const meta = LABELS[profile];
  let numGpu: number | null = null;
  if (typeof layerCount === "number" && layerCount > 0) {
    numGpu = Math.max(0, Math.min(layerCount, Math.round(layerCount * GPU_FRACTION[profile])));
    if (profile === "max") numGpu = layerCount;
    if (profile === "light") numGpu = Math.max(1, numGpu); // keep at least 1 layer on GPU for speed
  } else {
    // Fallback without known layer count (agent35 Qwen3.5 MoE ≈ 40)
    const guess = 40;
    numGpu =
      profile === "max"
        ? 99
        : profile === "medium"
          ? Math.round(guess * 0.7)
          : Math.max(1, Math.round(guess * 0.25));
  }
  return {
    profile,
    numGpu,
    ...base,
    label: meta.label,
    blurb: meta.blurb,
  };
}

export function applyProfileToOverrides(
  cur: Record<string, unknown>,
  profile: HardwareProfile,
  layerCount?: number
): Record<string, unknown> {
  const r = resolveHardwareProfile(profile, layerCount);
  return {
    ...cur,
    hardwareProfile: profile,
    numGpu: r.numGpu,
    numCtx: r.numCtx,
    numBatch: r.numBatch,
    numPredict: r.numPredict,
    numThread: r.numThread,
    keepAlive: r.keepAlive,
  };
}
