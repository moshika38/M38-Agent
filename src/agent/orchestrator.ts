import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { ModelRegistry } from "../models/registry.js";
import { ModelInvoker, type InvokeOptions } from "../models/invoker.js";
import { TaskRouter } from "./router.js";
import { type ExecutionPlan, type OrchestratorResult, type FusionResult } from "../models/types.js";
import { logStep } from "../utils/logger.js";

export interface OrchestratorConfig {
  baseURL: string;
  apiKey: string;
  configPath?: string;
  enableStreaming?: boolean;
  quiet?: boolean;
}

export class Orchestrator {
  private registry: ModelRegistry;
  private invoker: ModelInvoker;
  private router: TaskRouter;
  private quiet: boolean;

  constructor(config: OrchestratorConfig) {
    this.registry = new ModelRegistry(config.configPath);
    this.invoker = new ModelInvoker(config.baseURL, config.apiKey, this.registry);
    this.router = new TaskRouter(this.invoker);
    this.quiet = config.quiet ?? false;
  }

  getRegistry(): ModelRegistry {
    return this.registry;
  }

  async process(
    userPrompt: string,
    opts: {
      conversationHistory?: ChatCompletionMessageParam[];
      images?: string[];
      systemPrompt?: string;
      onStreamChunk?: (chunk: string) => void;
      forceModel?: string;
      forcePool?: string;
    } = {}
  ): Promise<OrchestratorResult> {
    const hasImages = Boolean(opts.images?.length);

    const plan = opts.forceModel || opts.forcePool
      ? this.buildForcedPlan(opts.forceModel, opts.forcePool, hasImages)
      : await this.router.analyze(userPrompt, hasImages);

    if (!this.quiet) {
      console.log(
        "\n┌─── Execution Plan ───┐" +
        `\n│  Type:       ${plan.task_type}` +
        `\n│  Complexity: ${plan.complexity}` +
        `\n│  Vision:     ${plan.needs_vision ? "✔" : "✘"}` +
        `\n│  Coding:     ${plan.needs_coding ? "✔" : "✘"}` +
        `\n│  Reasoning:  ${plan.needs_deep_reasoning ? "✔" : "✘"}` +
        (plan.framework && plan.framework !== "none" ? `\n│  Framework:  ${plan.framework}` : "") +
        `\n│  Summary:    ${plan.summary}` +
        `\n└───────────────────────┘\n`
      );
    }

    if (plan.task_type === "complex_reasoning" && plan.complexity === "high") {
      const fusionConfig = this.registry.getConfig().specialModes.fusion;
      if (fusionConfig?.pools) {
        return this.executeFusion(userPrompt, plan, fusionConfig.pools, opts);
      }
    }

    return this.executeSingle(userPrompt, plan, opts);
  }

  private async executeSingle(
    userPrompt: string,
    plan: ExecutionPlan,
    opts: {
      conversationHistory?: ChatCompletionMessageParam[];
      systemPrompt?: string;
      onStreamChunk?: (chunk: string) => void;
    }
  ): Promise<OrchestratorResult> {
    const pool = this.selectPool(plan);
    const systemPrompt = this.buildSystemPrompt(plan, opts.systemPrompt);
    const messages = this.buildMessages(systemPrompt, userPrompt, opts.conversationHistory);

    if (!this.quiet) {
      logStep(1, 1, `Routing to pool: ${pool}`);
    }

    const invokeOpts: InvokeOptions = {
      messages,
      preferredPool: pool,
      temperature: plan.complexity === "low" ? 0.3 : 0.7,
      jsonMode: false,
    };

    let result;
    if (opts.onStreamChunk) {
      result = await this.invoker.invokeStreaming(invokeOpts, opts.onStreamChunk);
    } else {
      result = await this.invoker.invoke(invokeOpts);
    }

    return {
      plan,
      response: result.content,
      modelUsed: result.modelUsed,
      poolUsed: result.poolUsed,
      attempts: result.attempts,
      totalMs: result.totalMs,
    };
  }

