import {
  createMemoryTransport,
  runIssuesConformance,
  runTransportFidelityConformance,
} from '@lonca/baron-conformance';
import { RecordingLogger } from '@lonca/baron-core';
import {
  defineLinearIssuesAdapter,
  exampleLinearRoleMap,
  exampleLinearTypeMap,
  linearManifest,
} from './index.js';

/** The scope the example map describes; the fake reports it on every item, as Linear does. */
const SCOPE = 'ENG';
const OWNED = Object.values(exampleLinearRoleMap.scopes?.[SCOPE] ?? {}).map(
  (target) => target?.[exampleLinearRoleMap.stateKey] as string,
);

runIssuesConformance({
  label: 'linear',
  build(gapPolicy, typeMap = exampleLinearTypeMap, fidelity = {}) {
    const logger = new RecordingLogger();
    const transport = createMemoryTransport({
      stateKey: exampleLinearRoleMap.stateKey,
      defaultDiscriminator: 'eng-backlog',
      // Linear has no work-item type at all — `IssueCreateInput` has no field for one — so whatever
      // the map asks for reads back as the single kind of thing Linear models. Echoing the request
      // would prove a fidelity this adapter cannot have.
      untypedNativeType: 'Issue',
      // `IssueFilter` has no work-item type to filter on, so the core's post-filter emulation is
      // what has to work. Filtering here would hide that it is doing the job.
      filtersByType: false,
      // Every state belongs to a team, so the fake refuses another team's id exactly as Linear does.
      scope: SCOPE,
      ownedDiscriminators: OWNED,
      ...fidelity,
    });
    const adapter = defineLinearIssuesAdapter(
      { roleMap: exampleLinearRoleMap, typeMap, gapPolicy },
      transport,
      logger,
    );
    return { adapter, logger };
  },
  /**
   * A map claiming `bug` and `task` are distinct native types. Linear can never produce one — it has
   * no issue types, so `baron init` will always map every role onto the same thing — but the suite
   * asks what happens when a map says they differ, and Linear's honest answer is that the native
   * type is lost and the `type:<role>` label has to carry it. Feeding a map Linear cannot produce is
   * what makes that loss observable.
   */
  distinctTypeMap: {
    initiative: 'Initiative',
    epic: 'Epic',
    story: 'Story',
    task: 'Task',
    bug: 'Bug',
    subtask: 'Sub-task',
  },
  mappedMidRole: 'in_review',
  mappedDoneRole: 'done',
  // The example map leaves `ready` out on purpose, so the suite has an unmapped role to assert on.
  unmappedRole: 'ready',
});

runTransportFidelityConformance({
  label: 'linear',
  manifest: linearManifest,
  build: () =>
    createMemoryTransport({
      stateKey: exampleLinearRoleMap.stateKey,
      defaultDiscriminator: 'eng-backlog',
      scope: SCOPE,
      ownedDiscriminators: OWNED,
    }),
});
