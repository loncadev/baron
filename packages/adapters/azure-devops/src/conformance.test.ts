import {
  azureIntrospectionFixture,
  createMemoryCiTransport,
  createMemoryDeployTransport,
  createMemoryIntrospector,
  createMemoryScmTransport,
  createMemoryTransport,
  runCiConformance,
  runDeployConformance,
  runIntrospectionConformance,
  runIssuesConformance,
  runScmConformance,
} from '@lonca/baron-conformance';
import { RecordingLogger } from '@lonca/baron-core';
import { describe, expect, it } from 'vitest';
import {
  azureDevOpsManifest,
  createAzureDevOpsTransport,
  defineAzureDevOpsCiAdapter,
  defineAzureDevOpsDeployAdapter,
  defineAzureDevOpsIssuesAdapter,
  defineAzureDevOpsScmAdapter,
  exampleAzureDevOpsRoleMap,
  exampleAzureDevOpsTypeMap,
} from './index.js';

runIssuesConformance({
  label: 'azure-devops',
  build(gapPolicy, typeMap = exampleAzureDevOpsTypeMap, fidelity = {}) {
    const logger = new RecordingLogger();
    // No untypedNativeType: Azure is told the type at create and reports it back verbatim.
    const transport = createMemoryTransport({
      stateKey: exampleAzureDevOpsRoleMap.stateKey,
      defaultDiscriminator: 'New',
      ...fidelity,
    });
    const adapter = defineAzureDevOpsIssuesAdapter(
      { roleMap: exampleAzureDevOpsRoleMap, typeMap, gapPolicy },
      transport,
      logger,
    );
    return { adapter, logger };
  },
  // Azure's own vocabulary: bug and task each get a type nobody else uses. subtask still shares
  // Task because the process has no Sub-task type — which is exactly what the map should say.
  distinctTypeMap: {
    initiative: 'Epic',
    epic: 'Feature',
    story: 'Product Backlog Item',
    task: 'Task',
    bug: 'Bug',
    subtask: 'Task',
  },
  mappedMidRole: 'in_review',
  mappedDoneRole: 'done',
  // 'ready' is the role neither example map binds — 'blocked' stopped being a role at all.
  unmappedRole: 'ready',
});

runIntrospectionConformance({
  label: 'azure-devops',
  manifest: azureDevOpsManifest,
  build: () => createMemoryIntrospector(azureIntrospectionFixture),
});

runScmConformance({
  label: 'azure-devops',
  build(gapPolicy) {
    const logger = new RecordingLogger();
    const adapter = defineAzureDevOpsScmAdapter(createMemoryScmTransport(), gapPolicy, logger);
    return { adapter, logger };
  },
});

runCiConformance({
  label: 'azure-devops',
  build(gapPolicy) {
    const logger = new RecordingLogger();
    const adapter = defineAzureDevOpsCiAdapter(createMemoryCiTransport(), gapPolicy, logger);
    return { adapter, logger };
  },
});

runDeployConformance({
  label: 'azure-devops',
  build(gapPolicy) {
    const logger = new RecordingLogger();
    const adapter = defineAzureDevOpsDeployAdapter(
      createMemoryDeployTransport(),
      gapPolicy,
      logger,
    );
    return { adapter, logger };
  },
});

// The blocked flag rides a label, so a provider that declares nativeLabels must be able to CLEAR
// one. `removeLabel` is optional on the transport contract — an exemption meant for providers whose
// roles do not ride labels — and Azure took it while still declaring nativeLabels, which made
// blocking a one-way door: block wrote the tag, unblock refused, and the only way out was the UI.
// The conformance suite cannot see this: it runs on the memory transport, which implements it.
describe('azure-devops transport label contract', () => {
  it('implements removeLabel, because its manifest declares nativeLabels', () => {
    const transport = createAzureDevOpsTransport({
      organization: 'o',
      project: 'p',
      token: 't',
    });
    expect(azureDevOpsManifest.issues.nativeLabels).toBe(true);
    expect(typeof transport.removeLabel).toBe('function');
  });
});
