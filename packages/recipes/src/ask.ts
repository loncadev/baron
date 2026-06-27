/**
 * The typed human-input surface a recipe's `ask` steps render through (decision #7). Each harness
 * provides its own: the CLI uses stdin prompts; tests use a scripted answerer. Kept separate from
 * the engine so recipes run without any terminal.
 */
export interface RecipeAsker {
  /** Free-text answer; may resolve to undefined when the ask is optional. */
  text(message: string, optional: boolean): Promise<string | undefined>;
  confirm(message: string): Promise<boolean>;
  /** A single choice from the allowed set. */
  choice(message: string, choices: readonly string[]): Promise<string>;
  /** Surface an informational line (recipe `message` steps). */
  note(message: string): void;
}
