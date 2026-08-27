import { z } from "zod";
import { readFileSync } from "node:fs";

export const ModelEntrySchema = z.object({
  id: z.string(),
  priority: z.number().min(1).max(10),
  contextWindow: z.number().min(1),
});
export type ModelEntry = z.infer<typeof ModelEntrySchema>;

export const PoolSchema = z.object({
  label: z.string(),
  models: z.array(ModelEntrySchema),
});
export type Pool = z.infer<typeof PoolSchema>;

export const SpecialModeSchema = z.object({
  description: z.string(),
  pool: z.string().nullable().optional(),
  pools: z.array(z.string()).optional(),
});
export type SpecialMode = z.infer<typeof SpecialModeSchema>;

export const ModelsConfigSchema = z.object({
  pools: z.record(z.string(), PoolSchema),
  specialModes: z.record(z.string(), SpecialModeSchema),
});
export type ModelsConfig = z.infer<typeof ModelsConfigSchema>;

const FALLBACK_CONFIG: ModelsConfig = {
  pools: {
    vision: {
      label: "Vision / Multimodal",
      models: [
        { id: "gemini-3.5-flash", priority: 10, contextWindow: 1048576 },
        { id: "gemini-3-flash-preview", priority: 9, contextWindow: 1048576 },
        { id: "llama-4-scout", priority: 8, contextWindow: 524288 },
        { id: "gemini-2.5-flash", priority: 7, contextWindow: 1048576 },
      ],
    },
    coding: {
      label: "Primary Coding",
      models: [
        { id: "qwen3-coder-next", priority: 10, contextWindow: 262144 },
        { id: "qwen3-coder-480b", priority: 9, contextWindow: 262144 },
        { id: "devstral-2-123b", priority: 8, contextWindow: 131072 },
        { id: "codestral", priority: 7, contextWindow: 131072 },
      ],
    },
    fast: {
      label: "Fast / Lightweight",
      models: [
        { id: "gpt-oss-120b", priority: 10, contextWindow: 131072 },
        { id: "glm-4.7-flash", priority: 9, contextWindow: 131072 },
        { id: "qwen3-30b-a3b-fp8", priority: 8, contextWindow: 131072 },
        { id: "mistral-medium-3.5", priority: 7, contextWindow: 131072 },
      ],
    },
    reasoning: {
      label: "Deep Reasoning / Architecture",
      models: [
        { id: "cogito-2.1-671b", priority: 10, contextWindow: 131072 },
        { id: "deepseek-v4-pro", priority: 9, contextWindow: 131072 },
        { id: "minimax-m2.7", priority: 8, contextWindow: 131072 },
        { id: "kimi-k2.6", priority: 7, contextWindow: 131072 },
      ],
    },
  },
  specialModes: {
    auto: { description: "Automatically routes to the best model based on task analysis", pool: null },
    fusion: { description: "Runs parallel requests across multiple pools and merges results", pools: ["coding", "reasoning"] },
  },
};

export class ModelRegistry {
  private config: ModelsConfig;
  private poolModels: Map<string, ModelEntry[]>;

  constructor(configPath?: string) {
    if (configPath) {
      try {
        const raw = readFileSync(configPath, "utf-8");
        const parsed = JSON.parse(raw);
        this.config = ModelsConfigSchema.parse(parsed);
      } catch {
        this.config = FALLBACK_CONFIG;
      }
    } else {
      this.config = FALLBACK_CONFIG;
    }

    this.poolModels = new Map();
    for (const [poolName, pool] of Object.entries(this.config.pools)) {
      const sorted = [...pool.models].sort((a, b) => b.priority - a.priority);
      this.poolModels.set(poolName, sorted);
    }
  }

  getConfig(): ModelsConfig {
    return this.config;
  }

  getPools(): string[] {
    return Object.keys(this.config.pools);
  }

  getPool(poolName: string): Pool | undefined {
    return this.config.pools[poolName];
  }

  getModelsSorted(poolName: string): ModelEntry[] {
    return this.poolModels.get(poolName) ?? [];
  }

  getTopModel(poolName: string): ModelEntry | undefined {
    const models = this.getModelsSorted(poolName);
    return models[0];
  }

  findModelById(modelId: string): { pool: string; entry: ModelEntry } | undefined {
    for (const [poolName, models] of this.poolModels) {
      const entry = models.find((m) => m.id === modelId);
      if (entry) return { pool: poolName, entry };
    }
    return undefined;
  }

  getModelsForCapabilities(needs: { vision?: boolean; coding?: boolean; reasoning?: boolean }): string[] {
    const pools: string[] = [];
    if (needs.vision) pools.push("vision");
    if (needs.coding) pools.push("coding");
    if (needs.reasoning) pools.push("reasoning");
    if (pools.length === 0) pools.push("fast");

    const seen = new Set<string>();
    const result: string[] = [];

    for (const pool of pools) {
      for (const model of this.getModelsSorted(pool)) {
        if (!seen.has(model.id)) {
          seen.add(model.id);
          result.push(model.id);
        }
      }
    }
    return result;
  }
}
