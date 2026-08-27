export interface ModelPoolConfig {
  vision: string[];
  coding: string[];
  reasoning: string[];
  fast: string[];
}

export const MODEL_POOLS: ModelPoolConfig = {
  coding: [
    'codestral',
    'mistral-large-3',
    'gpt-oss-120b',
    'glm-4.7-flash'
  ],
  reasoning: [
    'cogito-2.1-671b',
    'mistral-medium-3.5',
    'gpt-oss-120b',
    'glm-4.7'
  ],
  vision: [
    'gemini-3.5-flash',
    'llama-4-scout',
    'gemini-2.5-flash'
  ],
  fast: [
    'gpt-oss-120b',
    'glm-4.7-flash',
    'mistral-medium-3.5',
    'qwen3-30b-a3b'
  ]
};

export type PoolName = keyof typeof MODEL_POOLS;

export const POOL_LABELS: Record<PoolName, string> = {
  vision: 'Vision',
  coding: 'Coding',
  reasoning: 'Reasoning',
  fast: 'Fast',
};
