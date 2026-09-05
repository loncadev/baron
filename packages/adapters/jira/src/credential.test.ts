import { describe, expect, it } from 'vitest';
import { createJiraCredentialProbe } from './credential.js';

/** A fetch that answers each call with a queued HTTP status and records the requests. */
function fakeFetch(statuses: number[]) {
  const sent: Array<{ method: string; url: string }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    sent.push({ method: init?.method ?? 'GET', url });
    const status = statuses.shift() ?? 200;
    return { ok: status >= 200 && status < 300, status, text: async () => '' };
  }) as unknown as typeof fetch;
  return { fetchImpl, sent };
}

const probe = (statuses: number[]) => {
  const fake = fakeFetch(statuses);
  return {
    probe: createJiraCredentialProbe({
      site: 'https://acme.atlassian.net',
      email: 'dev@acme.test',
      apiToken: 'tok',
      project: 'PROJ',
      fetchImpl: fake.fetchImpl,
    }),
    sent: fake.sent,
  };
};

describe('the Jira credential probe', () => {
  it('confirms read by fetching the project, and treats an invisible project as denied', async () => {
    const [ok] = await probe([200]).probe.probe(['issues:read']);
    expect(ok?.status).toBe('granted');
    expect(ok?.nativePermission).toMatch(/Browse Projects/);

    // Jira hides a project the token cannot see behind the same 404 as a project that does not
    // exist. Either way the work cannot be done, so neither passes.
    const [hidden] = await probe([404]).probe.probe(['issues:read']);
    expect(hidden?.status).toBe('denied');
    expect(hidden?.detail).toMatch(/no project 'PROJ' is visible/);

    const [refused] = await probe([403]).probe.probe(['issues:read']);
    expect(refused?.status).toBe('denied');
  });

  it('reads a write grant from a 404 on a key that cannot exist, without writing anything', async () => {
    const { probe: p, sent } = probe([404]);
    const [write] = await p.probe(['issues:write']);
    expect(write?.status).toBe('granted');
    expect(sent[0]?.method).toBe('PUT');
    expect(sent[0]?.url).toMatch(/\/issue\/PROJ-0$/);

    const [denied] = await probe([403]).probe.probe(['issues:write']);
    expect(denied?.status).toBe('denied');
  });

  it('does not conclude anything from a response it did not expect', async () => {
    // A 200 on an edit of a non-existent key means the premise of the probe is wrong somewhere;
    // reporting a grant would convert "nobody checked" into "checked, and wrong".
    const [odd] = await probe([200]).probe.probe(['issues:write']);
    expect(odd?.status).toBe('unknown');
    const [flaky] = await probe([502]).probe.probe(['issues:read']);
    expect(flaky?.status).toBe('unknown');
  });

  it('answers unknown for a surface Jira does not have', async () => {
    const [scm] = await probe([]).probe.probe(['scm:write']);
    expect(scm?.status).toBe('unknown');
    expect(scm?.detail).toMatch(/no 'scm:write' surface/);
  });
});
