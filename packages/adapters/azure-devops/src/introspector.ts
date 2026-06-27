import type {
  IntrospectedState,
  IntrospectedType,
  Introspector,
  ProviderIntrospection,
  StateCategory,
} from '@baron/core';
import * as azdev from 'azure-devops-node-api';
import type { TeamContext } from 'azure-devops-node-api/interfaces/CoreInterfaces.js';
import { AZURE_DEVOPS_PROVIDER } from './index.js';
import type { AzureDevOpsTransportOptions } from './transport.js';

/** Map Azure's state metaState category onto Baron's StateCategory vocabulary. */
function mapCategory(category: string | undefined): StateCategory {
  switch ((category ?? '').toLowerCase()) {
    case 'proposed':
      return 'proposed';
    case 'inprogress':
      return 'in_progress';
    case 'resolved':
      return 'resolved';
    case 'completed':
      return 'completed';
    case 'removed':
      return 'removed';
    default:
      return 'unknown';
  }
}

/**
 * Live introspection over the Azure DevOps REST API. Pulls the project's work-item types and their
 * states (with categories) from the WorkItemTracking API, then the board columns and iterations from
 * the Work API (which are team-scoped, so a TeamContext is built from the Core API's first team).
 * Board/iteration discovery is best-effort: a project with no accessible team still yields a valid
 * type/state vocabulary. Carries no role-mapping logic (invariant #4) — that lives in the proposal.
 */
export function createAzureDevOpsIntrospector(options: AzureDevOpsTransportOptions): Introspector {
  const { organization, project, token } = options;
  const orgUrl = `https://dev.azure.com/${organization}`;

  return {
    async introspect(): Promise<ProviderIntrospection> {
      const connection = new azdev.WebApi(orgUrl, azdev.getPersonalAccessTokenHandler(token));
      const witApi = await connection.getWorkItemTrackingApi();

      const types = await witApi.getWorkItemTypes(project);
      const workItemTypes: IntrospectedType[] = types
        .filter((type) => type.isDisabled !== true && type.name !== undefined)
        .map((type) => ({ name: type.name as string }));

      // Aggregate states across all types, keeping the first category seen for each state name.
      const stateCategories = new Map<string, StateCategory>();
      for (const type of types) {
        for (const state of type.states ?? []) {
          if (state.name !== undefined && !stateCategories.has(state.name)) {
            stateCategories.set(state.name, mapCategory(state.category));
          }
        }
      }
      const states: IntrospectedState[] = [...stateCategories].map(([name, category]) => ({
        name,
        category,
      }));

      const { boardColumns, iterations } = await introspectBoards(connection, project);

      return {
        provider: AZURE_DEVOPS_PROVIDER,
        stateKey: 'state',
        workItemTypes,
        states,
        ...(boardColumns !== undefined ? { boardColumns } : {}),
        ...(iterations !== undefined ? { iterations } : {}),
      };
    },
  };
}

/** Best-effort, team-scoped board column + iteration discovery; undefined when no team is reachable. */
async function introspectBoards(
  connection: azdev.WebApi,
  project: string,
): Promise<{ boardColumns?: string[]; iterations?: string[] }> {
  try {
    const coreApi = await connection.getCoreApi();
    const teams = await coreApi.getTeams(project);
    const team = teams[0]?.name;
    if (team === undefined) return {};

    const teamContext: TeamContext = { project, team };
    const workApi = await connection.getWorkApi();

    const columnNames = new Set<string>();
    const boards = await workApi.getBoards(teamContext);
    for (const board of boards) {
      if (board.id === undefined) continue;
      const columns = await workApi.getBoardColumns(teamContext, board.id);
      for (const column of columns) {
        if (column.name !== undefined) columnNames.add(column.name);
      }
    }

    const teamIterations = await workApi.getTeamIterations(teamContext);
    const iterations = teamIterations
      .map((iteration) => iteration.name)
      .filter((name): name is string => name !== undefined);

    return {
      ...(columnNames.size > 0 ? { boardColumns: [...columnNames] } : {}),
      ...(iterations.length > 0 ? { iterations } : {}),
    };
  } catch {
    // No accessible team / boards -> a valid type+state vocabulary is still useful.
    return {};
  }
}
