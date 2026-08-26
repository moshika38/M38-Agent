import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { ModelInvoker } from "../models/invoker.js";
import { ExecutionPlanSchema, type ExecutionPlan } from "../models/types.js";
import { logInfo, logWarning, timer } from "../utils/logger.js";

const ROUTER_SYSTEM_PROMPT = `You are an execution plan analyzer. Given a user prompt, output a JSON execution plan.

Rules:
- "direct_fast": Simple questions, quick lookups, short factual answers, simple translations
- "deep_coding": Code generation, debugging, refactoring, architecture design, file modifications
- "image_to_code": User provides an image and wants code/UI built from it
- "complex_reasoning": Multi-step reasoning, planning, analysis, comparisons, math

Set needs_vision=true if the user is asking about or providing images.
Set needs_coding=true if the task involves writing, reviewing, or modifying code.
Set needs_deep_reasoning=true if the task requires multi-step logical analysis.
Set complexity to "low" for trivial tasks, "medium" for standard tasks, "high" for complex multi-part tasks.
Set framework if the user mentions a specific tech (react, flutter) or "general_code" for code without a framework, or "none" for non-code tasks.
Provide a brief 1-sentence summary of what you'll do.

Output ONLY valid JSON matching the schema.`;

export class TaskRouter {
  private invoker: ModelInvoker;

  constructor(invoker: ModelInvoker) {
    this.invoker = invoker;
  }

  async analyze(userPrompt: string, hasImages: boolean = false): Promise<ExecutionPlan> {
    const t = timer();
    logInfo("Analyzing task intent...");

    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: ROUTER_SYSTEM_PROMPT },
      {
        role: "user",
        content: hasImages
          ? `[This request contains image attachments]\n\n${userPrompt}`
          : userPrompt,
      },
    ];

    const result = await this.invoker.invoke({
      messages,
      preferredPool: "fast",
      temperature: 0.1,
      jsonMode: true,
    });

    let plan: ExecutionPlan;
    try {
      const parsed = JSON.parse(result.content);
      plan = ExecutionPlanSchema.parse(parsed);
    } catch {
      logWarning(`Router JSON parse failed, using fallback plan (model: ${result.modelUsed})`);
      plan = this.fallbackPlan(userPrompt, hasImages);
    }

    logInfo(
      `Task classified as ${plan.task_type} (complexity: ${plan.complexity}) in ${t.stop()} via ${result.modelUsed}`
    );
    return plan;
  }

  private fallbackPlan(prompt: string, hasImages: boolean): ExecutionPlan {
    const lower = prompt.toLowerCase();
    const hasCode =
      lower.includes("code") ||
      lower.includes("function") ||
      lower.includes("implement") ||
      lower.includes("debug") ||
      lower.includes("refactor") ||
      lower.includes("class") ||
      lower.includes("api") ||
      lower.includes("component") ||
      /```/.test(prompt);

    if (hasImages) {
      return {
        task_type: "image_to_code",
        needs_vision: true,
        needs_coding: true,
        needs_deep_reasoning: false,
        complexity: "medium",
        summary: "Image-based code generation request",
      };
    }

    if (hasCode) {
      const isComplex =
        lower.includes("architect") ||
        lower.includes("system design") ||
        lower.includes("refactor") ||
        lower.includes("optimiz") ||
        prompt.split("\n").length > 20;
      return {
        task_type: "deep_coding",
        needs_vision: false,
        needs_coding: true,
        needs_deep_reasoning: isComplex,
        complexity: isComplex ? "high" : "medium",
        framework: "general_code",
        summary: "Code generation request",
      };
    }

    const isReasoning =
      lower.includes("analyze") ||
      lower.includes("compare") ||
      lower.includes("explain why") ||
      lower.includes("pros and cons") ||
      lower.includes("step by step") ||
      lower.includes("reason");

    if (isReasoning) {
      return {
        task_type: "complex_reasoning",
        needs_vision: false,
        needs_coding: false,
        needs_deep_reasoning: true,
        complexity: "high",
        summary: "Complex reasoning or analysis request",
      };
    }

    return {
      task_type: "direct_fast",
      needs_vision: false,
      needs_coding: false,
      needs_deep_reasoning: false,
      complexity: "low",
      summary: "Simple direct request",
    };
  }
}
