import chalk from 'chalk';

export const M38_BANNER = `
${chalk.hex('#F5A623')('███╗   ███╗██████╗  █████╗')}
${chalk.hex('#F5A623')('████╗ ████║╚════██╗██╔══██╗')}
${chalk.hex('#F5A623')('██╔████╔██║ █████╔╝╚█████╔╝')}  ${chalk.white.bold('AGENT ORCHESTRATOR')}
${chalk.hex('#F5A623')('██║╚██╔╝██║ ╚═══██╗██╔══██╗')}  ${chalk.hex('#4B5563')('[ v1.0.0 | Engine: FreeLLMAPI ]')}
${chalk.hex('#F5A623')('██║ ╚═╝ ██║██████╔╝╚█████╔╝')}  ${chalk.hex('#4B5563')('[ Status: ')}${chalk.green('● ONLINE')}${chalk.hex('#4B5563')(' | 16 Models Ready ]')}
${chalk.hex('#F5A623')('╚═╝     ╚═╝╚═════╝  ╚════╝')}  ${chalk.hex('#4B5563')('─────────────────────────────')}\n`;
