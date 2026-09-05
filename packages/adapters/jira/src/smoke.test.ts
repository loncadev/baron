import { describe, expect, it } from 'vitest';
import { createJiraIntrospector } from './introspector.js';
import { JIRA_STATE_KEY } from './provider.js';
import { createJiraTransport } from './transport.js';

const site = process.env.JIRA_SITE;
const email = process.env.JIRA_EMAIL;
const apiToken = process.env.JIRA_API_TOKEN;
const project = process.env.JIRA_PROJECT;
const live = Boolean(site && email && apiToken && project);

/**
 * Gated live smoke test: skipped unless JIRA_SITE, JIRA_EMAIL, JIRA_API_TOKEN and JIRA_PROJECT are
 * in the environment.
 *
 * The conformance suite proves the translation layer network-free, and the fetch-stub tests prove
 * what the transport sends. Neither can check the manifest — a set of claims about a real API — or
 * that Jira's own answers have the shape the parsers assume. This asserts the things only a real
 * call can settle: that introspection sees the project's statuses; that a created issue reads back
 * with its status NAME as the discriminator; that the transitions read reports reachable targets
 * and, when a screen exists, its fields; that a transition performed by destination lands; and
 * that a label round-trips through the update verb.
 *
 * It CREATES an issue and deletes it at the end. Point JIRA_PROJECT at a throwaway project.
 */
describe.skipIf(!live)('jira live smoke', () => {
  // Defaulted rather than asserted: a skipped describe still evaluates its body at collection
  // time, and constructing the transport must not throw on a machine without credentials.
  const opts = {
    site: site ?? '',
    email: email ?? '',
    apiToken: apiToken ?? '',
    project: project ?? '',
  };
  const transport = createJiraTransport(opts);
  const authorization = `Basic ${Buffer.from(`${opts.email}:${opts.apiToken}`).toString('base64')}`;

  it('introspects, creates, transitions by destination, labels, and cleans up', async () => {
    const introspection = await createJiraIntrospector(opts).introspect();
    expect(introspection.states.length).toBeGreaterThan(0);
    expect(introspection.workItemTypes.length).toBeGreaterThan(0);
    const type =
      introspection.workItemTypes.find((t) => t.name === 'Task' && t.hierarchyLevel === 0) ??
      introspection.workItemTypes.find((t) => t.hierarchyLevel === 0);
    expect(type).toBeDefined();

    const created = await transport.createIssue({
      title: 'baron smoke — safe to delete',
      body: 'Created by the Jira adapter smoke test.',
      nativeType: (type as { name: string }).name,
      typeRole: 'task',
      labels: ['baron-smoke'],
    });
    try {
      expect(created.key).toMatch(new RegExp(`^${opts.project}-\\d+$`));
      expect(introspection.states.map((s) => s.name)).toContain(created.discriminator);
      expect(created.labels).toContain('baron-smoke');

      const reachable = (await transport.availableTargets?.(created.id)) ?? [];
      expect(reachable.length).toBeGreaterThan(0);
      const first = reachable[0] as Record<string, string>;
      const fields = (await transport.transitionFields?.(created.id, first)) ?? [];
      for (const field of fields) expect(typeof field.required).toBe('boolean');

      // Only perform the transition when its screen demands nothing: answering a real screen
      // needs values this test cannot know, and the fetch-stub tests cover that path.
      if (!fields.some((f) => f.required)) {
        const moved = await transport.applyTarget(created.id, first);
        expect(moved.discriminator).toBe(first[JIRA_STATE_KEY]);
      }

      await transport.addLabel(created.id, 'baron-smoke-2');
      expect((await transport.getIssue(created.id)).labels).toContain('baron-smoke-2');
      await transport.removeLabel?.(created.id, 'baron-smoke-2');
      expect((await transport.getIssue(created.id)).labels).not.toContain('baron-smoke-2');

      const mine = await transport.queryIssues({
        targets: [{ [JIRA_STATE_KEY]: (await transport.getIssue(created.id)).discriminator }],
        limit: 50,
      });
      expect(mine.map((i) => i.key)).toContain(created.key);
    } finally {
      await fetch(`${opts.site.replace(/\/+$/, '')}/rest/api/2/issue/${created.key}`, {
        method: 'DELETE',
        headers: { authorization },
      });
    }
  }, 60_000);
});
