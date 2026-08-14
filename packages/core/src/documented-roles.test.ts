import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WORKFLOW_ROLES } from './roles.js';

// Reaches out of the package because the agreement being protected spans it: the core owns the role
// vocabulary, and the shipped skills are what actually speaks it to a provider.
const SKILLS_DIR = fileURLToPath(new URL('../../../plugins/claude-code/skills/', import.meta.url));

function roleLiteralsInSkills(): Array<{ skill: string; role: string }> {
  const found: Array<{ skill: string; role: string }> = [];
  for (const entry of readdirSync(SKILLS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    let body: string;
    try {
      body = readFileSync(`${SKILLS_DIR}${entry.name}/SKILL.md`, 'utf8');
    } catch {
      continue;
    }
    for (const match of body.matchAll(/role:\s*"([a-z_]+)"/g)) {
      found.push({ skill: entry.name, role: match[1] as string });
    }
  }
  return found;
}

describe('role values the shipped skills instruct an agent to send', () => {
  it('are all roles the core accepts', () => {
    // `blocked` became a flag rather than a role, and WORKFLOW_ROLES lost it — but task-list still
    // told the agent to answer "what is blocked?" with role: "blocked", a value the core rejects.
    // The skills are instructions to a model, so nothing type-checks them; this does.
    const literals = roleLiteralsInSkills();
    // Guards the guard: a changed quoting convention must not make this pass by finding nothing.
    expect(literals.length).toBeGreaterThan(0);
    const roles = new Set<string>(WORKFLOW_ROLES);
    expect(literals.filter(({ role }) => !roles.has(role))).toEqual([]);
  });
});
