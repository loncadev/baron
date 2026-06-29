import { describe, expect, it } from 'vitest';
import { buildWorkItemsWiql } from './transport.js';

describe('buildWorkItemsWiql', () => {
  it('always scopes to the project so a query never spans the whole organization', () => {
    const wiql = buildWorkItemsWiql('BeeMaster');
    expect(wiql).toContain("[System.TeamProject] = 'BeeMaster'");
    expect(wiql).toBe("SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = 'BeeMaster'");
  });

  it('adds state and type clauses, AND-combined, when provided', () => {
    const wiql = buildWorkItemsWiql('BeeMaster', 'New', 'Product Backlog Item');
    expect(wiql).toBe(
      "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = 'BeeMaster' AND " +
        "[System.State] = 'New' AND [System.WorkItemType] = 'Product Backlog Item'",
    );
  });

  it('escapes single quotes in every value (WIQL injection guard)', () => {
    const wiql = buildWorkItemsWiql("O'Brien", "Won't Do");
    expect(wiql).toContain("[System.TeamProject] = 'O''Brien'");
    expect(wiql).toContain("[System.State] = 'Won''t Do'");
  });
});
