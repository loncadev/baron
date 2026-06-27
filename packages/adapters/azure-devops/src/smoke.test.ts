import { describe, expect, it } from 'vitest';
import {
  createAzureDevOpsIntrospector,
  createAzureDevOpsTransport,
  defineAzureDevOpsIssuesAdapter,
  exampleAzureDevOpsRoleMap,
  exampleAzureDevOpsTypeMap,
} from './index.js';

const organization = process.env.AZURE_DEVOPS_ORG;
const project = process.env.AZURE_DEVOPS_PROJECT;
const token = process.env.AZURE_DEVOPS_TOKEN;
const live = Boolean(organization && project && token);

/**
 * Gated live smoke test: skipped unless AZURE_DEVOPS_ORG / AZURE_DEVOPS_PROJECT /
 * AZURE_DEVOPS_TOKEN are present. It exercises the real azure-devops-node-api transport +
 * introspector against a throwaway project. The role map here is illustrative; a real project's map
 * comes from `baron init`. Never commit credentials. The pure translation layer is covered
 * network-free by the conformance suite — this only proves the live wiring.
 */
describe.skipIf(!live)('azure-devops live smoke', () => {
  const build = () => {
    const transport = createAzureDevOpsTransport({
      organization: organization!,
      project: project!,
      token: token!,
    });
    return defineAzureDevOpsIssuesAdapter(
      { roleMap: exampleAzureDevOpsRoleMap, typeMap: exampleAzureDevOpsTypeMap, gapPolicy: {} },
      transport,
    );
  };

  it('creates a work item, moves its state, and reads it back', async () => {
    const adapter = build();
    const created = await adapter.create({
      title: `baron smoke ${new Date().toISOString()}`,
      typeRole: 'task',
    });
    expect(created.id).toBeTruthy();

    const active = await adapter.transition(created.id, 'in_progress');
    expect(active.role).toBe('in_progress');

    const fetched = await adapter.get(created.id);
    expect(fetched.nativeType).toBeTruthy();
  });

  it('introspects the live project as a rich, state-discriminated provider', async () => {
    const introspection = await createAzureDevOpsIntrospector({
      organization: organization!,
      project: project!,
      token: token!,
    }).introspect();
    expect(introspection.stateKey).toBe('state');
    expect(introspection.workItemTypes.length).toBeGreaterThan(0);
    expect(introspection.states.length).toBeGreaterThan(0);
  });
});
