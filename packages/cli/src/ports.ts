/**
 * The side-effecting surfaces the CLI commands depend on, expressed as narrow ports so the command
 * logic (`runInit` / `runDoctor`) is unit-testable with in-memory fakes. The real Node-backed
 * implementations live in `node-fs.ts` / `node-prompter.ts`; tests inject scripted fakes.
 */

export interface FileSystem {
  /** Returns the file's text, or undefined if it does not exist. */
  read(path: string): string | undefined;
  write(path: string, content: string): void;
  exists(path: string): boolean;
  /** Create a directory and any missing parents (idempotent). */
  mkdirp(path: string): void;
}

export interface Prompter {
  /** Surface an informational line to the human (proposal notes, drift, etc.). */
  note(message: string): void;
  /** Ask a yes/no question; `defaultYes` is the answer for an empty response. */
  confirm(question: string, defaultYes: boolean): Promise<boolean>;
  /** Ask for a free-text value; `secret: true` hides the echo (tokens/PATs must not print). */
  text(question: string, opts?: { secret?: boolean }): Promise<string>;
}
