import {
  createMemoryIntrospector,
  createMemoryScmTransport,
  createMemoryTransport,
  githubIntrospectionFixture,
  runIntrospectionConformance,
  runIssuesConformance,
  runScmConformance,
} from '@baron/conformance';
import { RecordingLogger } from '@baron/core';
import {
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
