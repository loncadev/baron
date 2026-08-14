import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { type SteeringContext, steeringBlock } from './init.js';

// Read across the workspace rather than importing: this asserts a repository-level agreement, and a
// devDependency edge from the CLI to the MCP server would be a real edge bought for a test.
const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const CONSOLIDATED = `${REPO}packages/mcp-server/src/consolidated.ts`;
const SKILLS_DIR = `${REPO}plugins/claude-code/skills/`;

const publishedToolNames = () =>
  new Set(
    Array.from(readFileSync(CONSOLIDATED, 'utf8').matchAll(/'(baron_[a-z_]+)'/g), (m) => m[1]),
  );

const shippedSkillNames = () =>
  new Set(
    readdirSync(SKILLS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name),
  );

/** Every shape of steering the generator can emit, so a name hidden behind a branch is still checked. */
const CONTEXTS: SteeringContext[] = [
  {
    provider: 'github',
    rolesRideLabels: true,
    sprints: false,
    hierarchy: false,
    typeRoles: ['task', 'bug'],
  },
  {
    provider: 'azure-devops',
    rolesRideLabels: false,
    sprints: true,
    hierarchy: true,
    typeRoles: ['epic', 'story', 'task', 'bug'],
  },
];

describe('the AGENTS.md steering block init writes into the user repo', () => {
  it('names only tools the server actually publishes', () => {
    // This drifted twice. The verb consolidation renamed the write tools and this generator kept
    // emitting baron_issue_block, baron_issue_unblock, baron_followup_* and baron_learning_* — names
    // that no longer exist. It is the worst place to be wrong: the text is written into the *user's*
    // repository, so it survives every Baron upgrade, and an agent obeying it asks for a tool that
    // is not there.
    const published = publishedToolNames();
    expect(published.size).toBeGreaterThan(0);
    for (const ctx of CONTEXTS) {
      const named = new Set(
        Array.from(steeringBlock(ctx).matchAll(/\bbaron_[a-z_]+/g), (m) => m[0]),
      );
      expect(named.size).toBeGreaterThan(0);
      expect([...named].filter((name) => !published.has(name))).toEqual([]);
    }
  });

  it('names only skills that ship with the plugin', () => {
    // The same failure one level up: steering tells the agent to prefer /baron:<skill>, and a skill
    // that was renamed or never shipped sends it somewhere that does not exist.
    const skills = shippedSkillNames();
    expect(skills.size).toBeGreaterThan(0);
    for (const ctx of CONTEXTS) {
      const named = Array.from(steeringBlock(ctx).matchAll(/\/baron:([a-z-]+)/g), (m) => m[1]);
      expect(named.length).toBeGreaterThan(0);
      expect(named.filter((skill) => !skills.has(skill as string))).toEqual([]);
    }
  });
});
