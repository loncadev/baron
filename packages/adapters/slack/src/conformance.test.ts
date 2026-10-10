import { createMemoryNotifyTransport, runNotifyConformance } from '@zanaat/baron-conformance';
import { RecordingLogger } from '@zanaat/baron-core';
import { defineSlackNotifyAdapter } from './index.js';

runNotifyConformance({
  label: 'slack',
  build(gapPolicy) {
    const logger = new RecordingLogger();
    const adapter = defineSlackNotifyAdapter(createMemoryNotifyTransport(), gapPolicy, logger);
    return { adapter, logger };
  },
});
