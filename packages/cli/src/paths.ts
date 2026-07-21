import { BARON_DIR } from '@lonca/baron-providers';

// BARON_DIR + policyPath + credentialsPath are shared infra (the MCP server reads the same policy /
// credentials); re-export them so CLI consumers keep a single import surface while the canonical
// definition lives in @lonca/baron-providers.
export { BARON_DIR, policyPath, credentialsPath } from '@lonca/baron-providers';

export function credentialsExamplePath(root: string): string {
  return `${root}/${BARON_DIR}/credentials.example`;
}

export function gitignorePath(root: string): string {
  return `${root}/.gitignore`;
}

/** Git's per-repo config, where the `origin` remote (and thus owner/repo) can be auto-detected. */
export function gitConfigPath(root: string): string {
  return `${root}/.git/config`;
}

/** The credentials file that must never be committed; scaffolding ensures it is gitignored. */
export const CREDENTIALS_IGNORE_ENTRY = `${BARON_DIR}/credentials`;
