import 'dotenv/config';
import readline from 'node:readline';
import chalk from 'chalk';
import { Orchestrator } from './agent/orchestrator.js';
import { M38_BANNER } from './utils/banner.js';
import { sessionManager } from './session/manager.js';
import { MODEL_POOLS } from './config/models.js';


const orchestrator = new Orchestrator({
  baseURL: process.env.FREELLM_BASE_URL || 'http://localhost:3001/v1',
  apiKey: process.env.FREELLM_API_KEY || '',
});


const COMMANDS = [
  { cmd: '/exit', desc: 'Quit M38 Agent Orchestrator' },
  { cmd: '/clear', desc: 'Clear terminal screen and history' },
  { cmd: '/pools', desc: 'Inspect active model pools' },
  { cmd: '/new', desc: 'Start a fresh conversation session' },
  { cmd: '/sessions', desc: 'Browse, switch and delete saved sessions' },
  { cmd: '/help', desc: 'View available commands guide' }
];


let inputBuffer = '';
let selectedCmdIdx = 0;
let lastPopupLineCount = 0;

let isBrowsingSessions = false;
let sessionCursorIdx = 0;
let lastSessionViewLineCount = 0;

let isExecuting = false;
let currentAbortController: AbortController | null = null;
let escTimer: NodeJS.Timeout | null = null;


const PROMPT_LABEL = chalk.hex('#F5A623')('Ask anything > ');
const PROMPT_RAW = 'Ask anything > ';


function resetScreen() {
  process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
  console.log(M38_BANNER);
  console.log(chalk.gray('  Type / for commands, @ for files. Type /exit to quit.\n'));
}


function getCmdMatches() {
  if (!inputBuffer.startsWith('/')) return [];
  const q = inputBuffer.toLowerCase();
  return COMMANDS.filter(c => c.cmd.toLowerCase().startsWith(q));
}


function erasePopupLines() {
  if (lastPopupLineCount > 0) {
    for (let i = 0; i < lastPopupLineCount; i++) {
      readline.moveCursor(process.stdout, 0, 1);
      readline.clearLine(process.stdout, 0);
    }
    readline.moveCursor(process.stdout, 0, -lastPopupLineCount);
    lastPopupLineCount = 0;
  }
}


function eraseSessionModal() {
  if (lastSessionViewLineCount > 0) {
    for (let i = 0; i < lastSessionViewLineCount; i++) {
      readline.moveCursor(process.stdout, 0, 1);
      readline.clearLine(process.stdout, 0);
    }
    readline.moveCursor(process.stdout, 0, -lastSessionViewLineCount);
    lastSessionViewLineCount = 0;
  }
}


function renderSessionBrowser() {
  readline.clearLine(process.stdout, 0);
  readline.cursorTo(process.stdout, 0);
  eraseSessionModal();

  const sessions = sessionManager.getAllSessions();
  const lines: string[] = [];

  lines.push(chalk.hex('#F5A623')('◆ Saved Sessions:'));
  lines.push(chalk.gray('  [↑/↓] Navigate  [Enter] Switch  [Del] Delete  [ESC] Back'));

  if (sessions.length === 0) {
    lines.push(chalk.gray('  No saved sessions available. Press ESC to return.'));
  } else {
    if (sessionCursorIdx >= sessions.length) sessionCursorIdx = sessions.length - 1;
    if (sessionCursorIdx < 0) sessionCursorIdx = 0;

    sessions.forEach((s, idx) => {
      const isSelected = idx === sessionCursorIdx;
      const arrow = isSelected ? chalk.hex('#F5A623')('➔ ') : '  ';
      const titleStr = isSelected
        ? chalk.hex('#F5A623').bold(s.title || 'Untitled')
        : chalk.white(s.title || 'Untitled');
      const meta = chalk.gray(`(${s.messages ? s.messages.length : 0} msgs)`);
      lines.push(`${arrow}[${idx + 1}] ${titleStr} ${meta}`);
    });
  }

  process.stdout.write(lines.join('\n') + '\n');
  lastSessionViewLineCount = lines.length;
  readline.moveCursor(process.stdout, 0, -lastSessionViewLineCount);
  readline.cursorTo(process.stdout, 0);
}


