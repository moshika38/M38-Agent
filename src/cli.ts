#!/usr/bin/env node
import 'dotenv/config';
import readline from 'node:readline';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import chalk from 'chalk';
import { getProjectFiles } from './utils/fileScanner.js';
import { Orchestrator } from './agent/orchestrator.js';
import { M38_BANNER } from './utils/banner.js';
import { sessionManager } from './session/manager.js';
import { MODEL_POOLS } from './config/models.js';
import {
  getStoredKey,
  saveGlobalConfig,
  getBaseURL,
  getStoredConfig,
  reloadConfig,
  DEFAULT_BASE_URL,
} from './config/env.js';
import { spinner } from './utils/spinner.js';

export type AgentMode = 'PLAN' | 'BUILD';
let currentMode: AgentMode = 'BUILD';

const orchestrator = new Orchestrator({
  baseURL: getBaseURL(),
  apiKey: getStoredKey(),
});

const COMMANDS = [
  { cmd: '/exit', desc: 'Quit M38 Agent Orchestrator' },
  { cmd: '/clear', desc: 'Clear terminal screen and history' },
  { cmd: '/pools', desc: 'Inspect active model pools' },
  { cmd: '/new', desc: 'Start a fresh conversation session' },
  { cmd: '/sessions', desc: 'Browse, switch and delete saved sessions' },
  { cmd: '/export', desc: 'Export active session as Markdown file' },
  { cmd: '/config', desc: 'Configure Base URL & FreeLLM API Key' },
  { cmd: '/help', desc: 'View available commands guide' }
];

let inputBuffer = '';
let cursorPos = 0;
let selectedCmdIdx = 0;
let lastPopupLineCount = 0;
let isBoxRendered = false;

process.stdout.write('\x1b[?2004h');
const pastedAttachments: Map<string, string> = new Map();
let pasteCounter = 0;
let isPasting = false;
let pasteBuffer = '';

let isBrowsingSessions = false;
let sessionCursorIdx = 0;
let lastSessionViewLineCount = 0;

let isExecuting = false;
let currentAbortController: AbortController | null = null;
function getBoxWidth(): number {
  const termCols = process.stdout.columns || 80;
  // Use responsive width: clamp between 80 and 120 columns or take 96% of terminal width
  return Math.min(Math.max(termCols - 4, 60), 120);
}
function resetScreen() {
  process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
  console.log(M38_BANNER);
  console.log(chalk.gray('  Type / for commands, @ for files. Type /exit to quit.'));
  console.log(chalk.gray('  [Tab / F2] Toggle Plan/Build Mode\n'));

  if (!getStoredKey()) {
    console.log(chalk.yellow('  [!] No API Key found in .env or ~/.m38rc'));
    console.log(chalk.gray('      Use /config or /key <your_api_key> to configure.\n'));
  }
}

function promptUser(queryText: string, defaultValue: string = ''): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(queryText, (val) => {
      rl.close();
      resolve(val.trim() || defaultValue);
    });
  });
}

export async function runSetupWizardIfNeeded(force: boolean = false): Promise<void> {
  let { BASE_URL, API_KEY } = getStoredConfig();

  if (!API_KEY || force) {
    console.log(chalk.hex('#F5A623')('\n┌─ M38 Setup Wizard ──────────────────────────────────────────────────┐'));
    console.log(chalk.gray('│ Configure your endpoint and API key to continue.                    │'));
    console.log(chalk.hex('#F5A623')('└─────────────────────────────────────────────────────────────────────┘\n'));

    const defaultUrl = BASE_URL || DEFAULT_BASE_URL;
    const inputUrl = await promptUser(chalk.cyan(`? Enter Base URL [Default: ${defaultUrl}]: `), defaultUrl);
    const inputKey = await promptUser(chalk.cyan('? Enter your FreeLLM API Key: '));

    if (!inputKey) {
      console.log(chalk.red('✖ API Key cannot be empty. Please run m38 again.'));
      process.exit(1);
    }

    saveGlobalConfig({ BASE_URL: inputUrl, FREELLM_API_KEY: inputKey });
    console.log(chalk.green('\n✔ Setup saved successfully! Launching M38 Agent...\n'));
    await new Promise((r) => setTimeout(r, 600));
  }
}

function getFileQueryInfo() {
  const lastAtIndex = inputBuffer.lastIndexOf('@');
  if (lastAtIndex === -1) return null;
  const query = inputBuffer.slice(lastAtIndex + 1);
  if (query.includes(' ')) return null;
  return { query, index: lastAtIndex };
}

