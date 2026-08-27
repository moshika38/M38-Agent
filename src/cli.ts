import 'dotenv/config';
import readline from 'node:readline';
import chalk from 'chalk';
import { Orchestrator } from './agent/orchestrator.js';
import { M38_BANNER } from './utils/banner.js';
import { sessionManager } from './session/manager.js';


const orchestrator = new Orchestrator({
  baseURL: process.env.FREELLM_BASE_URL || 'http://localhost:3001/v1',
  apiKey: process.env.FREELLM_API_KEY || '',
});


const COMMANDS = [
  { cmd: '/exit', desc: 'Quit M38 Agent Orchestrator' },
  { cmd: '/clear', desc: 'Clear terminal screen and history' },
  { cmd: '/pools', desc: 'Inspect available model registry' },
  { cmd: '/new', desc: 'Start a fresh conversation session' },
  { cmd: '/sessions', desc: 'Browse and switch saved sessions' },
  { cmd: '/help', desc: 'View available commands guide' }
];


let inputBuffer = '';
let selectedSuggestionIndex = 0;
let lastRenderedSuggestionCount = 0;
let isExecuting = false;
let currentAbortController: AbortController | null = null;
let escTimer: NodeJS.Timeout | null = null;


const PROMPT_PREFIX = chalk.hex('#F5A623')('Ask anything > ');
const PROMPT_PREFIX_RAW = 'Ask anything > ';


function resetScreen() {
  process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
  console.log(M38_BANNER);
  console.log(chalk.gray('  Type / for command suggestions. Type /exit to quit.\n'));
}


function getFilteredCommands() {
  if (!inputBuffer.startsWith('/')) return [];
  const query = inputBuffer.toLowerCase();
  return COMMANDS.filter(c => c.cmd.toLowerCase().startsWith(query));
}


function clearSuggestions() {
  if (lastRenderedSuggestionCount > 0) {
    for (let i = 0; i < lastRenderedSuggestionCount; i++) {
      readline.moveCursor(process.stdout, 0, 1);
      readline.clearLine(process.stdout, 0);
    }
    readline.moveCursor(process.stdout, 0, -lastRenderedSuggestionCount);
    lastRenderedSuggestionCount = 0;
  }
}


function renderUI() {
  readline.clearLine(process.stdout, 0);
  readline.cursorTo(process.stdout, 0);

  process.stdout.write(PROMPT_PREFIX + inputBuffer);

  clearSuggestions();

  const matches = getFilteredCommands();
  if (matches.length > 0) {
    if (selectedSuggestionIndex >= matches.length) selectedSuggestionIndex = 0;
    if (selectedSuggestionIndex < 0) selectedSuggestionIndex = matches.length - 1;

    process.stdout.write('\n');
    matches.forEach((item, idx) => {
      const isSelected = idx === selectedSuggestionIndex;
      const pointer = isSelected ? chalk.hex('#F5A623')('➔ ') : '  ';
      const cmdText = isSelected ? chalk.hex('#F5A623').bold(item.cmd) : chalk.white(item.cmd);
      const descText = chalk.gray(` ${item.desc}`);
      process.stdout.write(pointer + cmdText + descText + '\n');
    });

    readline.moveCursor(process.stdout, 0, -(matches.length + 1));
    readline.cursorTo(process.stdout, PROMPT_PREFIX_RAW.length + inputBuffer.length);
    lastRenderedSuggestionCount = matches.length;
  } else {
    readline.cursorTo(process.stdout, PROMPT_PREFIX_RAW.length + inputBuffer.length);
  }
}


async function handleCommand(cmd: string) {
  clearSuggestions();
  process.stdout.write('\n');


  if (cmd === '/exit' || cmd === 'exit') {
    console.log(chalk.gray('Goodbye!'));
    process.exit(0);
  }


  if (cmd === '/clear') {
    resetScreen();
    inputBuffer = '';
    renderUI();
    return;
  }


  if (cmd === '/new') {
    sessionManager.createNewSession();
    console.log(chalk.green('✔ Started fresh session.\n'));
    inputBuffer = '';
    renderUI();
    return;
  }


  if (cmd === '/pools') {
    console.log(chalk.hex('#F5A623')('\n◆ Active Model Pools:'));
    console.log(chalk.gray('  • Fast:      gemini-3.1-flash-lite-preview, glm-4.7-flash'));
    console.log(chalk.gray('  • Coding:    qwen3-coder-480b, devstral-2-123b'));
    console.log(chalk.gray('  • Reasoning: cogito-2.1-671b, gpt-oss-120b\n'));
    inputBuffer = '';
    renderUI();
    return;
  }


  if (cmd === '/sessions') {
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
    renderUI();
    return;
  }


  if (cmd === '/help') {
    console.log(chalk.cyan('\nAvailable Commands:'));
    COMMANDS.forEach(c => console.log(`  ${c.cmd.padEnd(10)} - ${c.desc}`));
    console.log('');
    inputBuffer = '';
    renderUI();
    return;
  }


  isExecuting = true;
  currentAbortController = new AbortController();


  try {
    process.stdout.write(chalk.gray('⠋ thinking...\r'));
    let firstToken = true;


    await orchestrator.process(cmd, {
      signal: currentAbortController.signal,
      onStreamChunk: (chunk: string) => {
        if (firstToken) {
          readline.clearLine(process.stdout, 0);
          readline.cursorTo(process.stdout, 0);
          firstToken = false;
        }
        process.stdout.write(chunk);
      }
    });


    process.stdout.write('\n\n');
  } catch (err: any) {
    if (err.name === 'AbortError') {
      console.log(chalk.red('\n✖ Cancelled.\n'));
    } else {
      console.log(chalk.red(`\n✖ Error: ${err.message}\n`));
    }
  } finally {
    isExecuting = false;
    currentAbortController = null;
    inputBuffer = '';
    renderUI();
  }
}


readline.emitKeypressEvents(process.stdin);
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
}


process.stdin.on('keypress', async (_, key) => {
  if (!key) return;


  if (key.ctrl && key.name === 'c') {
    process.stdout.write('\n');
    process.exit(0);
  }


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


  const matches = getFilteredCommands();
  if (matches.length > 0) {
    if (key.name === 'down') {
      selectedSuggestionIndex = (selectedSuggestionIndex + 1) % matches.length;
      renderUI();
      return;
    }
    if (key.name === 'up') {
      selectedSuggestionIndex = (selectedSuggestionIndex - 1 + matches.length) % matches.length;
      renderUI();
      return;
    }
    if (key.name === 'tab') {
      inputBuffer = matches[selectedSuggestionIndex].cmd;
      renderUI();
      return;
    }
  }


  if (key.name === 'return') {
    if (matches.length > 0 && inputBuffer.startsWith('/')) {
      const selectedCmd = matches[selectedSuggestionIndex].cmd;
      inputBuffer = '';
      await handleCommand(selectedCmd);
      return;
    }


    const query = inputBuffer.trim();
    if (!query) return;
    inputBuffer = '';
    await handleCommand(query);
    return;
  }


  if (key.name === 'backspace') {
    inputBuffer = inputBuffer.slice(0, -1);
    selectedSuggestionIndex = 0;
    renderUI();
    return;
  }


  if (key.sequence && !key.ctrl && !key.meta && key.sequence.length === 1) {
    inputBuffer += key.sequence;
    selectedSuggestionIndex = 0;
    renderUI();
  }
});


resetScreen();
renderUI();
