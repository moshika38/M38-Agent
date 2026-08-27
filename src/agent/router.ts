import { MODEL_POOLS } from '../config/models.js';
import type { ExecutionPlan } from '../models/types.js';

export type TaskTier = 'vision' | 'coding' | 'reasoning' | 'fast';

const CODING_REGEX = /\b(code|coding|script|js|ts|javascript|typescript|dart|flutter|python|html|css|react|vue|node|function|class|api|endpoint|sql|database|query|debug|fix|refactor|animation|component|algorithm|widget|json|regex|write|create|build|implement|generate|snippet|program)\b/i;
const REASONING_REGEX = /\b(architecture|system design|schema|benchmark|compare deep|step by step proof|math proof|complex logic|trade.?off|design pattern|strategy)\b/i;

export function classifyIntent(prompt: string, hasImageAttachment: boolean = false): { tier: TaskTier; primaryModel: string; fallbackPool: string[] } {
  if (hasImageAttachment) {
    return { tier: 'vision', primaryModel: MODEL_POOLS.vision[0]!, fallbackPool: MODEL_POOLS.vision.slice(1) };
  }

  if (CODING_REGEX.test(prompt)) {
    return { tier: 'coding', primaryModel: MODEL_POOLS.coding[0]!, fallbackPool: [...MODEL_POOLS.coding.slice(1), ...MODEL_POOLS.fast] };
  }

  if (REASONING_REGEX.test(prompt)) {
    return { tier: 'reasoning', primaryModel: MODEL_POOLS.reasoning[0]!, fallbackPool: [...MODEL_POOLS.reasoning.slice(1), ...MODEL_POOLS.fast] };
  }

  return { tier: 'fast', primaryModel: MODEL_POOLS.fast[0]!, fallbackPool: MODEL_POOLS.fast.slice(1) };
}

function detectFramework(lower: string): "react" | "flutter" | "general_code" | "none" {
  if (/\b(react|next\.?js|jsx|tsx)\b/.test(lower)) return "react";
  if (/\b(flutter|dart|widget|material|cupertino)\b/.test(lower)) return "flutter";
  return "general_code";
}

export class TaskRouter {
  analyze(userPrompt: string, hasImages: boolean = false): ExecutionPlan {
    const intent = classifyIntent(userPrompt, hasImages);
    const lower = userPrompt.toLowerCase();
    const wordCount = userPrompt.trim().split(/\s+/).length;

    const isComplex =
      intent.tier === 'reasoning' ||
      lower.includes("architect") ||
      lower.includes("system design") ||
      lower.includes("refactor") ||
      lower.includes("optimiz") ||
      wordCount > 50;

    const framework = intent.tier === 'coding' ? detectFramework(lower) : "none";

    switch (intent.tier) {
      case 'vision':
        return {
          task_type: "image_to_code",
          needs_vision: true,
          needs_coding: CODING_REGEX.test(userPrompt),
          needs_deep_reasoning: false,
          complexity: "medium",
          summary: "Image analysis request",
        };
      case 'coding':
        return {
          task_type: "deep_coding",
          needs_vision: false,
          needs_coding: true,
          needs_deep_reasoning: isComplex,
          complexity: isComplex ? "high" : "medium",
          framework,
          summary: "Code generation or modification request",
        };
      case 'reasoning':
        return {
          task_type: "complex_reasoning",
          needs_vision: false,
          needs_coding: false,
          needs_deep_reasoning: true,
          complexity: wordCount > 80 ? "high" : "medium",
          summary: "Complex analysis or reasoning request",
        };
      default:
        return {
          task_type: "direct_fast",
          needs_vision: false,
          needs_coding: false,
          needs_deep_reasoning: false,
          complexity: wordCount <= 12 ? "low" : "medium",
          summary: "Quick query or direct answer",
        };
    }
  }
}
