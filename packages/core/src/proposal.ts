import type { CapabilityManifest } from './capabilities.js';
import type { NativeTarget, TypeMap } from './config.js';
import type { IntrospectedState, ProviderIntrospection, StateCategory } from './introspection.js';
import type { PolicyRoleMapEntry } from './policy-file.js';
import type { WorkItemTypeRole, WorkflowRole } from './roles.js';

/**
 * A draft policy for one provider, produced from introspection for a human to confirm. Every fuzzy
 * or skipped decision is recorded in `notes` so `baron init` can surface exactly what it guessed —
 * the proposal is never silently authoritative (decision #4: introspected + human-confirmed).
 */
export interface ProviderProposal {
  readonly provider: string;
  readonly roleMap: PolicyRoleMapEntry;
  readonly typeMap: TypeMap;
  /** On-disk gap-behavior strings ('emulate:labels' | 'degrade' | ...), keyed by capability. */
  readonly gapPolicy: Record<string, string>;
  readonly notes: readonly string[];
}

/** Which native state category each workflow role is drawn from on a rich provider. */
const ROLE_CATEGORY: Partial<Record<WorkflowRole, StateCategory>> = {
  backlog: 'proposed',
  in_progress: 'in_progress',
  in_review: 'resolved',
  done: 'completed',
};

/** Keyword probes for matching a board column to a role (English defaults; a human confirms). */
const COLUMN_KEYWORDS: Partial<Record<WorkflowRole, RegExp>> = {
  in_progress: /progress|doing|active|develop/i,
  in_review: /review|test|qa|verify/i,
  done: /done|closed|complete|resolved/i,
};

/** Keyword probes for matching a native work-item type to a type role. */
const TYPE_KEYWORDS: Record<WorkItemTypeRole, RegExp> = {
  initiative: /initiative|theme/i,
  epic: /epic/i,
  story: /story|backlog item|pbi|feature|requirement/i,
  task: /^task$|task|to-?do/i,
  subtask: /sub-?task/i,
};

function firstStateByCategory(
  states: readonly IntrospectedState[],
  category: StateCategory,
): string | undefined {
  return states.find((s) => s.category === category)?.name;
}

function matchColumn(columns: readonly string[], probe: RegExp): string | undefined {
  return columns.find((c) => probe.test(c));
}

/**
 * Propose a role map from introspection. Branches on the provider's capability manifest — the heart
 * of the impedance bet: a rich provider (arbitrary states) draws each role from a native state by
 * category and attaches a board column when one is found; a flat provider rides mid-workflow roles
 * on labels and closes the issue for `done`.
 */
export function proposeRoleMap(
  introspection: ProviderIntrospection,
  manifest: CapabilityManifest,
): { entry: PolicyRoleMapEntry; notes: string[] } {
  const notes: string[] = [];
  const states: Partial<Record<WorkflowRole, NativeTarget>> = {};

  if (manifest.issues.arbitraryStates) {
    const stateKey = introspection.stateKey;
    for (const [role, category] of Object.entries(ROLE_CATEGORY) as [
      WorkflowRole,
      StateCategory,
    ][]) {
      const stateName = firstStateByCategory(introspection.states, category);
      if (stateName === undefined) {
        notes.push(`No '${category}'-category state found for role '${role}'; left unmapped.`);
        continue;
      }
      const target: NativeTarget = { [stateKey]: stateName };
      if (manifest.issues.separateBoardColumn && introspection.boardColumns) {
        const probe = COLUMN_KEYWORDS[role];
        const column = probe ? matchColumn(introspection.boardColumns, probe) : undefined;
        if (column !== undefined) {
          target.boardColumn = column;
          notes.push(`Matched board column '${column}' to role '${role}' by keyword; confirm it.`);
        }
      }
      states[role] = target;
    }
    return { entry: { stateKey, states }, notes };
  }

  // Flat provider: arbitrary workflow states must be emulated. Mid-workflow roles ride on labels;
  // `done` closes the issue. The discriminator is therefore the label, not the native state.
  const doneState = firstStateByCategory(introspection.states, 'completed');
  states.in_progress = { label: 'in-progress' };
  states.in_review = { label: 'in-review' };
  states.done = doneState ? { state: doneState, label: 'done' } : { label: 'done' };
  notes.push(
    `Provider '${introspection.provider}' has no arbitrary states; mid-workflow roles are ` +
      'proposed as labels and emulated. backlog/ready/blocked are left unmapped — add if needed.',
  );
  if (doneState === undefined) {
    notes.push("No 'completed'-category state found; 'done' will not close the issue natively.");
  }
  return { entry: { stateKey: 'label', states }, notes };
}

