/**
 * Canonical `.baron` layout. Kept POSIX-joined (forward slashes) — the Node fs layer accepts these
 * on every platform, and it keeps the FileSystem fakes in tests trivial to key by path.
 */
export const BARON_DIR = '.baron';

export function policyPath(root: string): string {
  return `${root}/${BARON_DIR}/policy.json`;
}

export function credentialsExamplePath(root: string): string {
  return `${root}/${BARON_DIR}/credentials.example`;
}

export function gitignorePath(root: string): string {
  return `${root}/.gitignore`;
}

/** The credentials file that must never be committed; scaffolding ensures it is gitignored. */
export const CREDENTIALS_IGNORE_ENTRY = `${BARON_DIR}/credentials`;
