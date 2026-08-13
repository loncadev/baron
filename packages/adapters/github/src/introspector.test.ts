import { describe, expect, it, vi } from 'vitest';

// Stub octokit: introspection is a live REST call, and the bug this file guards against is invisible
// to the conformance suite (which runs against the in-memory transport and never sees this route).
const mocks = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock('octokit', () => ({
  Octokit: vi.fn(() => ({ hook: { before: vi.fn(), error: vi.fn() }, request: mocks.request })),
}));

const { createGithubIntrospector } = await import('./introspector.js');

const introspector = () => createGithubIntrospector({ owner: 'acme', repo: 'store', token: 't' });

describe('github introspection of work item types', () => {
  it("keeps 'issue' when the repo has Issue Types defined", async () => {
    // The regression. This org had Task/Bug/Feature defined and assigned to NONE of its issues, so
    // dropping 'issue' once the route answered produced a policy in which the type every issue
    // actually reports was absent — leaving typeRole undefined, branchName undefined, and every
    // task-start refused with a message about containers.
    mocks.request.mockResolvedValue({ data: [{ name: 'Task' }, { name: 'Bug' }] });

    const { workItemTypes } = await introspector().introspect();

    expect(workItemTypes.map((t) => t.name)).toEqual(['issue', 'Task', 'Bug']);
  });

  it("reports 'issue' alone when Issue Types are unavailable", async () => {
    mocks.request.mockRejectedValue(new Error('404 — feature not enabled'));

    const { workItemTypes } = await introspector().introspect();

    expect(workItemTypes.map((t) => t.name)).toEqual(['issue']);
  });

  it('does not duplicate a type the route reports as "issue"', async () => {
    mocks.request.mockResolvedValue({ data: [{ name: 'issue' }, { name: 'Bug' }] });

    const { workItemTypes } = await introspector().introspect();

    expect(workItemTypes.map((t) => t.name)).toEqual(['issue', 'Bug']);
  });

  it('ignores entries with no usable name rather than inventing one', async () => {
    mocks.request.mockResolvedValue({ data: [{ name: '' }, {}, { name: 'Bug' }] });

    const { workItemTypes } = await introspector().introspect();

    expect(workItemTypes.map((t) => t.name)).toEqual(['issue', 'Bug']);
  });
});
