#!/usr/bin/env node
import 'dotenv/config';
import readline from 'node:readline';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';
import { Orchestrator } from './agent/orchestrator.js';
import { M38_BANNER } from './utils/banner.js';
import { highlightMarkdown } from './utils/highlighter.js';
import { sessionManager } from './session/manager.js';
import { MODEL_POOLS } from './config/models.js';

export type AgentMode = 'PLAN' | 'BUILD';
let currentMode: AgentMode = 'BUILD';

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
  { cmd: '/export', desc: 'Export active session as Markdown file' },
  { cmd: '/help', desc: 'View available commands guide' }
];

let inputBuffer = '';
let selectedCmdIdx = 0;
let lastPopupLineCount = 0;
let isBoxRendered = false;

let isBrowsingSessions = false;
let sessionCursorIdx = 0;
let lastSessionViewLineCount = 0;

let isExecuting = false;
let currentAbortController: AbortController | null = null;

function getBoxColor(): (str: string) => string {
  return currentMode === 'BUILD' ? chalk.hex('#F5A623') : chalk.hex('#38BDF8');
}

function getBoxWidth(): number {
  const cols = process.stdout.columns || 80;
  return Math.max(40, Math.min(cols, 80));
}

function resetScreen() {
  process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
  console.log(M38_BANNER);
  console.log(chalk.gray('  Type / for commands, @ for files. Type /exit to quit.'));
  console.log(chalk.gray('  [Tab / F2] Toggle Plan/Build Mode\n'));
}

function getCmdMatches() {
  if (!inputBuffer.startsWith('/')) return [];
  const q = inputBuffer.toLowerCase();
  return COMMANDS.filter(c => c.cmd.toLowerCase().startsWith(q));
}

