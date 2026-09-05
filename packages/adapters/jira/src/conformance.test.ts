import {
  createMemoryTransport,
  runIssuesConformance,
  runTransportFidelityConformance,
} from '@lonca/baron-conformance';
import { RecordingLogger } from '@lonca/baron-core';
import {
  defineJiraIssuesAdapter,
  exampleJiraRoleMap,
  exampleJiraTypeMap,
  jiraManifest,
} from './index.js';

const BACKLOG = exampleJiraRoleMap.states.backlog?.[exampleJiraRoleMap.stateKey] ?? 'To Do';

runIssuesConformance({
  label: 'jira',
  build(gapPolicy, typeMap = exampleJiraTypeMap, fidelity = {}) {
    const logger = new RecordingLogger();
    // Ungated on purpose: this suite proves the translation layer, and the gate Jira adds on top
    // — reachable targets and transition screens — has its own suite (gated-transitions) that the
    // real transport is held to in transport.test.ts, through the core.
    const transport = createMemoryTransport({
      stateKey: exampleJiraRoleMap.stateKey,
      defaultDiscriminator: BACKLOG,
      ...fidelity,
    });
    const adapter = defineJiraIssuesAdapter(
      { roleMap: exampleJiraRoleMap, typeMap, gapPolicy },
      transport,
      logger,
    );
    return { adapter, logger };
  },
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
  label: 'jira',
  manifest: jiraManifest,
  build: () =>
    createMemoryTransport({
      stateKey: exampleJiraRoleMap.stateKey,
      defaultDiscriminator: BACKLOG,
    }),
});
