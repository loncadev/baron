import {
  createMemoryCiTransport,
  createMemoryIntrospector,
  createMemoryScmTransport,
  createMemoryTransport,
  githubIntrospectionFixture,
  runCiConformance,
  runIntrospectionConformance,
  runIssuesConformance,
  runScmConformance,
} from '@baron/conformance';
import { RecordingLogger } from '@baron/core';
import {
  defineGithubCiAdapter,
  defineGithubIssuesAdapter,
  defineGithubScmAdapter,
  exampleGithubRoleMap,
  exampleGithubTypeMap,
  githubManifest,
} from './index.js';

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

runIntrospectionConformance({
  label: 'github',
  manifest: githubManifest,
  build: () => createMemoryIntrospector(githubIntrospectionFixture),
});

runScmConformance({
  label: 'github',
  build(gapPolicy) {
    const logger = new RecordingLogger();
    const adapter = defineGithubScmAdapter(createMemoryScmTransport(), gapPolicy, logger);
    return { adapter, logger };
  },
});

runCiConformance({
  label: 'github',
  build(gapPolicy) {
    const logger = new RecordingLogger();
    // GitHub-native sample so the github status maps drive real normalization (the shared
    // in-memory transport defaults to Azure-shaped natives).
    const transport = createMemoryCiTransport({
      runs: [
        { id: '1', pipelineId: 'w1', pipelineName: 'CI', status: 'completed', result: 'success' },
        { id: '2', pipelineId: 'w1', status: 'in_progress' },
      ],
    });
    const adapter = defineGithubCiAdapter(transport, gapPolicy, logger);
    return { adapter, logger };
  },
});
