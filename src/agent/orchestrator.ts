import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { readFileSync, existsSync } from "node:fs";
import { extname, resolve } from "node:path";
import { ModelRegistry } from "../models/registry.js";
import { ModelInvoker, type InvokeOptions } from "../models/invoker.js";
import { TaskRouter } from "./router.js";
import { type ExecutionPlan, type OrchestratorResult, type FusionResult, type PipelineStage } from "../models/types.js";
import { MODEL_POOLS, POOL_LABELS, type PoolName } from "../config/models.js";
import { sessionManager } from "../session/manager.js";

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
    this.router = new TaskRouter();
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
    // ── @filepath context injection ──────────────────────────
    const { cleanPrompt, injectedContext, attachedImages } = this.extractFileContext(userPrompt);

    const allImages = [...(opts.images || []), ...attachedImages];
    const hasImages = allImages.length > 0;

    const fullPrompt = injectedContext
      ? `${injectedContext}\n\n---\n\n${cleanPrompt}`
      : cleanPrompt;

    // ── Intent routing (deterministic) ───────────────────────
    const plan = opts.forceModel || opts.forcePool
      ? this.buildForcedPlan(opts.forceModel, opts.forcePool, hasImages)
      : this.router.analyze(fullPrompt, hasImages);

    if (hasImages && plan.task_type !== "image_to_code") {
      plan.task_type = "image_to_code";
      plan.needs_vision = true;
    }

    // ── Select primary pool and model ────────────────────────
    const pool = this.selectPool(plan);
    const primaryModel = this.getPrimaryModel(pool);
    const poolLabel = POOL_LABELS[pool as PoolName] || pool;

    // ── Display routing badge ────────────────────────────────
    if (!this.quiet) {
      const badge = `\x1b[38;2;245;166;35m[◆ M38]\x1b[0m Task: ${poolLabel} \x1b[38;2;245;166;35m➔\x1b[0m Primary: ${primaryModel}`;
      process.stdout.write(badge + '\n');
    }

    // ── Record user message to session ──────────────────────
    sessionManager.addMessage('user', userPrompt);

    // ── Pipeline execution ───────────────────────────────────
    if (plan.pipeline && plan.pipeline.length > 0) {
      const result = await this.executePipeline(fullPrompt, plan, { ...opts, images: allImages });
      sessionManager.addMessage('assistant', result.response);
      return result;
    }

    // ── Fusion execution ─────────────────────────────────────
    if (plan.task_type === "complex_reasoning" && plan.complexity === "high") {
      const fusionConfig = this.registry.getConfig().specialModes.fusion;
      if (fusionConfig?.pools) {
        const result = await this.executeFusion(fullPrompt, plan, fusionConfig.pools, { ...opts, images: allImages });
        sessionManager.addMessage('assistant', result.response);
        return result;
      }
    }

    // ── Single model execution (default) ─────────────────────
    const result = await this.executeSingle(fullPrompt, plan, { ...opts, images: allImages });
    sessionManager.addMessage('assistant', result.response);
    return result;
  }

  /* ------------------------------------------------------------------ */
  /*  @filepath Context Injection                                        */
  /* ------------------------------------------------------------------ */

  private extractFileContext(prompt: string): {
    cleanPrompt: string;
    injectedContext: string;
    attachedImages: string[];
  } {
    const AT_FILE_REGEX = /@([^\s@]+\.\w+)/g;
    const contextParts: string[] = [];
    const images: string[] = [];
    let cleanPrompt = prompt;

    let match;
    while ((match = AT_FILE_REGEX.exec(prompt)) !== null) {
      const filePath = match[1]!;
      const absolutePath = resolve(process.cwd(), filePath);

      if (!existsSync(absolutePath)) continue;

      const ext = extname(filePath).toLowerCase();
      const isImage = /\.(png|jpe?g|webp|svg|gif|bmp)$/i.test(ext);

      if (isImage) {
        images.push(absolutePath);
        cleanPrompt = cleanPrompt.replace(match[0], `[image: ${filePath}]`);
      } else {
        const content = this.readAttachedFile(absolutePath, filePath);
        if (content) {
          contextParts.push(content);
          cleanPrompt = cleanPrompt.replace(match[0], `[file: ${filePath}]`);
        }
      }
    }

    return {
      cleanPrompt: cleanPrompt.trim(),
      injectedContext: contextParts.join("\n\n"),
      attachedImages: images,
    };
  }

  private readAttachedFile(absolutePath: string, relativePath: string): string | null {
    try {
      const content = readFileSync(absolutePath, "utf-8");
      const ext = extname(relativePath).toLowerCase();
      const langMap: Record<string, string> = {
        '.ts': 'typescript', '.tsx': 'tsx', '.js': 'javascript', '.jsx': 'jsx',
        '.dart': 'dart', '.py': 'python', '.rb': 'ruby', '.go': 'go',
        '.rs': 'rust', '.java': 'java', '.kt': 'kotlin',
        '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml',
        '.html': 'html', '.css': 'css', '.scss': 'scss',
        '.md': 'markdown', '.sh': 'bash', '.bash': 'bash', '.env': 'bash',
      };
      const lang = langMap[ext] || '';
      return `[Attached File: ${relativePath}]\n\`\`\`${lang}\n${content}\n\`\`\``;
    } catch {
      return null;
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Pipeline Execution                                                 */
  /* ------------------------------------------------------------------ */

  private async executePipeline(
    userPrompt: string,
    plan: ExecutionPlan,
    opts: {
      conversationHistory?: ChatCompletionMessageParam[];
      images?: string[];
      systemPrompt?: string;
      onStreamChunk?: (chunk: string) => void;
      signal?: AbortSignal;
      onRouting?: (model: string, pool: string, ms: number) => void;
    }
  ): Promise<OrchestratorResult> {
    const stages = plan.pipeline!;
    let accumulatedContext = userPrompt;
    let lastResult = "";
    let totalAttempts = 0;
    let totalMs = 0;
    const usedModels: string[] = [];

    for (let i = 0; i < stages.length; i++) {
      const stage = stages[i]!;
      const isFinal = i === stages.length - 1;

      const stageSystemPrompt = this.buildStageSystemPrompt(stage, plan);
      const messages = this.buildMessages(stageSystemPrompt, accumulatedContext);

      const invokeOpts: InvokeOptions = {
        messages,
        preferredPool: stage.pool,
        temperature: stage.temperature ?? 0.7,
        jsonMode: false,
        signal: opts.signal,
        onFallback: (from, to, reason) => {
          if (!this.quiet) {
            const cleanReason = reason.replace(/ \(.+\)/, '');
            process.stdout.write(`\n\x1b[33m[⟳ Fallback] ${from} ➔ ${to} (${cleanReason})\x1b[0m\n`);
          }
        },
      };

      let result;
      if (isFinal && opts.onStreamChunk) {
        result = await this.invoker.invokeStreaming(invokeOpts, opts.onStreamChunk);
        if (opts.onRouting && !this.quiet) {
          opts.onRouting(result.modelUsed, result.poolUsed, result.totalMs);
        }
      } else {
        result = await this.invoker.invoke(invokeOpts);
        if (opts.onRouting && !this.quiet) {
          opts.onRouting(result.modelUsed, result.poolUsed, result.totalMs);
        }
      }

      totalAttempts += result.attempts;
      totalMs += result.totalMs;
      usedModels.push(result.modelUsed);
      lastResult = result.content;

      accumulatedContext = `[Previous stage output (${stage.id}: ${stage.systemPrompt})]\n\n${result.content}`;
    }

    return {
      plan,
      response: lastResult,
      modelUsed: usedModels.join(" → "),
      poolUsed: `pipeline(${stages.map(s => s.pool).join("→")})`,
      primaryModel: usedModels[0] || "",
      attempts: totalAttempts,
      totalMs,
    };
  }

  private buildStageSystemPrompt(stage: PipelineStage, plan: ExecutionPlan): string {
    const parts: string[] = [
      M38_SYSTEM_PROMPT,
      "",
      `## Pipeline Stage: ${stage.id}`,
      `Objective: ${stage.systemPrompt}`,
      `Task type: ${plan.task_type} | Complexity: ${plan.complexity}`,
    ];

    if (plan.framework && plan.framework !== "none" && plan.framework !== "general_code") {
      parts.push(`Framework: ${plan.framework}`);
    }

    if (stage.id === "execute" || stage.pool === "coding") {
      parts.push(
        "",
        "Guidelines:",
        "- Write clean, production-ready code.",
        "- Follow best practices. Use proper error handling.",
        "- Output complete files with proper imports.",
      );
    }

    if (stage.pool === "reasoning") {
      parts.push(
        "",
        "Guidelines:",
        "- Break down problems step by step.",
        "- Consider multiple perspectives.",
        "- Provide thorough, well-structured analysis.",
      );
    }

    return parts.join("\n");
  }

  /* ------------------------------------------------------------------ */
  /*  Single Model Execution                                             */
  /* ------------------------------------------------------------------ */

  private async executeSingle(
    userPrompt: string,
    plan: ExecutionPlan,
    opts: {
      conversationHistory?: ChatCompletionMessageParam[];
      images?: string[];
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
      onFallback: (from, to, reason) => {
        if (!this.quiet) {
          const cleanReason = reason.replace(/ \(.+\)/, '');
          process.stdout.write(`\n\x1b[33m[⟳ Fallback] ${from} ➔ ${to} (${cleanReason})\x1b[0m\n`);
        }
      },
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
      primaryModel: this.getPrimaryModel(pool),
      attempts: result.attempts,
      totalMs: result.totalMs,
    };
  }

  /* ------------------------------------------------------------------ */
  /*  Fusion Execution (parallel multi-pool)                             */
  /* ------------------------------------------------------------------ */

  private async executeFusion(
    userPrompt: string,
    plan: ExecutionPlan,
    fusionPools: string[],
    opts: {
      conversationHistory?: ChatCompletionMessageParam[];
      images?: string[];
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
          onFallback: (from, to, reason) => {
            if (!this.quiet) {
              const cleanReason = reason.replace(/ \(.+\)/, '');
              process.stdout.write(`\n\x1b[33m[⟳ Fallback] ${from} ➔ ${to} (${cleanReason})\x1b[0m\n`);
            }
          },
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
      primaryModel: fusionResults[0]?.modelUsed || "",
      attempts: fusionResults.reduce((sum, r) => sum + r.attempts, 0),
      totalMs: 0,
      fusionResults,
    };
  }

  /* ------------------------------------------------------------------ */
  /*  Shared Helpers                                                     */
  /* ------------------------------------------------------------------ */

  private selectPool(plan: ExecutionPlan): string {
    if (plan.needs_vision) return "vision";
    if (plan.needs_coding) return "coding";
    if (plan.needs_deep_reasoning) return "reasoning";
    return "fast";
  }

  private getPrimaryModel(pool: string): string {
    const models = MODEL_POOLS[pool as PoolName];
    return models?.[0] || "unknown";
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
