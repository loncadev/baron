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
  async text(question, opts) {
    const rl = createInterface({ input: stdin, output: stdout, terminal: true });
    // For a secret, mute the keystroke echo: the prompt itself is written once, then every further
    // write (the typed characters) is swallowed so a token never lands in the terminal or scrollback.
    if (opts?.secret === true) {
      let promptShown = false;
      const muted = rl as unknown as { _writeToOutput?: (chunk: string) => void };
      muted._writeToOutput = (chunk: string) => {
        if (!promptShown) {
          stdout.write(chunk);
          promptShown = true;
        }
      };
    }
    try {
      const answer = await rl.question(`${question} `);
      if (opts?.secret === true) stdout.write('\n'); // the muted Enter left the cursor mid-line
      return answer.trim();
    } finally {
      rl.close();
    }
  },
  async choice(question, options) {
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      // A numbered menu: accept the number or the exact name; empty picks the default (first).
      while (true) {
        stdout.write(`${question}\n`);
        options.forEach((opt, i) =>
          stdout.write(`  ${i + 1}) ${opt}${i === 0 ? '  (default)' : ''}\n`),
        );
        const raw = (await rl.question(`Choose [1-${options.length}]: `)).trim();
        if (raw === '') return options[0] as string; // empty / EOF → default, never loops forever
        const byNumber = Number(raw);
        if (Number.isInteger(byNumber) && byNumber >= 1 && byNumber <= options.length) {
          return options[byNumber - 1] as string;
        }
        const byName = options.find((opt) => opt.toLowerCase() === raw.toLowerCase());
        if (byName !== undefined) return byName;
        stdout.write(`  '${raw}' is not one of the options — try a number or the exact name.\n`);
      }
    } finally {
      rl.close();
    }
  },
};
