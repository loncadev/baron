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
import {
  azureDevOpsManifest,
  defineAzureDevOpsCiAdapter,
  defineAzureDevOpsDeployAdapter,
  defineAzureDevOpsIssuesAdapter,
  defineAzureDevOpsScmAdapter,
  exampleAzureDevOpsRoleMap,
  exampleAzureDevOpsTypeMap,
} from './index.js';

runIssuesConformance({
  label: 'azure-devops',
  build(gapPolicy, typeMap = exampleAzureDevOpsTypeMap) {
    const logger = new RecordingLogger();
    // No untypedNativeType: Azure is told the type at create and reports it back verbatim.
    const transport = createMemoryTransport({
      stateKey: exampleAzureDevOpsRoleMap.stateKey,
      defaultDiscriminator: 'New',
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
