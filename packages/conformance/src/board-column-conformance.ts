import {
  BaseIssuesAdapter,
  BoardColumnUnreachableError,
  type CapabilityManifest,
  type GapPolicy,
  type IssuesPort,
  type Logger,
  type ProviderRoleMap,
} from '@lonca/baron-core';
import { describe, expect, it } from 'vitest';
import { createMemoryTransport } from './memory-transport.js';

/**
 * The contract for a provider whose board column is separate from the state, where an individual
 * item may not be able to take the column its role maps to.
 *
 * Azure is the case that forces it. A backlog item's board has one set of columns; a Bug on a sprint
 * Taskboard has another, and an item on no sprint has no Taskboard at all. The transport used to drop
 * a column it could not write without a word, and Azure then shows the card in the LAST column mapped
 * to its state — a card moved to Test read "Waiting for Release" with nothing verified.
 *
 * What the suite pins down: the core asks BEFORE writing, so under the default policy a refusal
 * leaves the item exactly where it was, and under `degrade` the state moves alone with a warning.
 * Never a silent drop (invariant 5).
 */

const NEW = 'New';
const TEST = 'Test';
const VERIFIED = 'Waiting for Release';

const ROLE_MAP: ProviderRoleMap = {
  stateKey: 'state',
  states: {
    backlog: { state: NEW },
    in_review: { state: TEST, boardColumn: VERIFIED },
  },
};

const manifest: CapabilityManifest = {
  provider: 'board-memory',
  issues: {
    hierarchy: true,
    subIssues: false,
    separateBoardColumn: true,
    sprints: false,
    arbitraryStates: true,
    nativeLabels: true,
    nativeTypes: true,
    typeFiltering: true,
    comments: true,
    issueLinks: true,
    assignment: true,
  },
};

/** A Bug's board has the extra column; a story's does not. */
const COLUMNS: Record<string, readonly string[]> = {
  Bug: [NEW, TEST, VERIFIED],
  Story: [NEW, TEST],
};

function recordingLogger(): Logger & { readonly warnings: string[] } {
  const warnings: string[] = [];
  const ignore = (): void => {};
  return {
    warnings,
    debug: ignore,
    info: ignore,
    error: ignore,
    warn: (message) => warnings.push(message),
  };
}

function adapter(gapPolicy: GapPolicy, logger: Logger): IssuesPort {
  return new BaseIssuesAdapter(
    manifest,
    {
      provider: 'board-memory',
      roleMap: ROLE_MAP,
      typeMap: { bug: 'Bug', story: 'Story' },
      gapPolicy,
    },
    createMemoryTransport({ stateKey: 'state', defaultDiscriminator: NEW, columnsFor: COLUMNS }),
    logger,
  );
}

export function runBoardColumnConformance(): void {
  describe('a provider whose board column not every item can reach', () => {
    it('writes state and column together when the item can take the column', async () => {
      const logger = recordingLogger();
      const port = adapter({}, logger);
      const bug = await port.create({ title: 'x', typeRole: 'bug' });
      expect((await port.transition(bug.id, 'in_review')).role).toBe('in_review');
      expect(logger.warnings).toEqual([]);
    });

    it('refuses before writing anything under the default policy, and says why', async () => {
      const logger = recordingLogger();
      const port = adapter({}, logger);
      const story = await port.create({ title: 'x', typeRole: 'story' });
      const attempt = port.transition(story.id, 'in_review');
      await expect(attempt).rejects.toBeInstanceOf(BoardColumnUnreachableError);
      await expect(port.transition(story.id, 'in_review')).rejects.toThrow(
        /Story items have no column 'Waiting for Release'/,
      );
      // Nothing was written: a refusal that had already moved the state would leave the item
      // half-moved, which is worse than either outcome the caller could have chosen.
      expect((await port.get(story.id)).role).toBe('backlog');
    });

    it('moves the state alone and warns under degrade — never a silent drop', async () => {
      const logger = recordingLogger();
      const port = adapter({ separateBoardColumn: { kind: 'degrade' } }, logger);
      const story = await port.create({ title: 'x', typeRole: 'story' });
      // The memory transport refuses a column the item cannot take, so this only passes if the core
      // stripped the column before writing rather than leaving it for the transport to drop.
      expect((await port.transition(story.id, 'in_review')).role).toBe('in_review');
      expect(logger.warnings).toHaveLength(1);
    });
  });
}