function renderInput() {
  readline.clearLine(process.stdout, 0);
  readline.cursorTo(process.stdout, 0);
  process.stdout.write(PROMPT_LABEL + inputBuffer);

  erasePopupLines();

  const matches = getCmdMatches();
  if (matches.length > 0) {
    if (selectedCmdIdx >= matches.length) selectedCmdIdx = 0;
    if (selectedCmdIdx < 0) selectedCmdIdx = matches.length - 1;

    process.stdout.write('\n');
    matches.forEach((item, idx) => {
      const isSel = idx === selectedCmdIdx;
      const arrow = isSel ? chalk.hex('#F5A623')('➔ ') : '  ';
      const cmdStr = isSel ? chalk.hex('#F5A623').bold(item.cmd) : chalk.white(item.cmd);
      process.stdout.write(`${arrow}${cmdStr} ${chalk.gray(item.desc)}\n`);
    });

    readline.moveCursor(process.stdout, 0, -(matches.length + 1));
    readline.cursorTo(process.stdout, PROMPT_RAW.length + inputBuffer.length);
    lastPopupLineCount = matches.length;
  } else {
    readline.cursorTo(process.stdout, PROMPT_RAW.length + inputBuffer.length);
  }
}


async function runCommandOrQuery(target: string) {
  erasePopupLines();
  process.stdout.write('\n');
  const action = target.trim();

  if (action === '/exit' || action === 'exit' || action === 'quit' || action === ':q') {
    console.log(chalk.gray('Goodbye!\n'));
    process.exit(0);
  }

  if (action === '/clear' || action === 'clear') {
    resetScreen();
    inputBuffer = '';
    renderInput();
    return;
  }

  if (action === '/new') {
    sessionManager.createNewSession();
    console.log(chalk.green('✔ Started new session.\n'));
    inputBuffer = '';
    renderInput();
    return;
  }

  if (action === '/pools') {
    console.log(chalk.hex('#F5A623')('\n◆ Active Model Pools:'));
    console.log(chalk.gray(`  • Fast:      ${MODEL_POOLS.fast.join(', ')}`));
    console.log(chalk.gray(`  • Coding:    ${MODEL_POOLS.coding.join(', ')}`));
    console.log(chalk.gray(`  • Reasoning: ${MODEL_POOLS.reasoning.join(', ')}`));
    console.log(chalk.gray(`  • Vision:    ${MODEL_POOLS.vision.join(', ')}\n`));
    inputBuffer = '';
    renderInput();
    return;
  }

  if (action === '/sessions') {
    isBrowsingSessions = true;
    sessionCursorIdx = 0;
    renderSessionBrowser();
    inputBuffer = '';
    return;
  }

  if (action === '/help') {
    console.log(chalk.cyan('\nAvailable Commands:'));
    COMMANDS.forEach(c => console.log(`  ${c.cmd.padEnd(12)} - ${c.desc}`));
    console.log('');
    inputBuffer = '';
    renderInput();
    return;
  }

  isExecuting = true;
  currentAbortController = new AbortController();

  try {
    process.stdout.write(chalk.gray('⠋ thinking...\r'));
    let first = true;

    await orchestrator.process(action, {
      signal: currentAbortController.signal,
      onStreamChunk: (chunk: string) => {
        if (first) {
          readline.clearLine(process.stdout, 0);
          readline.cursorTo(process.stdout, 0);
          first = false;
        }
        process.stdout.write(chunk);
      }
    });

    process.stdout.write('\n\n');
  } catch (err: any) {
    if (err.name === 'AbortError') {
      console.log(chalk.red('\n✖ Task cancelled.\n'));
    } else {
      console.log(chalk.red(`\n✖ Error: ${err.message}\n`));
    }
  } finally {
    isExecuting = false;
    currentAbortController = null;
    inputBuffer = '';
    renderInput();
  }
}


