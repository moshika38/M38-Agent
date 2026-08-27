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

export function renderRoutingBadge(taskLabel: string, model: string, _pool: string, ms: number): string {
  const time = ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`;
  return `  ${COLORS.muted("[")}${COLORS.primary("◆ M38")}${COLORS.muted("]")} ${COLORS.white(taskLabel)} ${COLORS.muted("➔")} ${COLORS.white(model)} ${COLORS.muted(`(${time})`)}`;
}

export function renderDivider(): string {
  return COLORS.muted("  " + "─".repeat(56));
}

export function renderErrorBadge(msg: string): string {
  return `  ${COLORS.red("✖")} ${msg}`;
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

export function enterAlternateBuffer(): void {
  process.stdout.write("\x1b[?1049h\x1b[H\x1b[2J");
}

export function leaveAlternateBuffer(): void {
  process.stdout.write("\x1b[?1049l");
}

export function clearScreen(): void {
  process.stdout.write("\x1b[2J\x1b[H");
}

export function renderPrompt(): void {
  process.stdout.write(COLORS.primary("m38") + COLORS.muted(" > "));
}
