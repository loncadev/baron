import { createMemoryNotifyTransport, runNotifyConformance } from '@baron/conformance';
import { RecordingLogger } from '@baron/core';
import { defineSlackNotifyAdapter } from './index.js';

runNotifyConformance({
  label: 'slack',
  build(gapPolicy) {
    const logger = new RecordingLogger();
    const adapter = defineSlackNotifyAdapter(createMemoryNotifyTransport(), gapPolicy, logger);
    return { adapter, logger };
  },
});