readline.emitKeypressEvents(process.stdin);
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
}

process.stdin.on('keypress', async (str, key) => {
  if (!key) return;

  if (key.ctrl && key.name === 'c') {
    erasePopupLines();
    eraseSessionModal();
    process.stdout.write('\n');
    process.exit(0);
  }

  /* ── Session Browser mode ────────────────────────────────── */
  if (isBrowsingSessions) {
    if (key.name === 'escape') {
      eraseSessionModal();
      isBrowsingSessions = false;
      inputBuffer = '';
      renderInput();
      return;
    }

    const sessions = sessionManager.getAllSessions();

    if (sessions.length > 0) {
      if (key.name === 'down') {
        sessionCursorIdx = (sessionCursorIdx + 1) % sessions.length;
        renderSessionBrowser();
        return;
      }
      if (key.name === 'up') {
        sessionCursorIdx = (sessionCursorIdx - 1 + sessions.length) % sessions.length;
        renderSessionBrowser();
        return;
      }

      if (key.name === 'delete' || str === '\u001b[3~') {
        const target = sessions[sessionCursorIdx];
        if (target) {
          sessionManager.deleteSession(target.id);
          const updated = sessionManager.getAllSessions();
          if (sessionCursorIdx >= updated.length) {
            sessionCursorIdx = Math.max(0, updated.length - 1);
          }
          renderSessionBrowser();
        }
        return;
      }

      const isEnter = (key.name === 'return' || key.name === 'enter') || str === '\r' || str === '\n';
      if (isEnter) {
        const target = sessions[sessionCursorIdx];
        if (target) {
          sessionManager.setActiveSession(target.id);
          eraseSessionModal();
          isBrowsingSessions = false;
          console.log(chalk.green(`✔ Switched to session: ${target.title}\n`));
          inputBuffer = '';
          renderInput();
        }
        return;
      }
    }

    return;
  }

  /* ── Executing state ─────────────────────────────────────── */
  if (isExecuting) {
    if (key.name === 'escape') {
      if (escTimer) {
        clearTimeout(escTimer);
        escTimer = null;
        currentAbortController?.abort();
      } else {
        process.stdout.write(chalk.yellow('\n[Press ESC again within 2s to cancel]'));
        escTimer = setTimeout(() => { escTimer = null; }, 2000);
      }
    }
    return;
  }

  /* ── Command popup ───────────────────────────────────────── */
  const matches = getCmdMatches();

  const isEnterKey =
    (key.name === 'return' || key.name === 'enter') ||
    str === '\r' ||
    str === '\n';

  if (isEnterKey) {
    if (matches.length > 0) {
      const chosen = matches[selectedCmdIdx].cmd;
      inputBuffer = '';
      await runCommandOrQuery(chosen);
      return;
    }

    const q = inputBuffer.trim();
    if (!q) return;
    inputBuffer = '';
    await runCommandOrQuery(q);
    return;
  }

  if (matches.length > 0) {
    if (key.name === 'down') {
      selectedCmdIdx = (selectedCmdIdx + 1) % matches.length;
      renderInput();
      return;
    }
    if (key.name === 'up') {
      selectedCmdIdx = (selectedCmdIdx - 1 + matches.length) % matches.length;
      renderInput();
      return;
    }
    if (key.name === 'tab' || key.name === 'right') {
      inputBuffer = matches[selectedCmdIdx].cmd;
      renderInput();
      return;
    }
  }

  if (key.name === 'backspace') {
    inputBuffer = inputBuffer.slice(0, -1);
    selectedCmdIdx = 0;
    renderInput();
    return;
  }

  if (str && !key.ctrl && !key.meta && str.length === 1 && str !== '\r' && str !== '\n') {
    inputBuffer += str;
    selectedCmdIdx = 0;
    renderInput();
  }
});


resetScreen();
renderInput();
