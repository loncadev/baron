/**
 * Minimal structured logger contract. The core never silently swallows a capability gap; it logs
 * a `warn` with structured context whenever a `degrade` or `emulate` policy fires.
 */
export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

/** A logger that records nothing. Useful as a default and in tests that don't assert on logs. */
export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

/** Captures log calls so tests can assert that a gap policy fired (and never fired silently). */
export class RecordingLogger implements Logger {
  readonly entries: Array<{
    level: 'debug' | 'info' | 'warn' | 'error';
    message: string;
    context?: Record<string, unknown>;
  }> = [];

  private push(
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    context?: Record<string, unknown>,
  ): void {
    this.entries.push(context === undefined ? { level, message } : { level, message, context });
  }

  debug(message: string, context?: Record<string, unknown>): void {
    this.push('debug', message, context);
  }
  info(message: string, context?: Record<string, unknown>): void {
    this.push('info', message, context);
  }
  warn(message: string, context?: Record<string, unknown>): void {
    this.push('warn', message, context);
  }
  error(message: string, context?: Record<string, unknown>): void {
    this.push('error', message, context);
  }
}
