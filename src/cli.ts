#!/usr/bin/env node
import "dotenv/config";
import chalk from "chalk";
import { existsSync } from "node:fs";
import { resolve, basename } from "node:path";
import { Orchestrator } from "./agent/orchestrator.js";
import {
  COLORS,
  BANNER,
  BADGES,
  VERSION,
  clearScreen,
  renderPrompt,
  renderRouterLine,
  renderStreamingBadge,
  renderDoneBadge,
  renderErrorBadge,
  renderTaskTypeLabel,
} from "./tui/branding.js";
import { showPools } from "./tui/handlers/pools.js";

const IMAGE_EXT = /\.(png|jpg|jpeg|webp|gif|bmp|tiff|svg)$/i;

function getConfig() {
  const baseURL = process.env.FREELLM_BASE_URL || "http://localhost:3001/v1";
  const apiKey = process.env.FREELLM_API_KEY;
  if (!apiKey) {
    console.error(
      "\n  " + COLORS.red("✖ FREELLM_API_KEY is required.") +
        "\n  " + COLORS.dim("Set it in your .env file or export it:") +
        "\n  " + COLORS.dim("  export FREELLM_API_KEY=your-key") +
        "\n  " + COLORS.dim("  export FREELLM_BASE_URL=http://localhost:3001/v1  (optional)") +
        "\n"
    );
    process.exit(1);
  }
  return { baseURL, apiKey };
}

function detectImagePaths(input: string): string[] {
  const words = input.split(/\s+/);
  const found: string[] = [];
  for (const word of words) {
    if (IMAGE_EXT.test(word) && existsSync(resolve(word))) {
      found.push(resolve(word));
    }
  }
  return found;
}

function renderBanner(): void {
  clearScreen();
  console.log(BANNER);
  console.log(
    "  " + COLORS.muted("Type /exit or exit to quit. /pools to inspect model registry.")
  );
  console.log(
    "  " + COLORS.muted("Drag/drop or type an image path for vision → code pipeline.")
  );
  console.log();
}

function printHelp(): void {
  console.log(
    "\n  " + COLORS.white("m38") + " — " + COLORS.muted("M38 Agent Orchestrator & Smart Model Router") +
    "\n\n  " + COLORS.white("Usage:") +
      "\n    " + COLORS.dim("m38") + "              " + COLORS.muted("Launch interactive auto-routing chat") +
      "\n    " + COLORS.dim("m38 --help") + "     " + COLORS.muted("Show this help message") +
      "\n    " + COLORS.dim("m38 --version") + "  " + COLORS.muted("Show version") +
    "\n\n  " + COLORS.white("Interactive Commands:") +
      "\n    " + COLORS.dim("/pools") + "    " + COLORS.muted("View active model pools & registry") +
      "\n    " + COLORS.dim("/clear") + "    " + COLORS.muted("Clear screen and reprint banner") +
      "\n    " + COLORS.dim("/exit") + "     " + COLORS.muted("Exit the application") +
      "\n    " + COLORS.dim("/help") + "     " + COLORS.muted("Show interactive help") +
    "\n\n  " + COLORS.white("Features:") +
      "\n    " + COLORS.muted("• Auto-routes all queries to optimal model pool") +
      "\n    " + COLORS.muted("• Paste/type image paths for vision → code pipeline") +
      "\n    " + COLORS.muted("• Streaming responses with fallback resilience") +
      "\n    " + COLORS.muted("• Fusion mode for complex multi-pool reasoning") +
      "\n"
  );
}

function printVersion(): void {
  console.log(`m38 v${VERSION}`);
}

async function main() {
  const config = getConfig();
  const orchestrator = new Orchestrator({ ...config, quiet: true });

  renderBanner();
  renderPrompt();

  const readline = await import("node:readline");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  let processing = false;

  const processInput = async (input: string): Promise<void> => {
    if (processing) return;
    processing = true;

    const imagePaths = detectImagePaths(input);

    try {
      if (imagePaths.length > 0) {
        console.log(
          renderRouterLine("Vision → Code", "gemini-3.5-flash", "vision")
        );
        console.log(
          "  " + COLORS.muted(`Detected: ${imagePaths.map((p) => basename(p)).join(", ")}`)
        );
        console.log(renderStreamingBadge());

        const result = await orchestrator.process(input, {
          images: imagePaths,
          forcePool: "vision",
          onStreamChunk: (chunk) => process.stdout.write(COLORS.white(chunk)),
        });

        console.log("\n");
        console.log(renderDoneBadge(result.modelUsed, result.poolUsed, result.totalMs, result.attempts));
        console.log(COLORS.muted(`  ${BADGES.online()}\n`));
        console.log(COLORS.white.bold("Response:"));
        console.log(COLORS.muted("─".repeat(60)));
        console.log(result.response);
        console.log(COLORS.muted("─".repeat(60)));
      } else {
        console.log(renderStreamingBadge());

        const result = await orchestrator.process(input, {
          onStreamChunk: (chunk) => process.stdout.write(COLORS.white(chunk)),
        });

        const taskLabel = renderTaskTypeLabel(result.plan.task_type);

        console.log("\n");
        console.log(renderRouterLine(taskLabel, result.modelUsed, result.poolUsed));
        console.log(renderDoneBadge(result.modelUsed, result.poolUsed, result.totalMs, result.attempts));
        console.log(COLORS.muted(`  ${BADGES.online()}\n`));
        console.log(COLORS.white.bold("Response:"));
        console.log(COLORS.muted("─".repeat(60)));
        console.log(result.response);
        console.log(COLORS.muted("─".repeat(60)));
      }
    } catch (err) {
      console.log("\n" + renderErrorBadge(err instanceof Error ? err.message : "Unknown error"));
    }

    console.log();
    processing = false;
    renderPrompt();
  };

  rl.on("line", (line: string) => {
    const input = line.trim();

    if (!input || processing) {
      if (!processing) renderPrompt();
      return;
    }

    const lower = input.toLowerCase();

    if (lower === "/exit" || lower === "/quit" || lower === "/q" || lower === "exit" || lower === "quit") {
      console.log(
        "\n  " + COLORS.primary("M38") + COLORS.muted(" Agent Orchestrator") +
          COLORS.muted(" — shutting down.") + "\n"
      );
      rl.close();
      process.exit(0);
    }

    if (lower === "/pools") {
      showPools(orchestrator.getRegistry());
      renderPrompt();
      return;
    }

    if (lower === "/clear") {
      renderBanner();
      renderPrompt();
      return;
    }

    if (lower === "/help" || lower === "?") {
      console.log(
        "\n  " + COLORS.white("Commands:") +
          "\n  " + COLORS.dim("/pools") + "    " + COLORS.muted("View active model pools & registry") +
          "\n  " + COLORS.dim("/clear") + "    " + COLORS.muted("Clear screen and reprint banner") +
          "\n  " + COLORS.dim("/exit") + "     " + COLORS.muted("Exit the application") +
          "\n  " + COLORS.dim("/help") + "     " + COLORS.muted("Show this help") +
          "\n\n  " + COLORS.muted("Paste or type an image path for the vision → code pipeline.") +
          "\n  " + COLORS.muted("All queries are auto-routed to the optimal model pool.") +
          "\n"
      );
      renderPrompt();
      return;
    }

    processInput(input);
  });

  rl.on("close", () => process.exit(0));
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  printHelp();
} else if (args.includes("--version") || args.includes("-V")) {
  printVersion();
} else {
  main().catch((err) => {
    console.error(chalk.red("Fatal: ") + (err instanceof Error ? err.message : String(err)));
    process.exit(1);
  });
}
