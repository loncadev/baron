import { Buffer } from 'node:buffer';

/** A read-only view of process environment (mirrors {@link Env}; kept local to avoid a cycle). */
type Env = Record<string, string | undefined>;

/**
 * The provider-native ESCAPE HATCH (decision #18). A clearly-labeled, last-resort, NON-PORTABLE
 * authenticated REST passthrough so a solopreneur is never blocked by a capability Baron has not yet
 * normalized into a port. The agent supplies the raw provider request; Baron only attaches the
 * provider's base URL + auth and returns the (size-capped) response. This is deliberately outside the
 * normalized port model — using it is an explicit, non-portable choice.
 */
export interface NativeRequest {
  /** HTTP method (GET/POST/PATCH/…). */
  readonly method: string;
  /** Provider-relative path, e.g. '/beekod/_apis/wit/workitems/1?api-version=7.1'. */
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

export interface NativeResponse {
  readonly status: number;
  readonly ok: boolean;
  /** Parsed JSON when possible, else raw text. Capped — see `truncated`. */
  readonly body: unknown;
  readonly truncated: boolean;
}

/** How a provider exposes raw authenticated HTTP for the escape hatch. */
export interface NativeHttp {
  baseUrl(env: Env): string;
  authHeader(env: Env): string;
}

/** Azure DevOps PATs authenticate as HTTP Basic with an empty username. */
export function azureBasicAuth(token: string): string {
  return `Basic ${Buffer.from(`:${token}`).toString('base64')}`;
}

const MAX_BODY_CHARS = 20_000;

/** Pure request plan (URL + method + headers + body) — unit-testable without the network. */
export function nativeRequestPlan(
  http: NativeHttp,
  env: Env,
  req: NativeRequest,
): { url: string; method: string; headers: Record<string, string>; body?: string } {
  const base = http.baseUrl(env).replace(/\/+$/, '');
  const path = req.path.startsWith('/') ? req.path : `/${req.path}`;
  const qs =
    req.query !== undefined && Object.keys(req.query).length > 0
      ? `${path.includes('?') ? '&' : '?'}${new URLSearchParams(req.query).toString()}`
      : '';
  const headers: Record<string, string> = { authorization: http.authHeader(env) };
  let body: string | undefined;
  if (req.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(req.body);
  }
  return {
    url: `${base}${path}${qs}`,
    method: req.method.toUpperCase(),
    headers,
    ...(body !== undefined ? { body } : {}),
  };
}

/** Execute a native request via global fetch. The response body is parsed as JSON when possible and
 * capped to keep a large payload from overflowing the caller's context (`truncated` flags it). */
export async function runNativeRequest(
  http: NativeHttp,
  env: Env,
  req: NativeRequest,
): Promise<NativeResponse> {
  const plan = nativeRequestPlan(http, env, req);
  const response = await fetch(plan.url, {
    method: plan.method,
    headers: plan.headers,
    ...(plan.body !== undefined ? { body: plan.body } : {}),
  });
  const text = await response.text();
  const truncated = text.length > MAX_BODY_CHARS;
  const slice = truncated ? text.slice(0, MAX_BODY_CHARS) : text;
  let parsed: unknown = slice;
  try {
    parsed = JSON.parse(slice);
  } catch {
    /* not JSON (or truncated mid-JSON) — return the text slice */
  }
  return { status: response.status, ok: response.ok, body: parsed, truncated };
}
