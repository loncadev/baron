import { BARON_DIR } from '@baron/providers';

// BARON_DIR + policyPath are shared infra (the MCP server reads the same policy); re-export them so
// CLI consumers keep a single import surface while the canonical definition lives in @baron/providers.
export { BARON_DIR, policyPath } from '@baron/providers';

export function credentialsExamplePath(root: string): string {
  return `${root}/${BARON_DIR}/credentials.example`;
}

export function gitignorePath(root: string): string {
  return `${root}/.gitignore`;
}

/** The credentials file that must never be committed; scaffolding ensures it is gitignored. */
export const CREDENTIALS_IGNORE_ENTRY = `${BARON_DIR}/credentials`;
