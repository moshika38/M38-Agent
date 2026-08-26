import chalk from "chalk";

export function logInfo(msg: string): void {
  console.log(chalk.blue("ℹ") + " " + msg);
}

export function logSuccess(msg: string): void {
  console.log(chalk.green("✔") + " " + msg);
}

export function logWarning(msg: string): void {
  console.log(chalk.yellow("⚠") + " " + msg);
}

export function logError(msg: string): void {
  console.error(chalk.red("✖") + " " + msg);
}

export function logStep(step: number, total: number, msg: string): void {
  const tag = chalk.cyan(`[${step}/${total}]`);
  console.log(`${tag} ${msg}`);
}

export function logModelSwitch(from: string, to: string, reason: string): void {
  console.log(
    chalk.yellow("⟳") +
      ` Fallback: ${chalk.red(from)} → ${chalk.green(to)} (${reason})`
  );
}

export function timer(): { elapsed: () => number; stop: () => string } {
  const start = performance.now();
  return {
    elapsed: () => Math.round(performance.now() - start),
    stop: () => {
      const ms = Math.round(performance.now() - start);
      return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`;
    },
  };
}
