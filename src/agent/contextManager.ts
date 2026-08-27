import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

const CHARS_PER_TOKEN = 4;
const DEFAULT_MAX_TOKENS = 32000;
const KEEP_RECENT_TURNS = 6;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function messageTokens(msg: ChatCompletionMessageParam): number {
  if (typeof msg.content === "string") {
    return estimateTokens(msg.content);
  }
  if (Array.isArray(msg.content)) {
    return msg.content.reduce((sum, part) => {
      if ("text" in part) return sum + estimateTokens(part.text);
      return sum + 100;
    }, 0);
  }
  return 20;
}

export function pruneConversation(
  messages: ChatCompletionMessageParam[],
  maxTokens: number = DEFAULT_MAX_TOKENS
): ChatCompletionMessageParam[] {
  if (messages.length === 0) return messages;

  let totalTokens = 0;
  for (const msg of messages) {
    totalTokens += messageTokens(msg);
  }

  if (totalTokens <= maxTokens) {
    return messages;
  }

  const systemMessages: ChatCompletionMessageParam[] = [];
  const otherMessages: ChatCompletionMessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      systemMessages.push(msg);
    } else {
      otherMessages.push(msg);
    }
  }

  if (otherMessages.length <= KEEP_RECENT_TURNS) {
    return messages;
  }

  const keepRecent = otherMessages.slice(-KEEP_RECENT_TURNS);
  const summarizeThese = otherMessages.slice(0, -KEEP_RECENT_TURNS);

  const summary = summarizeMessages(summarizeThese);

  const systemTokens = systemMessages.reduce((s, m) => s + messageTokens(m), 0);
  const recentTokens = keepRecent.reduce((s, m) => s + messageTokens(m), 0);
  const summaryTokens = estimateTokens(summary);

  let prunedSystem: ChatCompletionMessageParam[] = [];
  if (systemMessages.length > 0) {
    const lastSystem = systemMessages[systemMessages.length - 1]!;
    if (typeof lastSystem.content === "string") {
      prunedSystem = [{ ...lastSystem, content: lastSystem.content.slice(0, 2000) }];
    } else {
      prunedSystem = [lastSystem];
    }
  }

  if (systemTokens + summaryTokens + recentTokens > maxTokens) {
    const availableForRecent = maxTokens - systemTokens - summaryTokens;
    const reducedRecent: ChatCompletionMessageParam[] = [];
    let tokensUsed = 0;

    for (let i = keepRecent.length - 1; i >= 0; i--) {
      const msgTokens = messageTokens(keepRecent[i]!);
      if (tokensUsed + msgTokens > availableForRecent) break;
      reducedRecent.unshift(keepRecent[i]!);
      tokensUsed += msgTokens;
    }

    return [
      ...prunedSystem,
      { role: "system" as const, content: `[System Context: Previous conversation summary]\n${summary}` },
      ...reducedRecent,
    ];
  }

  return [
    ...prunedSystem,
    { role: "system" as const, content: `[System Context: Previous conversation summary]\n${summary}` },
    ...keepRecent,
  ];
}

function summarizeMessages(messages: ChatCompletionMessageParam[]): string {
  const parts: string[] = [];

  for (const msg of messages) {
    const content = typeof msg.content === "string" ? msg.content : "[complex content]";
    const preview = content.length > 300 ? content.slice(0, 300) + "..." : content;
    parts.push(`${msg.role}: ${preview}`);
  }

  if (parts.length === 0) return "No previous context.";

  if (parts.length <= 3) {
    return parts.join("\n");
  }

  const first = parts[0];
  const last = parts[parts.length - 1];
  const middle = parts.slice(1, -1).map((p) => {
    const truncated = p.length > 150 ? p.slice(0, 150) + "..." : p;
    return truncated;
  });

  return [
    first,
    `[... ${middle.length} earlier messages omitted ...]`,
    ...middle.slice(-2),
    last,
  ].join("\n");
}

export function buildToolConversation(
  systemPrompt: string,
  userMessage: string,
  history: ChatCompletionMessageParam[],
  toolResults: ChatCompletionMessageParam[]
): ChatCompletionMessageParam[] {
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
  ];

  const pruned = pruneConversation([...history, ...toolResults]);
  for (const msg of pruned) {
    if (msg.role !== "system") {
      messages.push(msg);
    }
  }

  messages.push({ role: "user", content: userMessage });
  return messages;
}
