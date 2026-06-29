/**
 * The committed `.baron` config layout, shared by every entrypoint that reads it (the CLI's
 * `doctor` and the MCP server both load `policy.json`). Kept here in shared infrastructure so those
 * entrypoints depend on this, not on each other. POSIX-joined; the Node fs layer accepts these on
 * every platform.
 */
export const BARON_DIR = '.baron';

export function policyPath(root: string): string {
  return `${root}/${BARON_DIR}/policy.json`;
}

/** Directory the default local-markdown knowledge loop persists into. */
export function knowledgeDir(root: string): string {
  return `${root}/${BARON_DIR}/knowledge`;
}

/** The gitignored credentials file (KEY=VALUE) overlaid onto the environment at run time. */
export function credentialsPath(root: string): string {
  return `${root}/${BARON_DIR}/credentials`;
}
