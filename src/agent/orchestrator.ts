import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { ModelRegistry } from "../models/registry.js";
import { ModelInvoker, type InvokeOptions } from "../models/invoker.js";
import { TaskRouter } from "./router.js";
import { type ExecutionPlan, type OrchestratorResult, type FusionResult } from "../models/types.js";

export const M38_SYSTEM_PROMPT = `You are M38 Agent, an autonomous Multi-Agent AI Orchestrator and Smart Model Router.
You are powered by a multi-model engine routing dynamically across Vision, Coding, Deep Reasoning, and Fast Execution tiers.

Guidelines:
- Your identity is strictly "M38 Agent". Never identify yourself as a generic model trained solely by Google, OpenAI, DeepSeek, or Anthropic.
- If asked "Who are you?", state that you are M38 Agent, an AI Orchestrator built to route tasks intelligently across specialized AI models.
- Maintain an expert, concise, technical, and helpful developer tone.
- When generating code or analyzing architectures, deliver production-ready, clean, and bug-free output.`;

export interface OrchestratorConfig {
  baseURL: string;
  apiKey: string;
  configPath?: string;
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
      signal?: AbortSignal;
      onRouting?: (model: string, pool: string, ms: number) => void;
    } = {}
  ): Promise<OrchestratorResult> {
    const hasImages = Boolean(opts.images?.length);

    const plan = opts.forceModel || opts.forcePool
      ? this.buildForcedPlan(opts.forceModel, opts.forcePool, hasImages)
      : await this.router.analyze(userPrompt, hasImages);

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
      signal?: AbortSignal;
      onRouting?: (model: string, pool: string, ms: number) => void;
    }
  ): Promise<OrchestratorResult> {
    const pool = this.selectPool(plan);
    const systemPrompt = this.buildSystemPrompt(plan, opts.systemPrompt);
    const messages = this.buildMessages(systemPrompt, userPrompt, opts.conversationHistory);

    const invokeOpts: InvokeOptions = {
      messages,
      preferredPool: pool,
      temperature: plan.complexity === "low" ? 0.3 : 0.7,
      jsonMode: false,
      signal: opts.signal,
    };

    let result;
    if (opts.onStreamChunk) {
      result = await this.invoker.invokeStreaming(invokeOpts, opts.onStreamChunk);
    } else {
      result = await this.invoker.invoke(invokeOpts);
    }

    if (opts.onRouting && !this.quiet) {
      opts.onRouting(result.modelUsed, result.poolUsed, result.totalMs);
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
      signal?: AbortSignal;
      onRouting?: (model: string, pool: string, ms: number) => void;
    }
  ): Promise<OrchestratorResult> {
    const systemPrompt = this.buildSystemPrompt(plan, opts.systemPrompt);
    const messages = this.buildMessages(systemPrompt, userPrompt, opts.conversationHistory);

    const promises = fusionPools.map(async (pool) => {
      try {
        return await this.invoker.invoke({
          messages,
          preferredPool: pool,
          temperature: 0.7,
          signal: opts.signal,
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
    const taskParts: string[] = [];

    switch (plan.task_type) {
      case "direct_fast":
        taskParts.push("Give direct, accurate answers.");
        break;
      case "deep_coding":
        taskParts.push(
          "Write clean, production-ready code.",
          "Follow best practices. Use proper error handling.",
          "Output complete files with proper imports.",
        );
        if (plan.framework && plan.framework !== "none" && plan.framework !== "general_code") {
          taskParts.push(`Specialize in ${plan.framework} development.`);
        }
        break;
      case "image_to_code":
        taskParts.push(
          "Analyze the provided image and generate matching code.",
          "Describe what you see, then provide the full implementation.",
        );
        break;
      case "complex_reasoning":
        taskParts.push(
          "Break down complex problems step by step.",
          "Consider multiple perspectives. Provide thorough, well-structured analysis.",
        );
        break;
    }

    if (plan.complexity === "high") {
      taskParts.push("This is a complex task. Take your time and be thorough.");
    }

    if (custom) {
      return M38_SYSTEM_PROMPT + "\n\n" + custom;
    }

    return taskParts.length > 0
      ? M38_SYSTEM_PROMPT + "\n\n" + taskParts.join("\n")
      : M38_SYSTEM_PROMPT;
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
