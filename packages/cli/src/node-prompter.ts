import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import type { Prompter } from './ports.js';

/** The real, Node-backed {@link Prompter}: notes go to stdout, confirms read a line from stdin. */
export const nodePrompter: Prompter = {
  note(message) {
    stdout.write(`${message}\n`);
  },
  async confirm(question, defaultYes) {
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      const hint = defaultYes ? 'Y/n' : 'y/N';
      const answer = (await rl.question(`${question} (${hint}) `)).trim().toLowerCase();
      if (answer === '') return defaultYes;
      return answer === 'y' || answer === 'yes';
    } finally {
      rl.close();
    }
  },
};
