/**
 * The page the loopback listener answers the browser with, once Linear has sent it back.
 *
 * It is the only thing the user sees of Baron in the browser, and it arrives right after a
 * consent screen that asked for read and write access to their workspace — a bare line of text
 * at that moment reads like something went wrong. So the page says who is speaking, what just
 * happened, and what to do next, and nothing else. Entirely self-contained: the listener is
 * local and closes as soon as this is served, so no stylesheet, font or image may be fetched.
 */

const escapeHtml = (text: string): string =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );

const STYLE = `
  :root { color-scheme: light dark; --fg: #1a1a1a; --muted: #5f6368; --bg: #f6f7f9; --card: #ffffff;
    --line: #e3e5e8; --ok: #1f9d55; --bad: #c8402c; }
  @media (prefers-color-scheme: dark) { :root { --fg: #ececec; --muted: #9aa0a6; --bg: #121417;
    --card: #1b1e23; --line: #2a2e35; --ok: #3ccf7a; --bad: #ff6b57; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg);
    color: var(--fg); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { width: min(440px, calc(100vw - 32px)); background: var(--card); border: 1px solid var(--line);
    border-radius: 14px; padding: 32px 32px 24px; text-align: center; }
  .mark { display: inline-grid; place-items: center; width: 56px; height: 56px; border-radius: 50%;
    margin-bottom: 16px; }
  .ok .mark { background: color-mix(in srgb, var(--ok) 15%, transparent); color: var(--ok); }
  .bad .mark { background: color-mix(in srgb, var(--bad) 15%, transparent); color: var(--bad); }
  h1 { margin: 0 0 8px; font-size: 20px; font-weight: 600; }
  p { margin: 0 0 8px; color: var(--muted); }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 14px;
    background: color-mix(in srgb, var(--fg) 8%, transparent); padding: 1px 6px; border-radius: 5px; }
  footer { margin-top: 20px; padding-top: 14px; border-top: 1px solid var(--line); font-size: 13px;
    color: var(--muted); }
  footer b { color: var(--fg); font-weight: 600; letter-spacing: 0.02em; }
`;

const CHECK =
  '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const CROSS =
  '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

const shell = (kind: 'ok' | 'bad', title: string, body: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Baron — ${escapeHtml(title)}</title><style>${STYLE}</style></head><body><main class="${kind}"><div class="mark">${kind === 'ok' ? CHECK : CROSS}</div><h1>${escapeHtml(title)}</h1>${body}<footer><b>BARON</b> · work orchestration for AI coding agents</footer></main></body></html>`;

/** The page for a callback that carried an authorization code. */
export function signedInPage(): string {
  return shell(
    'ok',
    'Signed in to Linear',
    '<p>Baron has what it was waiting for. You can close this tab and go back to the terminal — <code>baron init</code> carries on from there.</p>',
  );
}

/** The page for a callback that carried an error, e.g. `access_denied` when the user cancels. */
export function refusedPage(error: string): string {
  return shell(
    'bad',
    'Linear did not authorize Baron',
    `<p>Linear answered <code>${escapeHtml(error)}</code>, so no token was issued and nothing was stored.</p><p>Go back to the terminal; run <code>baron init</code> again when you are ready to approve, or paste a personal API key instead.</p>`,
  );
}
