import chalk from "chalk";

export const COLORS = {
  primary: chalk.hex("#F5A623"),
  white: chalk.white.bold,
  muted: chalk.hex("#4B5563"),
  dim: chalk.dim,
  green: chalk.green,
  yellow: chalk.yellow,
  red: chalk.red,
  cyan: chalk.cyan,
  magenta: chalk.magenta,
} as const;

export const BADGES = {
  online: () => chalk.green("● ONLINE"),
  retry: () => chalk.yellow("▲ RETRY"),
  route: () => chalk.hex("#F5A623")("◆ M38 ROUTE"),
  offline: () => chalk.red("● OFFLINE"),
} as const;

export const VERSION = "1.0.0";
export const MODEL_COUNT = 16;

export const BANNER = `
${COLORS.primary("███╗   ███╗██████╗  █████╗")}
${COLORS.primary("████╗ ████║╚════██╗██╔══██╗")}
${COLORS.primary("██╔████╔██║ █████╔╝╚█████╔╝")}  ${COLORS.white("AGENT ORCHESTRATOR")}
${COLORS.primary("██║╚██╔╝██║ ╚═══██╗██╔══██╗")}  ${COLORS.muted(`[ v${VERSION} | Engine: FreeLLMAPI ]`)}
${COLORS.primary("██║ ╚═╝ ██║██████╔╝╚█████╔╝")}  ${COLORS.muted(`[ Status: ${BADGES.online()} | ${MODEL_COUNT} Models Ready ]`)}
${COLORS.primary("╚═╝     ╚═╝╚═════╝  ╚════╝")}  ${COLORS.muted("─────────────────────────────")}
`;

export function renderRouterLine(taskLabel: string, model: string, pool: string): string {
  const tag = chalk.hex("#F5A623")("◆ M38 Router") + COLORS.muted(`: ${taskLabel}`);
  const modelTag = COLORS.muted("→ [") + COLORS.white(model) + COLORS.muted("] via ") + renderPoolBadge(pool);
  return `  ${tag} ${modelTag}`;
}

export function renderStreamingBadge(): string {
  return `  ${COLORS.cyan("◆")} ${COLORS.white("Streaming...")}`;
}

export function renderDoneBadge(model: string, pool: string, ms: number, attempts: number): string {
  const time = ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`;
  return `  ${COLORS.green("✔")} ${COLORS.muted(`Done in ${time}`)} ${COLORS.muted("via")} ${COLORS.white(model)} ${COLORS.muted("via")} ${renderPoolBadge(pool)} ${COLORS.muted(`(${attempts} attempt${attempts > 1 ? "s" : ""})`)}`;
}

export function renderErrorBadge(msg: string): string {
  return `  ${COLORS.red("✖ Error:")} ${msg}`;
}

export function renderPoolBadge(pool: string): string {
  const map: Record<string, () => string> = {
    vision: () => COLORS.primary("◆ Vision"),
    coding: () => COLORS.cyan("◆ Coding"),
    fast: () => COLORS.green("◆ Fast"),
    reasoning: () => COLORS.magenta("◆ Reasoning"),
    fusion: () => COLORS.yellow("◆ Fusion"),
  };
  return (map[pool] ?? (() => COLORS.dim(`◆ ${pool}`)))();
}

export function renderTaskTypeLabel(taskType: string): string {
  const map: Record<string, string> = {
    direct_fast: "Fast Query",
    deep_coding: "Coding Task",
    image_to_code: "Vision → Code",
    complex_reasoning: "Deep Reasoning",
  };
  return map[taskType] ?? taskType;
}

export function clearScreen(): void {
  process.stdout.write("\x1B[2J\x1B[0f");
}

export function renderPrompt(): void {
  process.stdout.write(COLORS.primary("m38") + COLORS.muted(" > "));
}