  private async executeFusion(
    userPrompt: string,
    plan: ExecutionPlan,
    fusionPools: string[],
    opts: {
      conversationHistory?: ChatCompletionMessageParam[];
      systemPrompt?: string;
    }
  ): Promise<OrchestratorResult> {
    const systemPrompt = this.buildSystemPrompt(plan, opts.systemPrompt);
    const messages = this.buildMessages(systemPrompt, userPrompt, opts.conversationHistory);

    const promises = fusionPools.map(async (pool, idx) => {
      if (!this.quiet) {
        logStep(idx + 1, fusionPools.length, `Dispatching to pool: ${pool}`);
      }
      try {
        return await this.invoker.invoke({
          messages,
          preferredPool: pool,
          temperature: 0.7,
        });
      } catch {
        return null;
      }
    });

    const results = await Promise.allSettled(promises);
    const fusionResults: FusionResult[] = [];
    const responses: string[] = [];

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === "fulfilled" && r.value) {
        fusionResults.push({
          pool: fusionPools[i]!,
          modelUsed: r.value.modelUsed,
          response: r.value.content,
          attempts: r.value.attempts,
        });
        responses.push(
          `### ${fusionPools[i]?.toUpperCase()} (${r.value.modelUsed})\n\n${r.value.content}`
        );
      }
    }

    if (responses.length === 0) {
      throw new Error("All fusion pools failed");
    }

    const mergedResponse = responses.join("\n\n---\n\n");

    return {
      plan,
      response: mergedResponse,
      modelUsed: fusionResults.map((r) => r.modelUsed).join(", "),
      poolUsed: "fusion",
      attempts: fusionResults.reduce((sum, r) => sum + r.attempts, 0),
      totalMs: 0,
      fusionResults,
    };
  }

  private selectPool(plan: ExecutionPlan): string {
    if (plan.needs_vision) return "vision";
    if (plan.needs_coding) return "coding";
    if (plan.needs_deep_reasoning) return "reasoning";
    return "fast";
  }

  private buildSystemPrompt(plan: ExecutionPlan, custom?: string): string {
    if (custom) return custom;

    const parts: string[] = [];

    switch (plan.task_type) {
      case "direct_fast":
        parts.push("You are a helpful, concise assistant. Give direct, accurate answers.");
        break;
      case "deep_coding":
        parts.push(
          "You are an expert software engineer. Write clean, production-ready code.",
          "Follow best practices. Use proper error handling.",
          "When writing code, output complete files with proper imports.",
        );
        if (plan.framework && plan.framework !== "none" && plan.framework !== "general_code") {
          parts.push(`Specialize in ${plan.framework} development.`);
        }
        break;
      case "image_to_code":
        parts.push(
          "You are an expert at analyzing images and generating code from visual designs.",
          "Describe what you see, then provide the implementation code.",
        );
        break;
      case "complex_reasoning":
        parts.push(
          "You are a deep analytical thinker. Break down complex problems step by step.",
          "Consider multiple perspectives. Provide thorough, well-structured analysis.",
        );
        break;
    }

    if (plan.complexity === "high") {
      parts.push("This is a complex task. Take your time and be thorough.");
    }

    return parts.join("\n");
  }

  private buildMessages(
    systemPrompt: string,
    userPrompt: string,
    history?: ChatCompletionMessageParam[]
  ): ChatCompletionMessageParam[] {
    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: systemPrompt },
    ];

    if (history?.length) {
      messages.push(...history);
    }

    messages.push({ role: "user", content: userPrompt });
    return messages;
  }

  private buildForcedPlan(
    forceModel: string | undefined,
    forcePool: string | undefined,
    hasImages: boolean
  ): ExecutionPlan {
    const pool = forcePool ?? (forceModel ? this.registry.findModelById(forceModel)?.pool : null) ?? "fast";
    return {
      task_type: pool === "coding" ? "deep_coding" : pool === "reasoning" ? "complex_reasoning" : hasImages ? "image_to_code" : "direct_fast",
      needs_vision: hasImages || pool === "vision",
      needs_coding: pool === "coding",
      needs_deep_reasoning: pool === "reasoning",
      complexity: "medium",
      summary: `Forced routing to ${pool} pool${forceModel ? ` (model: ${forceModel})` : ""}`,
    };
  }
}