function eraseInputBox() {
  if (!isBoxRendered) return;

  const totalLinesToClear = 3 + lastPopupLineCount;
  readline.moveCursor(process.stdout, 0, -1);

  for (let i = 0; i < totalLinesToClear; i++) {
    readline.cursorTo(process.stdout, 0);
    readline.clearLine(process.stdout, 0);
    if (i < totalLinesToClear - 1) {
      readline.moveCursor(process.stdout, 0, 1);
    }
  }

  readline.moveCursor(process.stdout, 0, -(totalLinesToClear - 1));
  isBoxRendered = false;
  lastPopupLineCount = 0;
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

function renderBoxLines(): { top: string; mid: string; bot: string; cursorCol: number } {
  const width = getBoxWidth();
  const color = getBoxColor();

  const title = 'Ask anything';
  const topFillLen = Math.max(0, width - 2 - (title.length + 3));
  const top = color('┌─ ') + chalk.bold.white(title) + color(' ' + '─'.repeat(topFillLen) + '┐');

  const maxTextLen = Math.max(1, width - 6);
  let visibleText = inputBuffer;
  let cursorOffset = inputBuffer.length;
  if (inputBuffer.length > maxTextLen) {
    visibleText = inputBuffer.slice(inputBuffer.length - maxTextLen);
    cursorOffset = maxTextLen;
  }
  const padLen = Math.max(0, maxTextLen - visibleText.length);
  const mid = color('│') + ' > ' + visibleText + ' '.repeat(padLen) + color(' │');

  const badgeRaw = currentMode === 'BUILD'
    ? '[BUILD Mode] (Press Tab to Plan)'
    : '[PLAN Mode] (Press Tab to Build)';
  const badgeStyled = currentMode === 'BUILD'
    ? chalk.hex('#F5A623').bold(badgeRaw)
    : chalk.hex('#38BDF8').bold(badgeRaw);

  const botFillLen = Math.max(1, width - 6 - badgeRaw.length);
  const bot = color('└' + '─'.repeat(botFillLen) + ' ') + badgeStyled + color(' ─┘');

  return {
    top,
    mid,
    bot,
    cursorCol: 4 + cursorOffset,
  };
}

function renderInput() {
  eraseInputBox();

  const { top, mid, bot, cursorCol } = renderBoxLines();

  process.stdout.write(top + '\n');
  process.stdout.write(mid + '\n');
  process.stdout.write(bot);
  isBoxRendered = true;

  const matches = getCmdMatches();
  if (matches.length > 0) {
    if (selectedCmdIdx >= matches.length) selectedCmdIdx = 0;
    if (selectedCmdIdx < 0) selectedCmdIdx = matches.length - 1;

    matches.forEach((item, idx) => {
      const isSel = idx === selectedCmdIdx;
      const arrow = isSel ? chalk.hex('#F5A623')('➔ ') : '  ';
      const cmdStr = isSel ? chalk.hex('#F5A623').bold(item.cmd) : chalk.white(item.cmd);
      process.stdout.write('\n' + `${arrow}${cmdStr} ${chalk.gray(item.desc)}`);
    });

    lastPopupLineCount = matches.length;
    readline.moveCursor(process.stdout, 0, -(lastPopupLineCount + 1));
    readline.cursorTo(process.stdout, cursorCol);
  } else {
    lastPopupLineCount = 0;
    readline.moveCursor(process.stdout, 0, -1);
    readline.cursorTo(process.stdout, cursorCol);
  }
}

async function runCommandOrQuery(target: string) {
  eraseInputBox();
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

  if (action === '/export') {
    const session = sessionManager.getCurrentSession();
    if (!session || session.messages.length === 0) {
      console.log(chalk.yellow('  No active session with messages to export.\n'));
      inputBuffer = '';
      renderInput();
      return;
    }

    const exportDir = join(process.cwd(), 'exports');
    if (!existsSync(exportDir)) {
      mkdirSync(exportDir, { recursive: true });
    }

    const fileName = `${session.id}.md`;
    const filePath = join(exportDir, fileName);

    let md = `# ${session.title}\n\n`;
    md += `> Exported from M38 Agent · ${new Date().toISOString().split('T')[0]}\n\n---\n\n`;

    for (const msg of session.messages) {
      const role = msg.role === 'user' ? '**You**' : '**M38 Agent**';
      md += `### ${role}\n\n${msg.content}\n\n---\n\n`;
    }

    writeFileSync(filePath, md, 'utf-8');
    console.log(chalk.green(`✔ Exported session to: ./exports/${fileName}\n`));
    inputBuffer = '';
    renderInput();
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
    let buffer = '';

    await orchestrator.process(action, {
      signal: currentAbortController.signal,
      mode: currentMode,
      onStreamChunk: (chunk: string) => {
        if (first) {
          readline.clearLine(process.stdout, 0);
          readline.cursorTo(process.stdout, 0);
          first = false;
        }
        buffer += chunk;

        const codeBlockMatch = buffer.match(/```[\s\S]*?$/);
        if (codeBlockMatch && !buffer.slice(0, -chunk.length).includes('```')) {
          process.stdout.write(chunk);
          return;
        }

        if (buffer.includes('```') && (buffer.match(/```/g)?.length ?? 0) % 2 === 0) {
          process.stdout.write(highlightMarkdown(buffer));
          buffer = '';
          return;
        }

        process.stdout.write(chunk);
      }
    });

    if (buffer.trim()) {
      process.stdout.write(highlightMarkdown(buffer));
    }

    process.stdout.write('\n\n');
  } catch (err: any) {
    const isAbort =
      err.name === 'AbortError' ||
      err.message?.includes('aborted') ||
      err.message === 'Task was aborted.';
    if (!isAbort) {
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

process.stdout.on('resize', () => {
  if (!isExecuting && !isBrowsingSessions) {
    renderInput();
  }
});

process.stdin.on('keypress', async (str, key) => {
  if (!key) return;

  if (key.ctrl && key.name === 'c') {
    eraseInputBox();
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
    if (key && (key.name === 'escape' || str === '\u001b')) {
      if (currentAbortController) {
        currentAbortController.abort();
        process.stdout.write(chalk.red('\n✖ Task cancelled by user.\n\n'));
      }
      return;
    }
  }

  /* ── Mode Toggle (Tab / F2 when buffer empty) ────────────────── */
  const isModeToggleKey = key.name === 'tab' || key.name === 'f2' || str === '\u001bOQ' || str === '\u001b[12~';
  if (isModeToggleKey && inputBuffer === '') {
    currentMode = currentMode === 'BUILD' ? 'PLAN' : 'BUILD';
    renderInput();
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
