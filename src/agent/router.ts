import type { ExecutionPlan } from "../models/types.js";

const IMAGE_EXT = /\.(png|jpe?g|webp|svg|gif|bmp)$/i;
const CODE_EXT = /\.(ts|tsx|js|jsx|dart|py|rb|go|rs|java|kt|json|yaml|yml|toml|html|css|scss|sh|sql)$/i;

const VISION_KEYWORDS = /\b(screenshot|ui design|mockup|wireframe|layout|界面|截图|设计图)\b/i;

const CODING_KEYWORDS = /\b(function|class|const |import |export |def |fn |pub |async |await |return |flutter|widget|react|vue|angular|bug|error|fix|implement|refactor|debug|component|typescript|dart|python|javascript|api|endpoint|sql|query|database schema|algorithm|compile|build|test|lint|deploy|npm|pub |cargo |pip )\b/i;
const CODE_BLOCK = /```/;

const REASONING_KEYWORDS = /\b(analyze|compare|explain why|pros and cons|step by step|reason|architecture|system design|database schema|design pattern|trade.?off|evaluate|complex algorithm|proof|logic|multi.?step|plan|strategy|break down|deep dive|thorough|comprehensive|elaborate|detailed analysis)\b/i;

const FAST_KEYWORDS = /^(hi|hello|hey|yo|sup|thanks|thank you|bye|quit|ok|yes|no|what is|who is|when|where|how to|define|meaning of|translate|summarize|list|name)\s/i;

export class TaskRouter {
  analyze(userPrompt: string, hasImages: boolean = false): ExecutionPlan {
    const lower = userPrompt.toLowerCase();
    const wordCount = userPrompt.trim().split(/\s+/).length;

    // ── Vision tier ──────────────────────────────────────────
    if (hasImages || IMAGE_EXT.test(userPrompt) || VISION_KEYWORDS.test(userPrompt)) {
      const hasCodeInImageRequest = CODING_KEYWORDS.test(userPrompt) || CODE_BLOCK.test(userPrompt);
      return {
        task_type: "image_to_code",
        needs_vision: true,
        needs_coding: hasCodeInImageRequest,
        needs_deep_reasoning: false,
        complexity: hasCodeInImageRequest ? "medium" : "low",
        summary: "Image analysis request",
      };
    }

    // ── Coding tier ──────────────────────────────────────────
    const hasCode = CODE_BLOCK.test(userPrompt) || CODING_KEYWORDS.test(userPrompt) || CODE_EXT.test(userPrompt);
    if (hasCode) {
      const isComplex =
        REASONING_KEYWORDS.test(userPrompt) ||
        lower.includes("architect") ||
        lower.includes("system design") ||
        lower.includes("refactor") ||
        lower.includes("optimiz") ||
        userPrompt.split("\n").length > 20 ||
        wordCount > 60;

      const framework = this.detectFramework(lower);

      return {
        task_type: "deep_coding",
        needs_vision: false,
        needs_coding: true,
        needs_deep_reasoning: isComplex,
        complexity: isComplex ? "high" : "medium",
        framework,
        summary: "Code generation or modification request",
      };
    }

    // ── Reasoning tier ───────────────────────────────────────
    if (REASONING_KEYWORDS.test(userPrompt) || wordCount > 50) {
      return {
        task_type: "complex_reasoning",
        needs_vision: false,
        needs_coding: false,
        needs_deep_reasoning: true,
        complexity: wordCount > 80 ? "high" : "medium",
        summary: "Complex analysis or reasoning request",
      };
    }

    // ── Fast tier (default) ──────────────────────────────────
    const isTrivial = wordCount <= 12 || FAST_KEYWORDS.test(userPrompt);
    return {
      task_type: "direct_fast",
      needs_vision: false,
      needs_coding: false,
      needs_deep_reasoning: false,
      complexity: isTrivial ? "low" : "medium",
      summary: "Quick query or direct answer",
    };
  }

  private detectFramework(lower: string): "react" | "flutter" | "general_code" | "none" {
    if (/\b(react|next\.?js|jsx|tsx)\b/.test(lower)) return "react";
    if (/\b(flutter|dart|widget|material|cupertino)\b/.test(lower)) return "flutter";
    return "general_code";
  }
}
