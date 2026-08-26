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
}

export interface InvokeResult {
  content: string;
  modelUsed: string;
  poolUsed: string;
  attempts: number;
  totalMs: number;
}

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
    let attempts = 0;
    const errors: string[] = [];

    for (const { pool, modelId } of modelOrder) {
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
          if (modelOrder.indexOf(modelOrder[attempts - 1]) < modelOrder.length - 1) {
            logModelSwitch(modelId, modelOrder[attempts]?.modelId ?? "N/A", reason);
          }
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
        const reason = this.classifyError(err);
        errors.push(`${modelId}: ${reason}`);

        const nextModel = modelOrder[attempts]?.modelId;
        if (nextModel) {
          logModelSwitch(modelId, nextModel, reason);
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
    let attempts = 0;
    const errors: string[] = [];

    for (const { pool, modelId } of modelOrder) {
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
          const delta = chunk.choices?.[0]?.delta?.content;
          if (delta) {
            fullContent += delta;
            onChunk(delta);
          }
        }

        if (!fullContent.trim()) {
          const reason = "empty stream response";
          errors.push(`${modelId}: ${reason}`);
          const nextModel = modelOrder[attempts]?.modelId;
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
        const reason = this.classifyError(err);
        errors.push(`${modelId}: ${reason}`);
        const nextModel = modelOrder[attempts]?.modelId;
        if (nextModel) logModelSwitch(modelId, nextModel, reason);
      }
    }

    throw new Error(
      `All ${attempts} streaming models exhausted after ${t.stop()}. Errors:\n` +
        errors.map((e) => `  - ${e}`).join("\n")
    );
  }

  private buildModelOrder(opts: InvokeOptions): Array<{ pool: string; modelId: string }> {
    if (opts.preferredModel) {
      const found = this.registry.findModelById(opts.preferredModel);
      if (found) {
        const rest = this.registry.getModelsSorted(found.pool)
          .filter((m) => m.id !== opts.preferredModel)
          .map((m) => ({ pool: found.pool, modelId: m.id }));
        return [{ pool: found.pool, modelId: opts.preferredModel }, ...rest];
      }
    }

    if (opts.preferredPool) {
      const models = this.registry.getModelsSorted(opts.preferredPool);
      if (models.length > 0) {
        return models.map((m) => ({ pool: opts.preferredPool!, modelId: m.id }));
      }
    }

    const allModels: Array<{ pool: string; modelId: string }> = [];
    for (const poolName of this.registry.getPools()) {
      for (const m of this.registry.getModelsSorted(poolName)) {
        if (!allModels.some((x) => x.modelId === m.id)) {
          allModels.push({ pool: poolName, modelId: m.id });
        }
      }
    }
    return allModels.sort((a, b) => {
      const ea = this.registry.findModelById(a.modelId)?.entry;
      const eb = this.registry.findModelById(b.modelId)?.entry;
      return (eb?.priority ?? 0) - (ea?.priority ?? 0);
    });
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