function getFileSuggestions() {
  const info = getFileQueryInfo();
  if (!info) return [];
  const files = getProjectFiles();
  const q = info.query.toLowerCase();
  return files
    .filter(f => f.toLowerCase().includes(q))
    .slice(0, 8);
}

function getCmdMatches() {
  if (!inputBuffer.startsWith('/')) return [];
  const q = inputBuffer.toLowerCase();
  return COMMANDS.filter(c => c.cmd.toLowerCase().startsWith(q));
}

export function clearInputBox(): void {
  if (isBoxRendered) {
    readline.cursorTo(process.stdout, 0);
    readline.moveCursor(process.stdout, 0, -1);
    readline.clearScreenDown(process.stdout);
    isBoxRendered = false;
  }
}

function eraseInputBox() {
  clearInputBox();
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
  // Clear previous frame cleanly
  clearInputBox();

  const totalBoxWidth = getBoxWidth();
  const innerWidth = totalBoxWidth - 4;

  const isBuild = currentMode === 'BUILD';
  const borderColor = isBuild ? chalk.hex('#F5A623') : chalk.cyan;

  // 1. Top Header Border
  const title = ' Ask anything ';
  const topRemaining = Math.max(totalBoxWidth - title.length - 3, 2);
  process.stdout.write(borderColor('┌─') + chalk.white.bold(title) + borderColor('─'.repeat(topRemaining) + '┐\n'));

  // 2. Single-line Input Row
  const content = `> ${inputBuffer}`;
  const visibleContent = content.length > innerWidth ? content.slice(-innerWidth) : content;
  const padding = ' '.repeat(Math.max(innerWidth - visibleContent.length, 0));
  process.stdout.write(borderColor('│ ') + chalk.white(visibleContent) + padding + borderColor(' │\n'));

  // 3. Bottom Footer Border with Mode Badge
  const badgeText = isBuild ? '[BUILD Mode] (Press Tab to Plan)' : '[PLAN Mode] (Press Tab to Build)';
  const styledBadge = isBuild ? chalk.hex('#F5A623').bold(badgeText) : chalk.cyan.bold(badgeText);
  const bottomRemaining = Math.max(totalBoxWidth - badgeText.length - 5, 2);
  process.stdout.write(borderColor('└') + borderColor('─'.repeat(bottomRemaining) + ' ') + styledBadge + borderColor(' ─┘'));

  isBoxRendered = true;

  const matches = getCmdMatches();
  const fileMatches = getFileSuggestions();
  
  if (matches.length > 0) {
    lastPopupLineCount = matches.length;
  } else if (fileMatches.length > 0) {
    lastPopupLineCount = fileMatches.length;
  } else {
    lastPopupLineCount = 0;
  }

  // 4. Place cursor directly on the typing line
  const cursorCol = 4 + cursorPos;
  
  if (matches.length > 0) {
    if (selectedCmdIdx >= matches.length) selectedCmdIdx = 0;
    if (selectedCmdIdx < 0) selectedCmdIdx = matches.length - 1;

    matches.forEach((item, idx) => {
      const isSel = idx === selectedCmdIdx;
      const arrow = isSel ? chalk.hex('#F5A623')('➔ ') : '  ';
      const cmdStr = isSel ? chalk.hex('#F5A623').bold(item.cmd) : chalk.white(item.cmd);
      process.stdout.write('\n' + `${arrow}${cmdStr} ${chalk.gray(item.desc)}`);
    });

    readline.moveCursor(process.stdout, 0, -(lastPopupLineCount + 1));
    readline.cursorTo(process.stdout, cursorCol);
  } else if (fileMatches.length > 0) {
    if (selectedCmdIdx >= fileMatches.length) selectedCmdIdx = 0;
    if (selectedCmdIdx < 0) selectedCmdIdx = fileMatches.length - 1;

    fileMatches.forEach((item, idx) => {
      const isSel = idx === selectedCmdIdx;
      const arrow = isSel ? chalk.hex('#F5A623')('➔ ') : '  ';
      const fileStr = isSel ? chalk.hex('#38BDF8').bold('@' + item) : chalk.white('@' + item);
      process.stdout.write('\n' + `${arrow}${fileStr}`);
    });

    readline.moveCursor(process.stdout, 0, -(lastPopupLineCount + 1));
    readline.cursorTo(process.stdout, cursorCol);
  } else {
    readline.moveCursor(process.stdout, 0, -1);
    readline.cursorTo(process.stdout, cursorCol);
  }
}

