export interface ModelPoolConfig {
  vision: string[];
  coding: string[];
  reasoning: string[];
  fast: string[];
}

export const MODEL_POOLS: ModelPoolConfig = {
  vision: [
    'gemini-3.5-flash',
    'gemini-3-flash-preview',
    'llama-4-scout',
    'gemini-2.5-flash'
  ],
  coding: [
    'qwen3-coder-next',
    'qwen3-coder-480b',
    'devstral-2-123b',
    'codestral'
  ],
  reasoning: [
    'cogito-2.1-671b',
    'deepseek-v4-pro',
    'minimax-m2.7',
    'kimi-k2.6'
  ],
  fast: [
    'gpt-oss-120b',
    'glm-4.7-flash',
    'qwen3-30b-a3b-fp8',
    'mistral-medium-3.5'
  ]
};

export type PoolName = keyof typeof MODEL_POOLS;

export const POOL_LABELS: Record<PoolName, string> = {
  vision: 'Vision',
  coding: 'Coding',
  reasoning: 'Reasoning',
  fast: 'Fast',
};
