import {
  azureIntrospectionFixture,
  createMemoryIntrospector,
  createMemoryTransport,
  runIntrospectionConformance,
  runIssuesConformance,
} from '@baron/conformance';
import { RecordingLogger } from '@baron/core';
import {
  azureDevOpsManifest,
  defineAzureDevOpsIssuesAdapter,
  exampleAzureDevOpsRoleMap,
  exampleAzureDevOpsTypeMap,
} from './index.js';

runIssuesConformance({
  label: 'azure-devops',
  build(gapPolicy) {
    const logger = new RecordingLogger();
    const transport = createMemoryTransport({
      stateKey: exampleAzureDevOpsRoleMap.stateKey,
      defaultDiscriminator: 'New',
    });
    const adapter = defineAzureDevOpsIssuesAdapter(
      { roleMap: exampleAzureDevOpsRoleMap, typeMap: exampleAzureDevOpsTypeMap, gapPolicy },
      transport,
      logger,
    );
    return { adapter, logger };
  },
  mappedMidRole: 'in_review',
  mappedDoneRole: 'done',
  unmappedRole: 'blocked',
});

runIntrospectionConformance({
  label: 'azure-devops',
  manifest: azureDevOpsManifest,
  build: () => createMemoryIntrospector(azureIntrospectionFixture),
});
