import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { ModelInvoker } from "../models/invoker.js";
import { ExecutionPlanSchema, type ExecutionPlan } from "../models/types.js";

const ROUTER_SYSTEM_PROMPT = `You are a task classifier. Given a user prompt, output EXACTLY a single raw JSON object — no markdown, no code fences, no explanation, no extra text before or after.

Schema:
{"task_type":"direct_fast|deep_coding|image_to_code|complex_reasoning","needs_vision":bool,"needs_coding":bool,"needs_deep_reasoning":bool,"complexity":"low|medium|high","framework":"react|flutter|general_code|none","summary":"string"}

Rules for task_type:
- "direct_fast": Simple questions, quick lookups, factual answers, translations
- "deep_coding": Code generation, debugging, refactoring, architecture
- "image_to_code": User provides an image and wants code/UI built from it
- "complex_reasoning": Multi-step reasoning, planning, analysis, comparisons

Rules for fields:
- needs_vision=true if the user is asking about or providing images
- needs_coding=true if the task involves writing, reviewing, or modifying code
- needs_deep_reasoning=true if the task requires multi-step logical analysis
- complexity: "low" for trivial, "medium" for standard, "high" for complex multi-part
- framework: pick the named tech if mentioned, "general_code" for generic code, "none" for non-code
- summary: one short sentence describing what will be done

Output ONLY the raw JSON object. Nothing else.`;

export class TaskRouter {
  private invoker: ModelInvoker;

  constructor(invoker: ModelInvoker) {
    this.invoker = invoker;
  }

  async analyze(userPrompt: string, hasImages: boolean = false): Promise<ExecutionPlan> {
    // Fast-path: skip LLM routing call for short, obvious prompts
    if (!hasImages && userPrompt.length < 80) {
      const lower = userPrompt.toLowerCase().trim();
      const hasCode =
        /```/.test(userPrompt) ||
        /\b(function|class|const |import |def |fn |pub |flutter|react|bug|error|fix|implement|refactor|debug)\b/.test(userPrompt);
      if (!hasCode) {
        const isGreeting = /^(hi|hello|hey|yo|sup|thanks|thank you|bye|quit|ok|yes|no)\s*[!.?]*$/i.test(lower);
        if (isGreeting || userPrompt.trim().split(/\s+/).length <= 12) {
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
    }

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
      const cleanJson = result.content.replace(/```json\n?|```/g, "").trim();
      const parsed = JSON.parse(cleanJson);
      plan = ExecutionPlanSchema.parse(parsed);
    } catch {
      plan = this.fallbackPlan(userPrompt, hasImages);
    }

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
