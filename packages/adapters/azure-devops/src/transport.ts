import type { IssuesTransport, NativeCreateInput, NativeIssue, NativeTarget } from '@baron/core';
import * as azdev from 'azure-devops-node-api';
import {
  type WorkItem,
  WorkItemExpand,
} from 'azure-devops-node-api/interfaces/WorkItemTrackingInterfaces.js';
import { Operation } from 'azure-devops-node-api/interfaces/common/VSSInterfaces.js';
import type { JsonPatchOperation } from 'azure-devops-node-api/interfaces/common/VSSInterfaces.js';

export interface AzureDevOpsTransportOptions {
  readonly organization: string;
  readonly project: string;
  /** Personal access token. Read from env / secret-manager by the caller; never committed. */
  readonly token: string;
}

/** Work-item field reference names this transport reads/writes (provider-native, not role concepts). */
const FIELD = {
  TITLE: 'System.Title',
  DESCRIPTION: 'System.Description',
  STATE: 'System.State',
  TYPE: 'System.WorkItemType',
  TAGS: 'System.Tags',
} as const;

/** The relation that points to the PARENT in Azure's native hierarchy. */
const PARENT_REL = 'System.LinkTypes.Hierarchy-Reverse';

/**
 * NativeTarget keys this transport reads VERBATIM (invariant #4): the role map already turned roles
 * into these in BaseIssuesAdapter. `state` is the workflow state; `boardColumn` is the separate
 * board axis. The board column's backing field is a per-board hidden `WEF_<guid>_Kanban.Column`
 * field, discovered at runtime (System.BoardColumn itself is read-only).
 */
const TARGET = { STATE: 'state', BOARD_COLUMN: 'boardColumn' } as const;
const KANBAN_COLUMN_SUFFIX = '_Kanban.Column';

type WitApi = Awaited<ReturnType<InstanceType<typeof azdev.WebApi>['getWorkItemTrackingApi']>>;

function fieldPath(refName: string): string {
  return `/fields/${refName}`;
}

function parseTrailingId(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  const tail = url.split('/').pop();
  return tail && tail.length > 0 ? tail : undefined;
}

function parseTags(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  return raw
    .split(';')
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

/**
 * Live transport over the Azure DevOps REST API (azure-devops-node-api). Azure models work richly:
 * roles ride native states (the discriminator is System.State, fully faithful on reads), hierarchy
 * is a native parent relation, and the board column is a separate, best-effort axis. The
 * WorkItemTracking client is built lazily and cached (its first call fetches resource-area metadata).
 */
export function createAzureDevOpsTransport(options: AzureDevOpsTransportOptions): IssuesTransport {
  const { organization, project, token } = options;
  const orgUrl = `https://dev.azure.com/${organization}`;

  let witApi: Promise<WitApi> | undefined;
  const api = (): Promise<WitApi> => {
    witApi ??= new azdev.WebApi(
      orgUrl,
      azdev.getPersonalAccessTokenHandler(token),
    ).getWorkItemTrackingApi();
    return witApi;
  };

  const toNative = (item: WorkItem, discriminator?: string): NativeIssue => {
    const fields = item.fields ?? {};
    const parent = item.relations?.find((relation) => relation.rel === PARENT_REL);
    const state = String(fields[FIELD.STATE] ?? '');
    const description = fields[FIELD.DESCRIPTION];
    return {
      id: String(item.id ?? ''),
      key: `AB#${item.id ?? ''}`,
      title: String(fields[FIELD.TITLE] ?? ''),
      body: description != null ? String(description) : undefined,
      nativeType: String(fields[FIELD.TYPE] ?? ''),
      discriminator: discriminator ?? state,
      parentId: parseTrailingId(parent?.url),
      labels: parseTags(fields[FIELD.TAGS]),
      url: item.url ?? undefined,
    };
  };

  const fetch = async (witApi: WitApi, id: number): Promise<WorkItem> =>
    witApi.getWorkItem(id, undefined, undefined, WorkItemExpand.All, project);

  return {
    async createIssue(input: NativeCreateInput): Promise<NativeIssue> {
      const witApi = await api();
      const ops: JsonPatchOperation[] = [
        { op: Operation.Add, path: fieldPath(FIELD.TITLE), value: input.title },
      ];
      if (input.body !== undefined) {
        ops.push({ op: Operation.Add, path: fieldPath(FIELD.DESCRIPTION), value: input.body });
      }
      if (input.labels.length > 0) {
        // System.Tags is the inverse of parseTags on read; without this, labels (and any emulated
        // parent:<id> label) would be silently dropped despite the nativeLabels capability.
        ops.push({
          op: Operation.Add,
          path: fieldPath(FIELD.TAGS),
          value: input.labels.join('; '),
        });
      }
      if (input.parentId !== undefined) {
        ops.push({
          op: Operation.Add,
          path: '/relations/-',
          value: { rel: PARENT_REL, url: `${orgUrl}/_apis/wit/workItems/${input.parentId}` },
        });
      }
      const created = await witApi.createWorkItem(null, ops, project, input.nativeType);
      return toNative(created);
    },

    async getIssue(id: string): Promise<NativeIssue> {
      const witApi = await api();
      return toNative(await fetch(witApi, Number(id)));
    },

    async applyTarget(id: string, target: NativeTarget): Promise<NativeIssue> {
      const witApi = await api();
      const numId = Number(id);
      const state = target[TARGET.STATE];
      const column = target[TARGET.BOARD_COLUMN];

      const ops: JsonPatchOperation[] = [];
      if (state !== undefined) {
        ops.push({ op: Operation.Add, path: fieldPath(FIELD.STATE), value: state });
      }
      if (column !== undefined) {
        // The writable board-column field is a per-board hidden WEF field; discover it on the item.
        // Azure also auto-derives the column from state via the board's stateMappings, so if the
        // field is absent (item never placed on a board) we rely on that rather than failing.
        const current = await fetch(witApi, numId);
        const wefField = Object.keys(current.fields ?? {}).find((key) =>
          key.endsWith(KANBAN_COLUMN_SUFFIX),
        );
        if (wefField !== undefined) {
          ops.push({ op: Operation.Add, path: fieldPath(wefField), value: column });
        }
      }

      if (ops.length === 0) {
        return toNative(await fetch(witApi, numId), state);
      }
      // State + column go in ONE patch (atomic transition, per ARCHITECTURE decision #6).
      const updated = await witApi.updateWorkItem(null, ops, numId);
      return toNative(updated, state);
    },
  };
}
