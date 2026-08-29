import { marked } from 'marked';
// @ts-ignore
import TerminalRenderer from 'marked-terminal';
import chalk from 'chalk';

marked.setOptions({
  renderer: new TerminalRenderer({
    heading: chalk.bold.hex('#38BDF8'),
    firstHeading: chalk.bold.hex('#F5A623').underline,
    showPrefix: false,
    listitem: (text: string) => `  ${chalk.cyan('•')} ${text}\n`,
    codespan: chalk.hex('#A78BFA'),
    code: (code: string) => `\n${chalk.bgHex('#1E1E1E').hex('#D4D4D4')(code)}\n`,
    strong: chalk.bold.hex('#F5A623'),
    em: chalk.italic.hex('#94A3B8'),
    width: Math.min(process.stdout.columns || 80, 100),
    reflowText: true
  })
});

export function renderPrettyPlan(rawMarkdown: string): void {
  const cols = process.stdout.columns || 80;
  const width = Math.max(10, Math.min(cols - 2, 80));
  const topBorder = chalk.hex('#38BDF8')('╭' + '─'.repeat(width) + '╮');
  const bottomBorder = chalk.hex('#38BDF8')('╰' + '─'.repeat(width) + '╯');
  const title = chalk.bold.hex('#38BDF8')(' 📋 ARCHITECTURE & IMPLEMENTATION PLAN ');

  console.log(`\n${topBorder}`);
  console.log(`│${title}`);
  console.log(`${topBorder}\n`);

  // Parse and output high-contrast formatted Markdown
  const rendered = marked(rawMarkdown);
  console.log(rendered);

  console.log(bottomBorder);
  console.log(chalk.hex('#10B981').bold('💡 Press [Tab] to switch to [BUILD] mode and execute.\n'));
}
