import {
  createMemoryCiTransport,
  createMemoryDeployTransport,
  createMemoryIntrospector,
  createMemoryScmTransport,
  createMemoryTransport,
  githubIntrospectionFixture,
  runCiConformance,
  runDeployConformance,
  runIntrospectionConformance,
  runIssuesConformance,
  runScmConformance,
} from '@lonca/baron-conformance';
import { RecordingLogger } from '@lonca/baron-core';
import {
  defineGithubCiAdapter,
  defineGithubDeployAdapter,
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

runDeployConformance({
  label: 'github',
  build(gapPolicy) {
    const logger = new RecordingLogger();
    // GitHub-native sample so the github deploy status maps drive real normalization.
    const transport = createMemoryDeployTransport({
      deployments: [
        { id: '1', environment: 'production', status: 'success', ref: 'main', sha: 'abc' },
        { id: '2', environment: 'staging', status: 'in_progress', ref: 'main' },
      ],
    });
    const adapter = defineGithubDeployAdapter(transport, gapPolicy, logger);
    return { adapter, logger };
  },
});
