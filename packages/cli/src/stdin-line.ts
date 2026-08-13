import { stdin, stdout } from 'node:process';
import { type Interface, createInterface } from 'node:readline/promises';

let shared: Interface | undefined;
/** Lines that arrived before anyone asked for them. */
const buffered: string[] = [];
/** Askers waiting for a line that has not arrived yet. */
const waiting: ((line: string) => void)[] = [];
let ended = false;

/**
 * One readline interface for the whole process, with a line QUEUE in front of it.
 *
 * Two things break the obvious implementation, and both are invisible interactively:
 *
 * 1. A fresh interface per question loses everything the previous one buffered — `close()` discards
 *    the remainder of a pipe, so the second question reads EOF.
 * 2. `rl.question()` is not a queue. readline drains a pipe eagerly and emits every line at once,
 *    while `question()` only captures the next line emitted AFTER it is called. A recipe that does
 *    network work between two asks therefore loses every line that arrived during it.
 *
 * Together those made every recipe with more than one `ask` — task-finish, task-land, task-new —
 * impossible to drive non-interactively, which is how CI and an agent drive them.
 *
 * Nothing closes the interface: `baron` exits the process when the command finishes and takes it
 * with it. Closing it early would resurrect (1).
 */
function reader(): Interface {
  if (shared !== undefined) return shared;
  shared = createInterface({ input: stdin, output: stdout });
  shared.on('line', (line: string) => {
    const next = waiting.shift();
    if (next === undefined) buffered.push(line);
    else next(line);
  });
  // On EOF, release everyone still waiting with an empty answer. An optional ask treats that as
  // "skipped" and a required one fails its own validation — either beats hanging forever.
  shared.on('close', () => {
    ended = true;
    for (const pending of waiting.splice(0)) pending('');
  });
  return shared;
}

function nextLine(): Promise<string> {
  reader();
  const ready = buffered.shift();
  if (ready !== undefined) return Promise.resolve(ready);
  if (ended) return Promise.resolve('');
  return new Promise<string>((resolve) => waiting.push(resolve));
}

/** Write a prompt and read one line. */
export async function askLine(question: string): Promise<string> {
  stdout.write(question);
  return (await nextLine()).trim();
}

/**
 * Read one line without echoing it. The prompt is written directly, then readline's output is
 * swallowed for the duration so a token never lands in the terminal or in scrollback. The reader is
 * shared, so the mute is always undone — otherwise every later prompt goes silent.
 */
export async function askSecretLine(question: string): Promise<string> {
  const muted = reader() as unknown as { _writeToOutput?: (chunk: string) => void };
  const restore = muted._writeToOutput;
  stdout.write(question);
  muted._writeToOutput = () => {};
  try {
    return (await nextLine()).trim();
  } finally {
    muted._writeToOutput = restore;
    stdout.write('\n'); // the muted Enter left the cursor mid-line
  }
}

/**
 * Run `body` with the shared reader detached from stdin, for the one caller that needs raw keypress
 * events (the arrow-key select). Two consumers on one stdin would each eat half the keystrokes.
 */
export async function withoutLineReader<T>(body: () => Promise<T>): Promise<T> {
  shared?.pause();
  try {
    return await body();
  } finally {
    shared?.resume();
  }
}
