import { createMemoryTransport, runIssuesConformance } from '@baron/conformance';
import { RecordingLogger } from '@baron/core';
import { defineGithubIssuesAdapter, exampleGithubRoleMap, exampleGithubTypeMap } from './index.js';

runIssuesConformance({
  label: 'github',
  build(gapPolicy) {
    const logger = new RecordingLogger();
    const transport = createMemoryTransport({
      stateKey: exampleGithubRoleMap.stateKey,
      defaultDiscriminator: 'open',
    });
    const adapter = defineGithubIssuesAdapter(
      { roleMap: exampleGithubRoleMap, typeMap: exampleGithubTypeMap, gapPolicy },
      transport,
      logger,
    );
    return { adapter, logger };
  },
  mappedMidRole: 'in_review',
  mappedDoneRole: 'done',
  unmappedRole: 'blocked',
});
