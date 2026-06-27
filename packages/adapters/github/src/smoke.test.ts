import { describe, expect, it } from 'vitest';
import {
  createGithubIntrospector,
  createGithubTransport,
  defineGithubIssuesAdapter,
  exampleGithubRoleMap,
  exampleGithubTypeMap,
  recommendedGithubGapPolicy,
} from './index.js';

const owner = process.env.GITHUB_OWNER;
const repo = process.env.GITHUB_REPO;
const token = process.env.GITHUB_TOKEN;
const live = Boolean(owner && repo && token);

/**
 * Gated live smoke test: skipped unless GITHUB_OWNER / GITHUB_REPO / GITHUB_TOKEN are present.
 * It exercises the real octokit transport + introspector against a throwaway repo. Never commit
 * credentials; CI runs this only when the secrets are injected. The pure translation layer is
 * covered network-free by the conformance suite — this only proves the live wiring.
 */
describe.skipIf(!live)('github live smoke', () => {
  const build = () => {
    const transport = createGithubTransport({ owner: owner!, repo: repo!, token: token! });
    return defineGithubIssuesAdapter(
      {
        roleMap: exampleGithubRoleMap,
        typeMap: exampleGithubTypeMap,
        gapPolicy: recommendedGithubGapPolicy,
      },
      transport,
    );
  };

  it('creates an issue, transitions it through labels, and closes it', async () => {
    const adapter = build();
    const created = await adapter.create({
      title: `baron smoke ${new Date().toISOString()}`,
      typeRole: 'task',
    });
    expect(created.key).toBeTruthy();

    const inReview = await adapter.transition(created.id, 'in_review');
    expect(inReview.role).toBe('in_review');
    expect(inReview.labels).toContain('in-review');

    const done = await adapter.transition(created.id, 'done');
    expect(done.role).toBe('done');
  });

  it('introspects the live repo as a flat, label-discriminated provider', async () => {
    const introspection = await createGithubIntrospector({
      owner: owner!,
      repo: repo!,
      token: token!,
    }).introspect();
    expect(introspection.stateKey).toBe('label');
    expect(introspection.states.some((s) => s.name === 'closed')).toBe(true);
  });
});
