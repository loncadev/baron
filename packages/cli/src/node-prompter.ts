import { exit, stdin, stdout } from 'node:process';
import { clearLine, cursorTo, emitKeypressEvents, moveCursor } from 'node:readline';
import type { Prompter } from './ports.js';
import { askLine, askSecretLine, withoutLineReader } from './stdin-line.js';

/**
 * An arrow-key select (↑/↓ to move, ↵ to choose) when stdin is a real terminal — the modern feel.
 * Raw mode + keypress events, dependency-free. The caller falls back to a numbered prompt when there
 * is no TTY (piped / CI), so this is only reached interactively.
 */
function arrowSelect(question: string, options: readonly string[]): Promise<string> {
  return new Promise<string>((resolve) => {
    let index = 0;
    emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();

    stdout.write(`${question}  [2m(↑/↓ to move, ↵ to select)[0m\n`);
    const draw = (first: boolean): void => {
      if (!first) moveCursor(stdout, 0, -options.length);
      options.forEach((opt, i) => {
        cursorTo(stdout, 0);
        clearLine(stdout, 0);
        // Highlight the current row with a pointer + bold; others are dim-padded.
        stdout.write(i === index ? `[36m❯ ${opt}[0m\n` : `  ${opt}\n`);
      });
    };
    draw(true);

    const cleanup = (): void => {
      stdin.off('keypress', onKey);
      stdin.setRawMode(false);
      stdin.pause();
    };
    const onKey = (_ch: string, key: { name?: string; ctrl?: boolean }): void => {
      if (key.name === 'up' || key.name === 'k') {
        index = (index - 1 + options.length) % options.length;
        draw(false);
      } else if (key.name === 'down' || key.name === 'j') {
        index = (index + 1) % options.length;
        draw(false);
      } else if (key.name === 'return' || key.name === 'enter') {
        cleanup();
        resolve(options[index] as string);
      } else if (key.ctrl === true && key.name === 'c') {
        cleanup();
        exit(130); // conventional exit code for SIGINT
      }
    };
    stdin.on('keypress', onKey);
  });
}

/** The real, Node-backed {@link Prompter}: notes go to stdout, confirms read a line from stdin. */
export const nodePrompter: Prompter = {
  note(message) {
    stdout.write(`${message}\n`);
  },
  async confirm(question, defaultYes) {
    const hint = defaultYes ? 'Y/n' : 'y/N';
    const answer = (await askLine(`${question} (${hint}) `)).toLowerCase();
    if (answer === '') return defaultYes;
    return answer === 'y' || answer === 'yes';
  },
  async text(question, opts) {
    return opts?.secret === true ? askSecretLine(`${question} `) : askLine(`${question} `);
  },
  async choice(question, options) {
    // Interactive terminal → arrow-key select; otherwise (piped / CI) a numbered readline prompt.
    if (options.length > 0 && stdin.isTTY === true && typeof stdin.setRawMode === 'function') {
      return withoutLineReader(() => arrowSelect(question, options));
    }
    // A numbered menu: accept the number or the exact name; empty picks the default (first).
    while (true) {
      stdout.write(`${question}\n`);
      options.forEach((opt, i) =>
        stdout.write(`  ${i + 1}) ${opt}${i === 0 ? '  (default)' : ''}\n`),
      );
      const raw = await askLine(`Choose [1-${options.length}]: `);
      if (raw === '') return options[0] as string; // empty / EOF → default, never loops forever
      const byNumber = Number(raw);
      if (Number.isInteger(byNumber) && byNumber >= 1 && byNumber <= options.length) {
        return options[byNumber - 1] as string;
      }
      const byName = options.find((opt) => opt.toLowerCase() === raw.toLowerCase());
      if (byName !== undefined) return byName;
      stdout.write(`  '${raw}' is not one of the options — try a number or the exact name.\n`);
    }
  },
};
