import { KnowledgeLoop, type KnowledgeLoopOptions } from './loop.js';
import { createMarkdownKnowledgeStore } from './markdown-store.js';

/**
 * Build a {@link KnowledgeLoop} backed by the default local markdown store at `dir`. The one call an
 * entrypoint (MCP server, CLI `run`) needs to give an agent a durable, committable knowledge loop.
 */
export function createLocalKnowledgeLoop(
  dir: string,
  options?: KnowledgeLoopOptions,
): KnowledgeLoop {
  return new KnowledgeLoop(createMarkdownKnowledgeStore(dir), options);
}
