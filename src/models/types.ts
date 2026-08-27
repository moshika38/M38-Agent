import { z } from "zod";

export const PipelineStageSchema = z.object({
  id: z.string(),
  pool: z.string(),
  systemPrompt: z.string(),
  temperature: z.number().optional().default(0.7),
});
export type PipelineStage = z.infer<typeof PipelineStageSchema>;

export const ExecutionPlanSchema = z.object({
  task_type: z.enum(["direct_fast", "deep_coding", "image_to_code", "complex_reasoning"]),
  needs_vision: z.boolean(),
  needs_coding: z.boolean(),
  needs_deep_reasoning: z.boolean(),
  complexity: z.enum(["low", "medium", "high"]),
  framework: z.enum(["react", "flutter", "general_code", "none"]).optional(),
  summary: z.string(),
  pipeline: z.array(PipelineStageSchema).optional(),
});
export type ExecutionPlan = z.infer<typeof ExecutionPlanSchema>;

export const ConversationMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.union([z.string(), z.array(z.any())]),
});
export type ConversationMessage = z.infer<typeof ConversationMessageSchema>;

export interface OrchestratorResult {
  plan: ExecutionPlan;
  response: string;
  modelUsed: string;
  poolUsed: string;
  primaryModel: string;
  attempts: number;
  totalMs: number;
  fusionResults?: FusionResult[];
}

export interface FusionResult {
  pool: string;
  modelUsed: string;
  response: string;
  attempts: number;
}
