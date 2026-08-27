import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { ModelRegistry } from "./registry.js";
import { logModelSwitch, timer } from "../utils/logger.js";

export interface InvokeOptions {
  messages: ChatCompletionMessageParam[];
  preferredPool?: string;
  preferredModel?: string;
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
  signal?: AbortSignal;
  onFallback?: (fromModel: string, toModel: string, reason: string) => void;
}

export interface InvokeResult {
  content: string;
  modelUsed: string;
  poolUsed: string;
  attempts: number;
  totalMs: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const UNIVERSAL_FALLBACKS = [
  "glm-4.7-flash",
  "qwen3-30b-a3b-fp8",
  "gpt-oss-120b",
  "mistral-medium-3.5",
];

export class ModelInvoker {
  private client: OpenAI;
  private registry: ModelRegistry;

  constructor(baseURL: string, apiKey: string, registry: ModelRegistry) {
    this.client = new OpenAI({ baseURL, apiKey });
    this.registry = registry;
  }

  async invoke(opts: InvokeOptions): Promise<InvokeResult> {
    const modelOrder = this.buildModelOrder(opts);
    const t = timer();
    const attempted = new Set<string>();
    const errors: string[] = [];
    let attempts = 0;
    let rateLimitCount = 0;

    for (const { pool, modelId } of modelOrder) {
      if (opts.signal?.aborted) {
        const abortErr = new Error("Task was aborted.");
        abortErr.name = "AbortError";
        throw abortErr;
      }
      if (attempted.has(modelId)) continue;
      attempted.add(modelId);
      attempts++;

      try {
        const params: OpenAI.ChatCompletionCreateParamsNonStreaming = {
          model: modelId,
          messages: opts.messages,
          temperature: opts.temperature ?? 0.7,
          stream: false,
        };
        if (opts.maxTokens) params.max_tokens = opts.maxTokens;
        if (opts.jsonMode) params.response_format = { type: "json_object" };

        const res = await this.client.chat.completions.create(params, {
          signal: opts.signal,
        });

        const content = res.choices?.[0]?.message?.content;
        if (!content || content.trim().length === 0) {
          const reason = "empty response";
          errors.push(`${modelId}: ${reason}`);
          const nextModel = modelOrder.find((m) => !attempted.has(m.modelId))?.modelId;
          if (nextModel) logModelSwitch(modelId, nextModel, reason);
          continue;
        }

        return {
          content: content.trim(),
          modelUsed: modelId,
          poolUsed: pool,
          attempts,
          totalMs: t.elapsed(),
        };
      } catch (err: unknown) {
        if (opts.signal?.aborted || this.isAbortError(err)) {
          const abortErr = err instanceof Error ? err : new Error("Task was aborted.");
          abortErr.name = "AbortError";
          throw abortErr;
        }
        const reason = this.classifyError(err);
        errors.push(`${modelId}: ${reason}`);

        const nextModel = modelOrder.find((m) => !attempted.has(m.modelId))?.modelId;
        if (nextModel) {
          logModelSwitch(modelId, nextModel, reason);
          opts.onFallback?.(modelId, nextModel, reason);
        }

        // exponential backoff on rate limit (429)
        if (reason.includes("429")) {
          rateLimitCount++;
          const jitter = Math.min(400 * rateLimitCount, 3000) + Math.random() * 200;
          await sleep(jitter);
        }
      }
    }

    throw new Error(
      `All ${attempts} models exhausted after ${t.stop()}. Errors:\n` +
        errors.map((e) => `  - ${e}`).join("\n")
    );
  }

