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
  { cmd: '/sessions', desc: 'Browse and switch saved sessions' },
  { cmd: '/help', desc: 'View available commands guide' }
];


let inputBuffer = '';
let selectedIdx = 0;
let lastPopupLineCount = 0;
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


function getMatches() {
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


function renderInput() {
  readline.clearLine(process.stdout, 0);
  readline.cursorTo(process.stdout, 0);
  process.stdout.write(PROMPT_LABEL + inputBuffer);


  erasePopupLines();


  const matches = getMatches();
  if (matches.length > 0) {
    if (selectedIdx >= matches.length) selectedIdx = 0;
    if (selectedIdx < 0) selectedIdx = matches.length - 1;


    process.stdout.write('\n');
    matches.forEach((item, idx) => {
      const isSel = idx === selectedIdx;
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
    const sessions = sessionManager.list();
    console.log(chalk.hex('#F5A623')('\n◆ Saved Sessions:'));
    if (sessions.length === 0) {
      console.log(chalk.gray('  No saved sessions.\n'));
    } else {
      sessions.slice(0, 5).forEach((s, i) => {
        console.log(chalk.gray(`  [${i + 1}] ${s.title} (${s.messages.length} msgs)`));
      });
      console.log('');
    }
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
  if (key && key.ctrl && key.name === 'c') {
    erasePopupLines();
    process.stdout.write('\n');
    process.exit(0);
  }


  if (isExecuting) {
    if (key && key.name === 'escape') {
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


  const matches = getMatches();


  const isEnterKey =
    (key && (key.name === 'return' || key.name === 'enter')) ||
    str === '\r' ||
    str === '\n';


  if (isEnterKey) {
    if (matches.length > 0) {
      const chosen = matches[selectedIdx].cmd;
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
    if (key && key.name === 'down') {
      selectedIdx = (selectedIdx + 1) % matches.length;
      renderInput();
      return;
    }
    if (key && key.name === 'up') {
      selectedIdx = (selectedIdx - 1 + matches.length) % matches.length;
      renderInput();
      return;
    }
    if (key && (key.name === 'tab' || key.name === 'right')) {
      inputBuffer = matches[selectedIdx].cmd;
      renderInput();
      return;
    }
  }


  if (key && key.name === 'backspace') {
    inputBuffer = inputBuffer.slice(0, -1);
    selectedIdx = 0;
    renderInput();
    return;
  }


  if (str && !key?.ctrl && !key?.meta && str.length === 1 && str !== '\r' && str !== '\n') {
    inputBuffer += str;
    selectedIdx = 0;
    renderInput();
  }
});


resetScreen();
renderInput();
