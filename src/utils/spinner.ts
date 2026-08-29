import chalk from 'chalk';

export class StatusSpinner {
  private frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  private index = 0;
  private timer: NodeJS.Timeout | null = null;
  private message = 'Thinking...';

  start(initialMessage = 'Thinking...') {
    this.message = initialMessage;
    this.stop();
    this.timer = setInterval(() => {
      const frame = chalk.hex('#F5A623')(this.frames[this.index]);
      process.stdout.write(`\r\x1b[2K${frame} ${chalk.gray(this.message)}`);
      this.index = (this.index + 1) % this.frames.length;
    }, 80);
  }

  update(msg: string) {
    this.message = msg;
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      process.stdout.write('\r\x1b[2K');
    }
  }
}

export const spinner = new StatusSpinner();
