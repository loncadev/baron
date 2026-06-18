import { createMemoryTransport, runIssuesConformance } from '@baron/conformance';
import { RecordingLogger } from '@baron/core';
import {
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
