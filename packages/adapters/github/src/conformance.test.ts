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
  build(gapPolicy, typeMap = exampleGithubTypeMap, fidelity = {}) {
    const logger = new RecordingLogger();
    const transport = createMemoryTransport({
      stateKey: exampleGithubRoleMap.stateKey,
      defaultDiscriminator: 'open',
      // `POST /issues` accepts no type, so a real GitHub issue reads back untyped no matter what
      // the map asked for. Echoing the requested type here would prove a fidelity this adapter
      // does not have — and did, right up until a bug started branching feature/.
      untypedNativeType: 'issue',
      // `listForRepo` cannot filter by type. Filtering here would let the suite prove a server-side
      // filter this adapter does not have, and the port's emulation would never be exercised.
      filtersByType: false,
      ...fidelity,
    });
    const adapter = defineGithubIssuesAdapter(
      { roleMap: exampleGithubRoleMap, typeMap, gapPolicy },
      transport,
      logger,
    );
    return { adapter, logger };
  },
  // The org's real Issue Types, the way `baron init` now proposes them for a repo that has them.
  distinctTypeMap: {
    initiative: 'issue',
    epic: 'Feature',
    story: 'issue',
    task: 'Task',
    bug: 'Bug',
    subtask: 'issue',
  },
  mappedMidRole: 'in_review',
  mappedDoneRole: 'done',
  // 'ready' is the role neither example map binds — 'blocked' stopped being a role at all.
  unmappedRole: 'ready',
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
