import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { readFileSync, existsSync } from "node:fs";
import { extname, resolve } from "node:path";
import { ModelRegistry } from "../models/registry.js";
import { ModelInvoker, type InvokeOptions } from "../models/invoker.js";
import { TaskRouter } from "./router.js";
import { type ExecutionPlan, type OrchestratorResult, type FusionResult, type PipelineStage } from "../models/types.js";
import { MODEL_POOLS, POOL_LABELS, type PoolName } from "../config/models.js";
import { sessionManager } from "../session/manager.js";
import { getToolSystemPrompt, parseToolCalls, executeToolCall, formatToolResults, writeFile } from "./tools.js";
import { pruneConversation } from "./contextManager.js";
import { spinner } from "../utils/spinner.js";
import { renderPrettyPlan } from "../utils/planFormatter.js";
import chalk from "chalk";

export type AgentMode = 'PLAN' | 'BUILD';

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

  private lastApprovedPlan: string | null = null;

  constructor(config: OrchestratorConfig) {
    this.registry = new ModelRegistry(config.configPath);
    this.invoker = new ModelInvoker(config.baseURL, config.apiKey, this.registry);
    this.router = new TaskRouter();
    this.quiet = config.quiet ?? false;
  }

  getLastPlan(): string | null {
    return this.lastApprovedPlan;
  }

  clearLastPlan(): void {
    this.lastApprovedPlan = null;
  }

  async runTask(prompt: string, mode: AgentMode = 'BUILD', signal?: AbortSignal): Promise<OrchestratorResult> {
    return this.process(prompt, { mode, signal });
  }

  async executePlan(planMarkdown: string, signal?: AbortSignal): Promise<void> {
    spinner.start('Building project files from plan...');

    const systemPrompt = `You are an automated file-generation agent.
You have tools to create and write files: \`write_file(path, content)\` and \`execute_command(command)\`.
Your ONLY job right now is to execute the following plan by creating all necessary files with full, production-ready code.

CRITICAL RULES:
- Do not output conversational preamble or explanations.
- Immediately call \`write_file\` for each file specified in the plan (HTML, CSS, JS, etc.).
- Write complete, robust code (no placeholders, TODOs, or truncated sections).

When you need to use a tool, respond with a JSON code block in this exact format:
\`\`\`tool_call
{
  "name": "write_file",
  "arguments": {
    "path": "filename.ext",
    "content": "full content here"
  }
}
\`\`\``;

    const userPrompt = `Execute this plan now and create all files:\n\n${planMarkdown}`;

    try {
      await this.runToolLoop(systemPrompt, userPrompt, signal);
    } catch (err: any) {
      spinner.stop();
      console.log(chalk.red(`\n✖ Execution failed: ${err.message}\n`));
    } finally {
      spinner.stop();
      this.clearLastPlan();
    }
  }

  async runToolLoop(systemPrompt: string, userPrompt: string, signal?: AbortSignal): Promise<void> {
    let iterations = 0;
    const maxIterations = 15;

    let messages: ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ];

    while (iterations < maxIterations) {
      if (signal?.aborted) break;
      iterations++;
      spinner.start('Thinking & Executing...');

      const invokeOpts: InvokeOptions = {
        messages,
        preferredPool: 'coding',
        temperature: 0.2,
        jsonMode: false,
        signal,
      };

      const result = await this.invoker.invoke(invokeOpts);
      const toolCalls = parseToolCalls(result.content);

      // Handle tool call executions
      if (toolCalls.length > 0) {
        spinner.stop();
        const toolResults = await Promise.all(toolCalls.map((tc) => executeToolCall(tc, 'BUILD')));

        for (let i = 0; i < toolCalls.length; i++) {
          const tc = toolCalls[i];
          const res = toolResults[i];
          if (res) {
            if (res.success) {
              if (tc.name === "write_file" || tc.name === "create_file") {
                const path = tc.arguments.path || (tc.arguments as any).filePath;
                console.log(chalk.green(`✔ Created file: ${chalk.bold(path)}`));
              } else if (tc.name === "execute_command" || tc.name === "run_command" || tc.name === "bash") {
                const cmd = tc.arguments.command || (tc.arguments as any).cmd;
                console.log(chalk.yellow(`✔ Executed: ${chalk.bold(cmd)}`));
              } else if (tc.name === "read_file") {
                const path = tc.arguments.path || (tc.arguments as any).filePath;
                console.log(chalk.cyan(`✔ Read file: ${chalk.bold(path)}`));
              }
            } else {
              console.log(chalk.red(`✖ Error in ${tc.name}: ${res.content}`));
            }
          }
        }

        // Push assistant response and tool execution results back to messages
        messages.push({ role: 'assistant', content: result.content });
        messages.push({
          role: 'user',
          content: `Tool execution results:\n\n${formatToolResults(toolResults)}\n\nContinue with next steps (writing files, running commands, etc.). If all files are generated and tasks are completed, output 'DONE'.`
        });

        // Continue next iteration so the model can write files after reconnaissance
        continue;
      }

      // If model finished without formal tool calls
      spinner.stop();
      if (result.content) {
        const extractedFiles = this.extractCodeBlocksToFiles(result.content);
        if (extractedFiles.length > 0) {
          for (const file of extractedFiles) {
            writeFile(file.name, file.content);
            console.log(chalk.green(`✔ Created file: ${chalk.bold(file.name)}`));
          }
        } else if (!result.content.includes('DONE')) {
          process.stdout.write(result.content + '\n');
        }
      }
      break;
    }
    console.log(chalk.hex('#10B981').bold('\n✨ All files generated successfully!\n'));
  }

  private extractCodeBlocksToFiles(text: string): Array<{ name: string; content: string }> {
    const files: Array<{ name: string; content: string }> = [];

    const annotatedRegex = /(?:(?:\/\*|<!--|\/\/|#+)\s*([\w\d_./-]+\.[\w\d]+)\s*(?:\*\/|-->)?\s*\n)?```(?:html|css|javascript|js|typescript|ts|json|jsx|tsx|python|py|sh|bash)?\s*\n([\s\S]*?)```/gi;

    let match;
    while ((match = annotatedRegex.exec(text)) !== null) {
      let fileName = match[1];
      const content = match[2];

      if (!fileName && content) {
        const firstLineMatch = content.match(/^(?:(?:\/\*|<!--|\/\/|#+)\s*([\w\d_./-]+\.[\w\d]+)\s*(?:\*\/|-->)?)/i);
        if (firstLineMatch && firstLineMatch[1]) {
          fileName = firstLineMatch[1];
        }
      }

      if (fileName && content && content.trim()) {
        files.push({ name: fileName.trim(), content });
      }
    }

    if (files.length === 0) {
      const headerRegex = /(?:`([\w\d_./-]+\.[\w\d]+)`|\*\*([\w\d_./-]+\.[\w\d]+)\*\*|File:\s*`?([\w\d_./-]+\.[\w\d]+)`?)[^\n]*\n+```(?:html|css|javascript|js|typescript|ts|json|jsx|tsx|python|py|sh|bash)?\s*\n([\s\S]*?)```/gi;
      let hMatch;
      while ((hMatch = headerRegex.exec(text)) !== null) {
        const fileName = hMatch[1] || hMatch[2] || hMatch[3];
        const content = hMatch[4];
        if (fileName && content && content.trim()) {
          files.push({ name: fileName.trim(), content });
        }
      }
    }

    return files;
  }

  getRegistry(): ModelRegistry {
    return this.registry;
  }

  setApiKey(apiKey: string, baseURL?: string): void {
    this.invoker = new ModelInvoker(baseURL || 'https://api.freellm.in/v1', apiKey, this.registry);
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
      mode?: AgentMode;
    } = {}
  ): Promise<OrchestratorResult> {
    const mode = opts.mode ?? 'BUILD';
    
    // ── @filepath context injection ──────────────────────────
    const { cleanPrompt, injectedContext, attachedImages } = this.extractFileContext(userPrompt);

    const allImages = [...(opts.images || []), ...attachedImages];
    const hasImages = allImages.length > 0;

    const fullPrompt = injectedContext
      ? `${injectedContext}\n\n---\n\n${cleanPrompt}`
      : cleanPrompt;

    // ── Intent routing (deterministic) ───────────────────────
    let plan = opts.forceModel || opts.forcePool
      ? this.buildForcedPlan(opts.forceModel, opts.forcePool, hasImages)
      : this.router.analyze(fullPrompt, hasImages);

    if (hasImages && plan.task_type !== "image_to_code") {
      plan.task_type = "image_to_code";
      plan.needs_vision = true;
    }

    // ── Mode-specific routing override ────────────────────────
    if (mode === 'PLAN') {
      plan.task_type = "complex_reasoning";
      plan.needs_deep_reasoning = true;
      plan.needs_coding = false;
      plan.needs_vision = false;
      plan.complexity = "high";
    } else if (mode === 'BUILD') {
      plan.task_type = "deep_coding";
      plan.needs_coding = true;
      plan.needs_deep_reasoning = false;
      plan.complexity = "medium";
    }

    // ── Select primary pool and model ────────────────────────
    const pool = this.selectPool(plan);
    const primaryModel = this.getPrimaryModel(pool);
    const poolLabel = POOL_LABELS[pool as PoolName] || pool;

    // ── Display routing badge ────────────────────────────────
    if (!this.quiet) {
      const modeBadge = mode === 'PLAN' ? '\x1b[36m[PLAN]\x1b[0m' : '\x1b[38;2;245;166;35m[BUILD]\x1b[0m';
      const badge = `\x1b[38;2;245;166;35m[◆ M38]\x1b[0m ${modeBadge} Task: ${poolLabel} \x1b[38;2;245;166;35m➔\x1b[0m Primary: ${primaryModel}`;
      process.stdout.write(badge + '\n\n');
      spinner.start('Thinking...');
    }

    // ── Record user message to session ──────────────────────
    sessionManager.addMessage('user', userPrompt);

    // ── PLAN mode override ───────────────────────────────────
    if (mode === 'PLAN') {
      spinner.start('Architecting solution blueprint...');
      const systemPrompt = this.buildSystemPrompt(plan, opts.systemPrompt, 'PLAN');
      const prunedHistory = opts.conversationHistory ? pruneConversation(opts.conversationHistory) : [];
      const messages = this.buildMessages(systemPrompt, fullPrompt, prunedHistory, allImages);

      let fullPlanMarkdown = '';

      const result = await this.invoker.streamCompletion({
        model: primaryModel,
        messages: [
          {
            role: 'system',
            content: `You are a Principal Software Architect. Output a concise, well-structured markdown blueprint:
### 1. Architecture & Tech Stack
### 2. Files to Create/Modify
- \`filename\`: Brief purpose & responsibilities
### 3. Implementation Steps
Keep it scannable with bullet points, short descriptions, and code blocks only where essential.`
          },
          ...messages
        ],
        signal: opts.signal,
        onToken: (chunk) => {
          fullPlanMarkdown += chunk;
        }
      });

      spinner.stop();
      renderPrettyPlan(fullPlanMarkdown);
      this.lastApprovedPlan = fullPlanMarkdown;

      sessionManager.addMessage('assistant', fullPlanMarkdown);

      return {
        plan,
        response: fullPlanMarkdown,
        modelUsed: result.modelUsed,
        poolUsed: result.poolUsed,
        primaryModel,
        attempts: result.attempts,
        totalMs: result.totalMs,
      };
    }

    // ── Pipeline execution ───────────────────────────────────
    if (plan.pipeline && plan.pipeline.length > 0) {
      const result = await this.executePipeline(fullPrompt, plan, { ...opts, images: allImages, mode });
      sessionManager.addMessage('assistant', result.response);
      return result;
    }

    // ── Fusion execution ─────────────────────────────────────
    if (plan.task_type === "complex_reasoning" && plan.complexity === "high") {
      const fusionConfig = this.registry.getConfig().specialModes.fusion;
      if (fusionConfig?.pools) {
        const result = await this.executeFusion(fullPrompt, plan, fusionConfig.pools, { ...opts, images: allImages, mode });
        sessionManager.addMessage('assistant', result.response);
        return result;
      }
    }

    // ── Single model execution (default) ─────────────────────
    const result = await this.executeSingle(fullPrompt, plan, { ...opts, images: allImages, mode });
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
      mode?: AgentMode;
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
      const messages = this.buildMessages(stageSystemPrompt, accumulatedContext, [], opts.images);

      const invokeOpts: InvokeOptions = {
        messages,
        preferredPool: stage.pool,
        temperature: stage.temperature ?? 0.7,
        jsonMode: false,
        signal: opts.signal,
      };

      let result;
      if (isFinal && opts.onStreamChunk) {
        let isFirstToken = true;
        let streamedText = ""; // Reset the stream accumulator buffer before calling
        const poolModel = this.getPrimaryModel(stage.pool);
        result = await this.invoker.streamCompletion({
          model: poolModel,
          messages,
          signal: opts.signal,
          temperature: stage.temperature ?? 0.7,
          onToken: (chunk) => {
            if (isFirstToken) {
              spinner.stop(); // Clears spinner line completely: \r\x1b[2K
              isFirstToken = false;
            }
            streamedText += chunk;
            process.stdout.write(chunk);
            if (opts.onStreamChunk) {
              opts.onStreamChunk(chunk);
            }
          }
        });
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
      mode?: AgentMode;
    }
  ): Promise<OrchestratorResult> {
    const mode = opts.mode ?? 'BUILD';
    const pool = this.selectPool(plan);
    const systemPrompt = this.buildSystemPrompt(plan, opts.systemPrompt, mode);
    const toolPrompt = mode === 'PLAN' ? systemPrompt : systemPrompt + "\n\n" + getToolSystemPrompt();

    const prunedHistory = opts.conversationHistory
      ? pruneConversation(opts.conversationHistory)
      : [];

    let messages = this.buildMessages(toolPrompt, userPrompt, prunedHistory, opts.images);
    const invokeOptsBase: Omit<InvokeOptions, "messages"> = {
      preferredPool: pool,
      temperature: plan.complexity === "low" ? 0.3 : 0.7,
      jsonMode: false,
      signal: opts.signal,
    };

    const MAX_TOOL_ROUNDS = mode === 'PLAN' ? 0 : 5;
    let finalResponse = "";
    let lastModelUsed = "";
    let lastPoolUsed = "";
    let totalAttempts = 0;
    let totalMs = 0;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      if (opts.signal?.aborted) break;

      let result;
      try {
        if (opts.onStreamChunk) {
          result = await this.invokeWithToolInterception(
            { ...invokeOptsBase, messages },
            opts.onStreamChunk
          );
        } else {
          result = await this.invoker.invoke({ ...invokeOptsBase, messages });
        }
      } catch (err: unknown) {
        if (opts.signal?.aborted || (err instanceof Error && (err.name === 'AbortError' || err.message?.includes('aborted')))) {
          const abortErr = err instanceof Error ? err : new Error('Task was aborted.');
          abortErr.name = 'AbortError';
          throw abortErr;
        }
        break;
      }

      totalAttempts += result.attempts;
      totalMs += result.totalMs;
      lastModelUsed = result.modelUsed;
      lastPoolUsed = result.poolUsed;

      const toolCalls = parseToolCalls(result.content);

      if (toolCalls.length === 0) {
        finalResponse = result.content;
        break;
      }

      const toolResults = await Promise.all(toolCalls.map((tc) => executeToolCall(tc, mode)));

      if (!this.quiet) {
        for (let i = 0; i < toolCalls.length; i++) {
          const tc = toolCalls[i];
          const res = toolResults[i];
          if (res && res.success) {
            if (tc.name === "write_file" && tc.arguments.path) {
              const isUpdate = res.content.includes("updated");
              const badgePrefix = isUpdate ? "✔ Updated file:" : "✔ Created file:";
              process.stdout.write(`\n\x1b[32m${badgePrefix} ${tc.arguments.path}\x1b[0m\n`);
            } else if (tc.name === "read_file" && tc.arguments.path) {
              process.stdout.write(`\n\x1b[36m✔ Read file: ${tc.arguments.path}\x1b[0m\n`);
            } else if (tc.name === "execute_command" && tc.arguments.command) {
              process.stdout.write(`\n\x1b[33m✔ Executed: ${tc.arguments.command}\x1b[0m\n`);
            }
          }
        }
      }

      messages = [
        ...messages,
        { role: "assistant" as const, content: result.content },
        { role: "user" as const, content: `Tool execution results:\n\n${formatToolResults(toolResults)}\n\nContinue your work based on these results.` },
      ];

      finalResponse = result.content;
    }

    if (opts.onRouting && !this.quiet) {
      opts.onRouting(lastModelUsed, lastPoolUsed, totalMs);
    }

    return {
      plan,
      response: finalResponse,
      modelUsed: lastModelUsed,
      poolUsed: lastPoolUsed,
      primaryModel: this.getPrimaryModel(pool),
      attempts: totalAttempts,
      totalMs,
    };
  }

  private async invokeWithToolInterception(
    invokeOpts: InvokeOptions,
    onStreamChunk: (chunk: string) => void
  ): Promise<{ content: string; modelUsed: string; poolUsed: string; attempts: number; totalMs: number }> {
    let fullContent = "";
    let inToolCallBlock = false;
    let toolCallBuffer = "";
    let conversationalBuffer = "";
    let isFirstToken = true;
    let streamedText = ""; // Reset stream accumulator buffer

    const model = invokeOpts.preferredModel || this.getPrimaryModel(invokeOpts.preferredPool || "fast");

    const result = await this.invoker.streamCompletion({
      model,
      messages: invokeOpts.messages,
      signal: invokeOpts.signal,
      temperature: invokeOpts.temperature,
      jsonMode: invokeOpts.jsonMode,
      onToken: (chunk) => {
        if (isFirstToken) {
          spinner.stop(); // Clears spinner line completely: \r\x1b[2K
          isFirstToken = false;
        }
        streamedText += chunk;
        fullContent += chunk;

        for (let i = 0; i < chunk.length; i++) {
          const char = chunk[i];
          const remaining = chunk.slice(i);

          if (!inToolCallBlock && remaining.startsWith("```tool_call")) {
            inToolCallBlock = true;
            toolCallBuffer += "```tool_call";
            i += "```tool_call".length - 1;
            continue;
          }

          if (inToolCallBlock) {
            toolCallBuffer += char;
            if (remaining.startsWith("```")) {
              inToolCallBlock = false;
              toolCallBuffer += "```";
              i += "```".length - 1;
            }
            continue;
          }

          conversationalBuffer += char;
          process.stdout.write(char);
          if (onStreamChunk) {
            onStreamChunk(char);
          }
        }
      }
    });

    if (!result.content.trim() && fullContent.trim()) {
      return { ...result, content: fullContent.trim() };
    }
    return result;
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
      mode?: AgentMode;
    }
  ): Promise<OrchestratorResult> {
    const mode = opts.mode ?? 'BUILD';
    const systemPrompt = this.buildSystemPrompt(plan, opts.systemPrompt, mode);
    const messages = this.buildMessages(systemPrompt, userPrompt, opts.conversationHistory, opts.images);

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

  private buildSystemPrompt(plan: ExecutionPlan, custom?: string, mode?: AgentMode): string {
    const taskParts: string[] = [];

    if (mode === 'PLAN') {
      taskParts.push(
        "You are in PLAN MODE - acting as a Senior Software Architect.",
        "",
        "Your task is to analyze the request and produce a detailed implementation blueprint.",
        "DO NOT write any code or execute any tools.",
        "",
        "Output Format:",
        "📋 Architecture & Implementation Plan:",
        "  1. Component Architecture & State Structure",
        "  2. Step-by-step file changes (Files to create/modify)",
        "  3. Edge cases and testing considerations",
        "",
        "💡 Switch to [BUILD] mode (Press Tab) to execute this plan.",
        "",
        "Guidelines:",
        "- Be thorough and specific about file paths and component structure",
        "- Consider existing codebase patterns and conventions",
        "- Identify dependencies and integration points",
        "- Address error handling, testing, and edge cases",
        "- Output ONLY the plan - no conversational filler"
      );
    } else {
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
    history?: ChatCompletionMessageParam[],
    images?: string[]
  ): ChatCompletionMessageParam[] {
    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: systemPrompt },
    ];

    if (history?.length) {
      messages.push(...history);
    }

    if (images && images.length > 0) {
      const contentParts: any[] = [{ type: "text", text: userPrompt }];
      for (const img of images) {
        let base64Data = img;
        if (!img.startsWith("data:")) {
          try {
            const resolvedPath = resolve(process.cwd(), img.replace(/^~/, process.env.HOME || ''));
            if (existsSync(resolvedPath)) {
              const fileBuffer = readFileSync(resolvedPath);
              let ext = extname(resolvedPath).toLowerCase().substring(1);
              if (ext === 'jpg') ext = 'jpeg';
              base64Data = `data:image/${ext};base64,${fileBuffer.toString('base64')}`;
            }
          } catch {}
        }
        contentParts.push({
          type: "image_url",
          image_url: { url: base64Data }
        });
      }
      messages.push({ role: "user", content: contentParts as any });
    } else {
      messages.push({ role: "user", content: userPrompt });
    }
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
