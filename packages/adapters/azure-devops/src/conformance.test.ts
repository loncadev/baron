import {
  azureIntrospectionFixture,
  createMemoryCiTransport,
  createMemoryIntrospector,
  createMemoryScmTransport,
  createMemoryTransport,
  runCiConformance,
  runIntrospectionConformance,
  runIssuesConformance,
  runScmConformance,
} from '@baron/conformance';
import { RecordingLogger } from '@baron/core';
import {
  azureDevOpsManifest,
  defineAzureDevOpsCiAdapter,
  defineAzureDevOpsIssuesAdapter,
  defineAzureDevOpsScmAdapter,
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
