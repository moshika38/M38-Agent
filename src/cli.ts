import 'dotenv/config';
import readline from 'node:readline';
import chalk from 'chalk';
import { Orchestrator } from './agent/orchestrator.js';
import { M38_BANNER } from './utils/banner.js';
import { sessionManager } from './session/manager.js';

function getConfig() {
  const baseURL = process.env.FREELLM_BASE_URL || 'http://localhost:3001/v1';
  const apiKey = process.env.FREELLM_API_KEY;
  if (!apiKey) {
    console.error(
      '\n  ' + chalk.red('✖ FREELLM_API_KEY is required.') +
        '\n  ' + chalk.gray('Set it in your .env file or export it:') +
        '\n  ' + chalk.gray('  export FREELLM_API_KEY=your-key') +
        '\n  ' + chalk.gray('  export FREELLM_BASE_URL=http://localhost:3001/v1  (optional)') +
        '\n'
    );
    process.exit(1);
  }
  return { baseURL, apiKey };
}

function renderHeader() {
  process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
  console.log(M38_BANNER);
  console.log(chalk.gray('  Commands: /exit | /clear | /pools | /new | /help\n'));
}

const config = getConfig();
const orchestrator = new Orchestrator({ ...config, quiet: true });
let currentAbortController: AbortController | null = null;
let isRunning = false;
let escWarningTimer: NodeJS.Timeout | null = null;

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: true,
});

readline.emitKeypressEvents(process.stdin);
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
}

process.stdin.on('keypress', (_, key) => {
  if (key && key.name === 'escape' && isRunning && currentAbortController) {
    if (escWarningTimer) {
      clearTimeout(escWarningTimer);
      escWarningTimer = null;
      currentAbortController.abort();
    } else {
      process.stdout.write(chalk.yellow('\n[Press ESC again within 2s to cancel current task]'));
      escWarningTimer = setTimeout(() => {
        escWarningTimer = null;
      }, 2000);
    }
  }
});

function askPrompt() {
  const activeSession = sessionManager.getActiveSession();
  const sessionTitle = activeSession ? activeSession.title : 'New Session';
  const promptStr = chalk.hex('#F5A623')(`m38 [${sessionTitle}] > `);

  rl.question(promptStr, async (rawInput) => {
    const input = rawInput.trim();

    if (!input) {
      return askPrompt();
    }

    if (input === '/exit' || input === 'exit' || input === ':q' || input === 'quit') {
      console.log(chalk.gray('\nExiting M38 Agent Orchestrator. Bye!\n'));
      process.exit(0);
    }

    if (input === '/clear' || input === 'clear') {
      renderHeader();
      return askPrompt();
    }

    if (input === '/new') {
      sessionManager.createNewSession();
      console.log(chalk.green('✔ Started new session.\n'));
      return askPrompt();
    }

    if (input === '/pools') {
      console.log(chalk.hex('#F5A623')('\n◆ Active Model Pools:'));
      console.log(chalk.gray('  • Vision:    gemini-3.5-flash, gemini-2.5-flash'));
      console.log(chalk.gray('  • Coding:    qwen3-coder-480b, devstral-2-123b'));
      console.log(chalk.gray('  • Fast:      gemini-3.1-flash-lite-preview, glm-4.7-flash'));
      console.log(chalk.gray('  • Reasoning: cogito-2.1-671b, gpt-oss-120b\n'));
      return askPrompt();
    }

    if (input === '/help') {
      console.log(chalk.cyan('\nAvailable Commands:'));
      console.log('  /exit   - Quit the tool');
      console.log('  /clear  - Clear terminal screen');
      console.log('  /pools  - View model registry');
      console.log('  /new    - Start a fresh session\n');
      return askPrompt();
    }

    isRunning = true;
    currentAbortController = new AbortController();

    try {
      process.stdout.write(chalk.gray('⠋ thinking...\r'));

      let isFirstChunk = true;
      await orchestrator.process(input, {
        signal: currentAbortController.signal,
        onStreamChunk: (chunk: string) => {
          if (isFirstChunk) {
            readline.clearLine(process.stdout, 0);
            readline.cursorTo(process.stdout, 0);
            isFirstChunk = false;
          }
          process.stdout.write(chunk);
        },
      });

      process.stdout.write('\n\n');
    } catch (err: any) {
      if (err.name === 'AbortError') {
        console.log(chalk.red('\n✖ Task cancelled.\n'));
      } else {
        console.log(chalk.red(`\n✖ Error: ${err.message}\n`));
      }
    } finally {
      isRunning = false;
      currentAbortController = null;
      askPrompt();
    }
  });
}

process.on('SIGINT', () => {
  console.log(chalk.gray('\nExiting M38 Agent Orchestrator. Bye!\n'));
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  console.error(chalk.red('Fatal: ') + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});

renderHeader();
askPrompt();