async function runCommandOrQuery(target: string) {
  eraseInputBox();
  cursorPos = 0;
  let action = target.trim();

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

  if (action === '/config') {
    process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
    await runSetupWizardIfNeeded(true);
    reloadConfig();
    const cfg = getStoredConfig();
    orchestrator.setApiKey(cfg.API_KEY, cfg.BASE_URL);
    inputBuffer = '';
    resetScreen();
    setupRawStdin();
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

  if (!getStoredKey()) {
    console.log(chalk.yellow('\n✖ No API key configured. Run /config to configure.\n'));
    inputBuffer = '';
    renderInput();
    return;
  }
  let fullPrompt = action;
  for (const [pill, content] of pastedAttachments.entries()) {
    fullPrompt = fullPrompt.replace(pill, content);
  }
  pastedAttachments.clear();
  action = fullPrompt;
  // Check if we have an approved plan to execute
  const lastPlan = orchestrator.getLastPlan();
  const isTriggeringPlan =
    (action === '' || /^(y|yes|build|execute|go|run)$/i.test(action)) &&
    lastPlan !== null;

  if (isTriggeringPlan) {
    currentMode = 'BUILD';
    console.log(chalk.hex('#10B981').bold('⚡ Executing approved architecture plan...\n'));
    inputBuffer = '';
    cursorPos = 0;

    isExecuting = true;
    currentAbortController = new AbortController();

    try {
      await orchestrator.executePlan(lastPlan!, currentAbortController.signal);
      spinner.stop();
      process.stdout.write('\n\n');
    } catch (err: any) {
      spinner.stop();
      const isAbort =
        err.name === 'AbortError' ||
        err.message?.includes('aborted') ||
        err.message === 'Task was aborted.';
      if (!isAbort) {
        console.log(chalk.red(`\n✖ Error: ${err.message}\n`));
      }
    } finally {
      spinner.stop();
      isExecuting = false;
      currentAbortController = null;
      inputBuffer = '';
      cursorPos = 0;
      renderInput();
    }
    return;
  }

  if (!action) {
    renderInput();
    return;
  }

  // Image detection: find relative/absolute image paths
  const IMAGE_REGEX = /(?:^|\s)(@?[^\s@]+\.(?:png|jpe?g|webp|gif|svg|bmp))(?:$|\s)/gi;
  const imageMatches: string[] = [];
  let imageMatch;
  while ((imageMatch = IMAGE_REGEX.exec(action)) !== null) {
    const rawPath = imageMatch[1]!.replace(/^@/, '');
    const resolvedPath = resolve(process.cwd(), rawPath.replace(/^~/, process.env.HOME || ''));
    if (existsSync(resolvedPath)) {
      imageMatches.push(resolvedPath);
      const fileName = basename(resolvedPath);
      console.log(chalk.cyan(`🖼 Attached image: ${fileName}`));
    }
  }

  console.log(chalk.white(`You: ${action}`) + '\n');

  isExecuting = true;
  currentAbortController = new AbortController();

  try {
    await orchestrator.process(action, {
      signal: currentAbortController.signal,
      mode: currentMode,
      images: imageMatches,
    });

    spinner.stop();
    process.stdout.write('\n\n');

    if (currentMode === 'PLAN' && orchestrator.getLastPlan()) {
      const boxWidth = 72;
      const borderChar = '─';
      const top = `┌${borderChar.repeat(boxWidth)}┐`;
      const bottom = `└${borderChar.repeat(boxWidth)}┘`;
      const side = '│';
      
      const line1 = ` 💡 Ready to build?`;
      const line2 = ` Press [Enter] or [Y] to execute this plan now in [BUILD] mode`;
      const line3 = ` Or type adjustments to refine the plan...`;
      
      const pad1 = ' '.repeat(boxWidth - 19);
      const pad2 = ' '.repeat(boxWidth - line2.length);
      const pad3 = ' '.repeat(boxWidth - line3.length);

      const promptBox = [
        chalk.hex('#38BDF8')(top),
        `${chalk.hex('#38BDF8')(side)}${line1}${pad1}${chalk.hex('#38BDF8')(side)}`,
        `${chalk.hex('#38BDF8')(side)}${line2}${pad2}${chalk.hex('#38BDF8')(side)}`,
        `${chalk.hex('#38BDF8')(side)}${line3}${pad3}${chalk.hex('#38BDF8')(side)}`,
        chalk.hex('#38BDF8')(bottom)
      ].join('\n');
      console.log(promptBox + '\n');
    }
  } catch (err: any) {
    spinner.stop();
    const isAbort =
      err.name === 'AbortError' ||
      err.message?.includes('aborted') ||
      err.message === 'Task was aborted.';
    if (!isAbort) {
      console.log(chalk.red(`\n✖ Error: ${err.message}\n`));
    }
  } finally {
    spinner.stop();
    isExecuting = false;
    currentAbortController = null;
    inputBuffer = '';
    renderInput();
  }
}

export function toggleMode(): void {
  currentMode = currentMode === 'BUILD' ? 'PLAN' : 'BUILD';
  renderInput();
}

function finalizePaste(): void {
  const lines = pasteBuffer.split('\n');

  // If paste is large or multiline (> 3 lines or > 200 chars), collapse into a pill
  if (lines.length > 2 || pasteBuffer.length > 200) {
    pasteCounter++;
    const pill = `[Pasted text #${pasteCounter} +${lines.length} lines]`;
    pastedAttachments.set(pill, pasteBuffer);

    inputBuffer = inputBuffer.slice(0, cursorPos) + pill + inputBuffer.slice(cursorPos);
    cursorPos += pill.length;
  } else {
    inputBuffer = inputBuffer.slice(0, cursorPos) + pasteBuffer + inputBuffer.slice(cursorPos);
    cursorPos += pasteBuffer.length;
  }

  pasteBuffer = '';
  renderInput();
}

function handleInputData(chunk: Buffer): void {
  const str = chunk.toString('utf-8');

  // 1. Bracketed Paste: Start Sequence
  if (str.includes('\x1b[200~')) {
    isPasting = true;
    pasteBuffer = '';
    const cleanChunk = str.replace('\x1b[200~', '');
    if (cleanChunk.includes('\x1b[201~')) {
      const parts = cleanChunk.split('\x1b[201~');
      pasteBuffer += parts[0];
      isPasting = false;
      finalizePaste();
    } else {
      pasteBuffer += cleanChunk;
    }
    return;
  }

  // 2. Bracketed Paste: End Sequence
  if (str.includes('\x1b[201~')) {
    const cleanChunk = str.replace('\x1b[201~', '');
    pasteBuffer += cleanChunk;
    isPasting = false;
    finalizePaste();
    return;
  }

  // If inside paste payload, accumulate
  if (isPasting) {
    pasteBuffer += str;
    return;
  }

  // 3. Ctrl+C (Exit)
  if (str === '\x03') {
    eraseInputBox();
    eraseSessionModal();
    process.stdout.write('\n');
    process.exit(0);
  }

  // 4. Escape Key during executing state
  if (isExecuting) {
    if (str === '\x1b' || str === '\x1b\x1b') {
      spinner.stop();
      if (currentAbortController) {
        currentAbortController.abort();
        process.stdout.write(chalk.red('\n✖ Task cancelled by user.\n\n'));
      }
      return;
    }
  }

  // 5. Session Browser Mode
  if (isBrowsingSessions) {
    if (str === '\x1b') {
      eraseSessionModal();
      isBrowsingSessions = false;
      inputBuffer = '';
      cursorPos = 0;
      renderInput();
      return;
    }

    const sessions = sessionManager.getAllSessions();
    if (sessions.length > 0) {
      if (str === '\x1b[B') { // Down
        sessionCursorIdx = (sessionCursorIdx + 1) % sessions.length;
        renderSessionBrowser();
        return;
      }
      if (str === '\x1b[A') { // Up
        sessionCursorIdx = (sessionCursorIdx - 1 + sessions.length) % sessions.length;
        renderSessionBrowser();
        return;
      }
      if (str === '\x1b[3~') { // Delete
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
      if (str === '\r' || str === '\n') { // Enter
        const target = sessions[sessionCursorIdx];
        if (target) {
          sessionManager.setActiveSession(target.id);
          eraseSessionModal();
          isBrowsingSessions = false;
          console.log(chalk.green(`✔ Switched to session: ${target.title}\n`));
          inputBuffer = '';
          cursorPos = 0;
          renderInput();
        }
        return;
      }
    }
    return;
  }

  const matches = getCmdMatches();
  const fileMatches = getFileSuggestions();
  const activeMatchesLength = matches.length > 0 ? matches.length : fileMatches.length;

  // 6. Tab Key / F2 (Mode Toggle or Autocomplete)
  if (str === '\t' || str === '\x1b[Z' || str === '\x1bOP' || str === '\x1bOQ' || str === '\x1b[12~') {
    if (activeMatchesLength > 0) {
      if (matches.length > 0) {
        inputBuffer = matches[selectedCmdIdx].cmd;
      } else {
        const info = getFileQueryInfo();
        if (info) {
          const chosen = fileMatches[selectedCmdIdx];
          inputBuffer = inputBuffer.slice(0, info.index) + '@' + chosen;
        }
      }
      selectedCmdIdx = 0;
      cursorPos = inputBuffer.length;
      renderInput();
    } else {
      toggleMode();
    }
    return;
  }

  // 7. Up / Down Navigation for Autocomplete popup
  if (activeMatchesLength > 0 && (str === '\x1b[A' || str === '\x1b[B')) {
    if (str === '\x1b[B') { // Down
      selectedCmdIdx = (selectedCmdIdx + 1) % activeMatchesLength;
      renderInput();
      return;
    }
    if (str === '\x1b[A') { // Up
      selectedCmdIdx = (selectedCmdIdx - 1 + activeMatchesLength) % activeMatchesLength;
      renderInput();
      return;
    }
  }

  // 8. Enter / Return Key
  if (str === '\r' || str === '\n') {
    if (matches.length > 0) {
      const chosen = matches[selectedCmdIdx].cmd;
      inputBuffer = '';
      cursorPos = 0;
      runCommandOrQuery(chosen);
      return;
    }

    if (fileMatches.length > 0) {
      const info = getFileQueryInfo();
      if (info) {
        const chosen = fileMatches[selectedCmdIdx];
        inputBuffer = inputBuffer.slice(0, info.index) + '@' + chosen;
        selectedCmdIdx = 0;
        cursorPos = inputBuffer.length;
        renderInput();
      }
      return;
    }

    const q = inputBuffer.trim();
    if (!q && !orchestrator.getLastPlan()) return;
    inputBuffer = '';
    cursorPos = 0;
    runCommandOrQuery(q);
    return;
  }

  // 9. Backspace Key
  if (str === '\x08' || str === '\x7f') {
    if (cursorPos > 0) {
      inputBuffer = inputBuffer.slice(0, cursorPos - 1) + inputBuffer.slice(cursorPos);
      cursorPos--;
      selectedCmdIdx = 0;
      renderInput();
    }
    return;
  }

  // 10. Delete Key (Delete character at cursor)
  if (str === '\x1b[3~') {
    if (cursorPos < inputBuffer.length) {
      inputBuffer = inputBuffer.slice(0, cursorPos) + inputBuffer.slice(cursorPos + 1);
      selectedCmdIdx = 0;
      renderInput();
    }
    return;
  }

  // 11. Left / Right Navigation
  if (str === '\x1b[D') { // Left Arrow
    if (cursorPos > 0) {
      cursorPos--;
      renderInput();
    }
    return;
  }
  if (str === '\x1b[C') { // Right Arrow
    if (cursorPos < inputBuffer.length) {
      cursorPos++;
      renderInput();
    }
    return;
  }

  // 12. Home Key (Jump to beginning)
  if (str === '\x1b[H' || str === '\x1b[1~') {
    cursorPos = 0;
    renderInput();
    return;
  }

  // 13. End Key (Jump to end)
  if (str === '\x1b[F' || str === '\x1b[4~') {
    cursorPos = inputBuffer.length;
    renderInput();
    return;
  }

  // 14. Standard Printable Characters
  if (!str.startsWith('\x1b') && str.length >= 1) {
    inputBuffer = inputBuffer.slice(0, cursorPos) + str + inputBuffer.slice(cursorPos);
    cursorPos += str.length;
    selectedCmdIdx = 0;
    renderInput();
    return;
  }
}

export function setupRawStdin(): void {
  process.stdin.resume();
  process.stdin.setEncoding('utf-8');

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }

  // Enable bracketed paste mode in terminal
  process.stdout.write('\x1b[?2004h');

  // Single reliable data listener
  process.stdin.removeAllListeners('data');
  process.stdin.on('data', handleInputData);

  process.stdin.on('end', () => {
    process.exit(0);
  });
}

let resizeTimeout: NodeJS.Timeout | null = null;

export function attachResizeListener(): void {
  process.stdout.on('resize', () => {
    if (resizeTimeout) clearTimeout(resizeTimeout);

    resizeTimeout = setTimeout(() => {
      // Do NOT call console.clear() during streaming or active tasks
      if (isBoxRendered) {
        clearInputBox();
        renderInput();
      }
    }, 80);
  });
}

async function main() {
  try {
    await runSetupWizardIfNeeded();
    reloadConfig();
    const cfg = getStoredConfig();
    orchestrator.setApiKey(cfg.API_KEY, cfg.BASE_URL);

    resetScreen();
    setupRawStdin();
    attachResizeListener();
    renderInput();
  } catch (err) {
    console.error('Fatal initialization error:', err);
    process.exit(1);
  }
}

main();