/**
 * Propose a type map from introspection. A provider with a single native type (GitHub) collapses
 * every type role onto it (lossy — noted); a provider with many types matches each role by keyword.
 */
export function proposeTypeMap(introspection: ProviderIntrospection): {
  typeMap: TypeMap;
  notes: string[];
} {
  const notes: string[] = [];
  const typeMap: Record<string, string> = {};
  const types = introspection.workItemTypes;

  if (types.length === 1) {
    const only = types[0]?.name;
    if (only !== undefined) {
      for (const role of Object.keys(TYPE_KEYWORDS) as WorkItemTypeRole[]) {
        typeMap[role] = only;
      }
      notes.push(
        `Provider '${introspection.provider}' exposes one native type ('${only}'); all type ` +
          'roles collapse onto it (reverse type-role resolution is lossy).',
      );
    }
    return { typeMap: typeMap as TypeMap, notes };
  }

  for (const [role, probe] of Object.entries(TYPE_KEYWORDS) as [WorkItemTypeRole, RegExp][]) {
    const match = types.find((t) => probe.test(t.name));
    if (match !== undefined) {
      typeMap[role] = match.name;
    } else {
      notes.push(`No native type matched type role '${role}'; left unmapped.`);
    }
  }
  return { typeMap: typeMap as TypeMap, notes };
}

/**
 * Propose a gap policy from the manifest: every unsupported capability gets an explicit behavior so
 * the gap is never silent. Hierarchy and arbitrary states are emulated via labels; sprints and
 * sub-issues degrade with a warning. A human can override any of these.
 */
export function proposeGapPolicy(manifest: CapabilityManifest): {
  gapPolicy: Record<string, string>;
  notes: string[];
} {
  const notes: string[] = [];
  const gapPolicy: Record<string, string> = {};
  const caps = manifest.issues;

  if (!caps.hierarchy) gapPolicy.hierarchy = 'emulate:labels';
  if (!caps.arbitraryStates) gapPolicy.arbitraryStates = 'emulate:labels';
  if (!caps.sprints) gapPolicy.sprints = 'degrade';
  if (!caps.subIssues) gapPolicy.subIssues = 'degrade';

  if (!caps.nativeLabels && (gapPolicy.hierarchy || gapPolicy.arbitraryStates)) {
    notes.push(
      `Provider '${manifest.provider}' lacks native labels but label emulation was proposed; ` +
        'review the gap policy — emulation may not be viable.',
    );
  }
  return { gapPolicy, notes };
}

/** Assemble a full per-provider {@link ProviderProposal} from introspection plus its manifest. */
export function proposePolicy(
  introspection: ProviderIntrospection,
  manifest: CapabilityManifest,
): ProviderProposal {
  const role = proposeRoleMap(introspection, manifest);
  const type = proposeTypeMap(introspection);
  const gap = proposeGapPolicy(manifest);
  return {
    provider: introspection.provider,
    roleMap: role.entry,
    typeMap: type.typeMap,
    gapPolicy: gap.gapPolicy,
    notes: [...role.notes, ...type.notes, ...gap.notes],
  };
}
