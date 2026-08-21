import { BaronError } from '@lonca/baron-core';
import { describe, expect, it } from 'vitest';
import { loadRecipe, parseRecipe } from './recipe.js';

const validYaml = `
name: task-start
description: Start a task.
steps:
  - ask: { as: title, type: text, message: "Title?" }
  - do: issue.create
    as: issue
    with:
      title: \${title}
      typeRole: task
  - do: issue.transition
    with:
      id: \${issue.id}
      role: in_progress
  - message: "Created \${issue.key}"
`;

describe('loadRecipe', () => {
  it('parses a well-formed YAML recipe', () => {
    const recipe = loadRecipe(validYaml);
    expect(recipe.name).toBe('task-start');
    expect(recipe.steps).toHaveLength(4);
    expect(recipe.steps[0]).toEqual({
      ask: { as: 'title', type: 'text', message: 'Title?' },
    });
  });
});

describe('parseRecipe', () => {
  it('rejects a recipe with no name', () => {
    expect(() => parseRecipe({ steps: [{ message: 'x' }] })).toThrow(BaronError);
  });

  it('rejects empty steps', () => {
    expect(() => parseRecipe({ name: 'r', steps: [] })).toThrow(/non-empty array/);
  });

  it('rejects an unknown do op', () => {
    expect(() => parseRecipe({ name: 'r', steps: [{ do: 'issue.delete' }] })).toThrow(
      /'do' must be/,
    );
  });

  it('rejects an ask without a bind variable', () => {
    expect(() =>
      parseRecipe({ name: 'r', steps: [{ ask: { type: 'text', message: 'x' } }] }),
    ).toThrow(/ask.as/);
  });

  it('rejects a choice ask without choices', () => {
    expect(() =>
      parseRecipe({ name: 'r', steps: [{ ask: { as: 'c', type: 'choice', message: 'x' } }] }),
    ).toThrow(/choices is required/);
  });

  it('rejects a step with more than one of ask/do/message', () => {
    expect(() =>
      parseRecipe({
        name: 'r',
        steps: [{ ask: { as: 'x', type: 'text', message: 'm' }, do: 'issue.create' }],
      }),
    ).toThrow(/exactly one of/);
  });

  it('rejects a step that is none of ask/do/message/require', () => {
    expect(() => parseRecipe({ name: 'r', steps: [{ frob: true }] })).toThrow(
      /'ask', 'do', 'for_each', 'message', or 'require'/,
    );
  });

  it('rejects a require step without a message or with multiple condition keys', () => {
    expect(() => parseRecipe({ name: 'r', steps: [{ require: { truthy: '${x}' } }] })).toThrow(
      /require\.message/,
    );
    expect(() =>
      parseRecipe({
        name: 'r',
        steps: [{ require: { truthy: '${x}', falsy: '${y}', message: 'm' } }],
      }),
    ).toThrow(/exactly one of/);
  });

  it('parses when: on do and message steps', () => {
    const recipe = parseRecipe({
      name: 'r',
      steps: [
        { do: 'issue.comment', with: { id: '1', body: 'b' }, when: { truthy: '${x}' } },
        { message: 'm', when: { notEquals: ['${a}', 'done'] } },
      ],
    });
    expect(recipe.steps).toHaveLength(2);
  });

  it('parses when: on a require step (conditional guard)', () => {
    const recipe = parseRecipe({
      name: 'r',
      steps: [
        {
          require: { truthy: '${takeover}', message: 'assigned — confirm takeover' },
          when: { truthy: '${issue.assignee}' },
        },
      ],
    });
    const step = recipe.steps[0];
    expect(step).toMatchObject({
      require: { truthy: '${takeover}' },
      when: { truthy: '${issue.assignee}' },
    });
  });
});

describe('parseRecipe — for_each', () => {
  const parse = (body: string) => () => loadRecipe(`name: r\nsteps:\n${body}`);

  it('refuses a loop inside a loop', () => {
    // Easier to allow later than to take back. One level covers every sweep Baron has, and nested
    // loops over provider calls are a runaway nobody authored on purpose.
    expect(
      parse(
        '  - for_each: "${a}"\n    as: x\n    steps:\n      - for_each: "${b}"\n        as: y\n        steps:\n          - message: hi\n',
      ),
    ).toThrow(/may not contain another for_each/);
  });

  it("refuses an 'ask' inside a loop", () => {
    // recipeInputs hoists asks so a caller can supply them upfront, which is what makes a recipe
    // runnable in one shot over MCP. An ask in a loop is invisible to that AND asks once per element.
    expect(
      parse(
        '  - for_each: "${a}"\n    as: x\n    steps:\n      - ask: { as: q, type: text, message: "?" }\n',
      ),
    ).toThrow(/may not contain an 'ask'/);
  });

  it('requires the element name and a non-empty body', () => {
    expect(parse('  - for_each: "${a}"\n    steps:\n      - message: hi\n')).toThrow(/needs 'as'/);
    expect(parse('  - for_each: "${a}"\n    as: x\n')).toThrow(/non-empty 'steps'/);
  });

  it('validates the collect spec rather than ignoring a malformed one', () => {
    expect(
      parse(
        '  - for_each: "${a}"\n    as: x\n    collect: { as: out }\n    steps:\n      - message: hi\n',
      ),
    ).toThrow(/'from' must be/);
  });
});