  async invokeStreaming(
    opts: InvokeOptions,
    onChunk: (chunk: string) => void
  ): Promise<InvokeResult> {
    const modelOrder = this.buildModelOrder(opts);
    const t = timer();
    const attempted = new Set<string>();
    const errors: string[] = [];
    let attempts = 0;
    let rateLimitCount = 0;

    for (const { pool, modelId } of modelOrder) {
      if (opts.signal?.aborted) {
        const abortErr = new Error("Task was aborted.");
        abortErr.name = "AbortError";
        throw abortErr;
      }
      if (attempted.has(modelId)) continue;
      attempted.add(modelId);
      attempts++;

      try {
        const params: OpenAI.ChatCompletionCreateParamsStreaming = {
          model: modelId,
          messages: opts.messages,
          temperature: opts.temperature ?? 0.7,
          stream: true,
        };
        if (opts.maxTokens) params.max_tokens = opts.maxTokens;

        const stream = await this.client.chat.completions.create(params, {
          signal: opts.signal,
        });

        let fullContent = "";
        for await (const chunk of stream) {
          if (opts.signal?.aborted) {
            const abortErr = new Error("Task was aborted.");
            abortErr.name = "AbortError";
            throw abortErr;
          }
          const delta = chunk.choices?.[0]?.delta?.content;
          if (delta) {
            fullContent += delta;
            onChunk(delta);
          }
        }

        if (!fullContent.trim()) {
          const reason = "empty stream response";
          errors.push(`${modelId}: ${reason}`);
          const nextModel = modelOrder.find((m) => !attempted.has(m.modelId))?.modelId;
          if (nextModel) logModelSwitch(modelId, nextModel, reason);
          continue;
        }

        return {
          content: fullContent.trim(),
          modelUsed: modelId,
          poolUsed: pool,
          attempts,
          totalMs: t.elapsed(),
        };
      } catch (err: unknown) {
        if (opts.signal?.aborted || this.isAbortError(err)) {
          const abortErr = err instanceof Error ? err : new Error("Task was aborted.");
          abortErr.name = "AbortError";
          throw abortErr;
        }
        const reason = this.classifyError(err);
        errors.push(`${modelId}: ${reason}`);
        const nextModel = modelOrder.find((m) => !attempted.has(m.modelId))?.modelId;
        if (nextModel) {
          logModelSwitch(modelId, nextModel, reason);
          opts.onFallback?.(modelId, nextModel, reason);
        }

        // exponential backoff on rate limit (429)
        if (reason.includes("429")) {
          rateLimitCount++;
          const jitter = Math.min(400 * rateLimitCount, 3000) + Math.random() * 200;
          await sleep(jitter);
        }
      }
    }

    throw new Error(
      `All ${attempts} streaming models exhausted after ${t.stop()}. Errors:\n` +
        errors.map((e) => `  - ${e}`).join("\n")
    );
  }

  private buildModelOrder(opts: InvokeOptions): Array<{ pool: string; modelId: string }> {
    const seen = new Set<string>();
    const result: Array<{ pool: string; modelId: string }> = [];

    const addUnique = (pool: string, modelId: string) => {
      if (!seen.has(modelId)) {
        seen.add(modelId);
        result.push({ pool, modelId });
      }
    };

    if (opts.preferredModel) {
      const found = this.registry.findModelById(opts.preferredModel);
      if (found) {
        addUnique(found.pool, opts.preferredModel);
        for (const m of this.registry.getModelsSorted(found.pool)) {
          if (m.id !== opts.preferredModel) addUnique(found.pool, m.id);
        }
      }
    }

    if (opts.preferredPool) {
      const models = this.registry.getModelsSorted(opts.preferredPool);
      for (const m of models) {
        addUnique(opts.preferredPool, m.id);
      }

      // Cross-pool fallback: if preferred pool is small, append top models from other pools
      if (models.length < 8) {
        for (const poolName of this.registry.getPools()) {
          if (poolName === opts.preferredPool) continue;
          for (const m of this.registry.getModelsSorted(poolName)) {
            addUnique(poolName, m.id);
          }
        }
      }
    } else {
      for (const poolName of this.registry.getPools()) {
        for (const m of this.registry.getModelsSorted(poolName)) {
          addUnique(poolName, m.id);
        }
      }
    }

    // Universal fallbacks: models not already in the registry-based chain
    for (const modelId of UNIVERSAL_FALLBACKS) {
      if (!seen.has(modelId)) {
        addUnique("fast", modelId);
      }
    }

    return result;
  }

  private isAbortError(err: unknown): boolean {
    if (err instanceof DOMException) return err.name === "AbortError";
    if (err instanceof Error) {
      return err.name === "AbortError" || err.message.toLowerCase().includes("aborted");
    }
    return false;
  }

  private classifyError(err: unknown): string {
    if (err instanceof Error) {
      const msg = err.message.toLowerCase();
      if (msg.includes("429") || msg.includes("rate") || msg.includes("too many"))
        return "rate limited (429)";
      if (msg.includes("500") || msg.includes("502") || msg.includes("503"))
        return "server error (5xx)";
      if (msg.includes("context") || msg.includes("token") || msg.includes("length"))
        return "context length exceeded";
      if (msg.includes("timeout") || msg.includes("network") || msg.includes("fetch"))
        return "network/timeout error";
      if (msg.includes("econnrefused") || msg.includes("enotfound"))
        return "connection refused";
      return `error: ${err.message.slice(0, 120)}`;
    }
    return "unknown error";
  }
}
