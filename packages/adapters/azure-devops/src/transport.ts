import {
  ASSIGNEE_ME,
  BaronError,
  type IssuesTransport,
  type Iteration,
  type NativeComment,
  type NativeCreateInput,
  type NativeIssue,
  type NativeQuery,
  type NativeTarget,
} from '@lonca/baron-core';
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
  /** Team whose iterations/sprints are read. Defaults to Azure's `${project} Team` default team. */
  readonly team?: string | undefined;
}

/** Work-item field reference names this transport reads/writes (provider-native, not role concepts). */
const FIELD = {
  ID: 'System.Id',
  TEAM_PROJECT: 'System.TeamProject',
  TITLE: 'System.Title',
  DESCRIPTION: 'System.Description',
  STATE: 'System.State',
  TYPE: 'System.WorkItemType',
  TAGS: 'System.Tags',
  ASSIGNED_TO: 'System.AssignedTo',
  ITERATION_PATH: 'System.IterationPath',
  REPRO_STEPS: 'Microsoft.VSTS.TCM.ReproSteps',
} as const;

/**
 * Fields fetched for a query/list. Deliberately lean — a listing needs identity, role, type-role,
 * and labels, NOT the (potentially huge) Description body or the relations graph. `get` fetches the
 * full item; query is a lightweight projection so a large result can't blow the caller's context.
 */
const QUERY_FIELDS: readonly string[] = [
  FIELD.TITLE,
  FIELD.STATE,
  FIELD.TYPE,
  FIELD.TAGS,
  FIELD.ASSIGNED_TO,
  FIELD.ITERATION_PATH,
];

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
/** getWorkItems is server-capped at 200 ids; query results are fetched in batches of this size. */
const GET_WORK_ITEMS_BATCH = 200;

type WitApi = Awaited<ReturnType<InstanceType<typeof azdev.WebApi>['getWorkItemTrackingApi']>>;
type WorkApi = Awaited<ReturnType<InstanceType<typeof azdev.WebApi>['getWorkApi']>>;

function fieldPath(refName: string): string {
  return `/fields/${refName}`;
}

/** Escape a value for embedding in a single-quoted WIQL string literal. */
function escapeWiql(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * Build the WIQL for a query. The project clause is ALWAYS present: a teamContext passed to
 * `queryByWiql` does NOT constrain `FROM WorkItems`, which otherwise spans the entire organization —
 * the source of a query leaking every project's items. Exported for unit testing without the SDK.
 */
export function buildWorkItemsWiql(
  project: string,
  state?: string,
  nativeType?: string,
  assignee?: string,
  iterationPath?: string,
): string {
  const clauses = [`[${FIELD.TEAM_PROJECT}] = '${escapeWiql(project)}'`];
  if (state !== undefined) clauses.push(`[${FIELD.STATE}] = '${escapeWiql(state)}'`);
  if (nativeType !== undefined) clauses.push(`[${FIELD.TYPE}] = '${escapeWiql(nativeType)}'`);
  if (assignee !== undefined) {
    // '@me' rides WIQL's native @Me macro (no identity lookup needed); anything else is a literal.
    clauses.push(
      assignee === ASSIGNEE_ME
        ? `[${FIELD.ASSIGNED_TO}] = @Me`
        : `[${FIELD.ASSIGNED_TO}] = '${escapeWiql(assignee)}'`,
    );
  }
  if (iterationPath !== undefined) {
    // UNDER matches the iteration and any child iterations (a leaf sprint matches exactly).
    clauses.push(`[${FIELD.ITERATION_PATH}] UNDER '${escapeWiql(iterationPath)}'`);
  }
  return `SELECT [${FIELD.ID}] FROM WorkItems WHERE ${clauses.join(' AND ')}`;
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
  // Azure names the default team "{Project} Team"; iterations are team-scoped, so default to it.
  const team = options.team ?? `${project} Team`;
  const orgUrl = `https://dev.azure.com/${organization}`;
  const webApi = new azdev.WebApi(orgUrl, azdev.getPersonalAccessTokenHandler(token));

  // A clickable Boards URL (the item's own `url` field is the REST API endpoint, not a web page).
  const workItemWebUrl = (id: string): string =>
    `${orgUrl}/${encodeURIComponent(project)}/_workitems/edit/${id}`;

  let witApi: Promise<WitApi> | undefined;
  const api = (): Promise<WitApi> => {
    witApi ??= webApi.getWorkItemTrackingApi();
    return witApi;
  };
  let workApi: Promise<WorkApi> | undefined;
  const work = (): Promise<WorkApi> => {
    workApi ??= webApi.getWorkApi();
    return workApi;
  };

  // Resolve the '@me' assignment sentinel to the token owner's identity. Unlike WIQL reads (which
  // ride the @Me macro server-side), System.AssignedTo needs a concrete handle, so we read it from
  // the connection's authenticated user. Prefer the account/UPN (email); fall back to the display
  // name, which AssignedTo also accepts. Cached — one lookup per transport.
  let cachedMe: Promise<string> | undefined;
  const resolveCurrentUser = (): Promise<string> => {
    cachedMe ??= (async () => {
      const connection = await webApi.connect();
      const user = connection.authenticatedUser;
      const properties = (user?.properties ?? {}) as Record<
        string,
        { $value?: string } | undefined
      >;
      const handle =
        properties.Account?.$value ?? properties.Mail?.$value ?? user?.providerDisplayName;
      if (handle === undefined || handle.length === 0) {
        throw new BaronError(
          "Could not resolve the current Azure DevOps user for '@me' assignment; assign by explicit email instead.",
          'ASSIGNEE_ME_UNRESOLVED',
        );
      }
      return handle;
    })();
    return cachedMe;
  };

  const toNative = (item: WorkItem, discriminator?: string): NativeIssue => {
    const fields = item.fields ?? {};
    const parent = item.relations?.find((relation) => relation.rel === PARENT_REL);
    const state = String(fields[FIELD.STATE] ?? '');
    // Bugs carry their body in ReproSteps, other types in Description — surface whichever is present.
    const description = fields[FIELD.DESCRIPTION] ?? fields[FIELD.REPRO_STEPS];
    // AssignedTo is an IdentityRef object on reads; the stable, writable handle is uniqueName (email).
    const assignedTo = fields[FIELD.ASSIGNED_TO] as
      | { uniqueName?: string; displayName?: string }
      | undefined;
    const assignee = assignedTo?.uniqueName ?? assignedTo?.displayName;
    const iterationPath = fields[FIELD.ITERATION_PATH];
    return {
      id: String(item.id ?? ''),
      key: `AB#${item.id ?? ''}`,
      title: String(fields[FIELD.TITLE] ?? ''),
      body: description != null ? String(description) : undefined,
      nativeType: String(fields[FIELD.TYPE] ?? ''),
      discriminator: discriminator ?? state,
      parentId: parseTrailingId(parent?.url),
      labels: parseTags(fields[FIELD.TAGS]),
      assignee: assignee !== undefined && assignee.length > 0 ? assignee : undefined,
      iteration:
        typeof iterationPath === 'string' && iterationPath.length > 0 ? iterationPath : undefined,
      url: item.id != null ? workItemWebUrl(String(item.id)) : (item.url ?? undefined),
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
        // A Bug's primary body field is ReproSteps (what the triage/QA view shows), not Description —
        // route the abstract body there for the bug type role so repro steps land where Azure expects.
        const bodyField = input.typeRole === 'bug' ? FIELD.REPRO_STEPS : FIELD.DESCRIPTION;
        ops.push({ op: Operation.Add, path: fieldPath(bodyField), value: input.body });
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

    async addLabel(id: string, label: string): Promise<void> {
      const witApi = await api();
      const current = await fetch(witApi, Number(id));
      const tags = parseTags(current.fields?.[FIELD.TAGS]);
      if (tags.includes(label)) return;
      await witApi.updateWorkItem(
        null,
        [{ op: Operation.Add, path: fieldPath(FIELD.TAGS), value: [...tags, label].join('; ') }],
        Number(id),
      );
    },

    async addComment(id: string, body: string): Promise<NativeComment> {
      const witApi = await api();
      const comment = await witApi.addComment({ text: body }, project, Number(id));
      return {
        id: String(comment.id ?? ''),
        body: comment.text ?? body,
        author: comment.createdBy?.displayName,
        createdAt: comment.createdDate?.toISOString(),
        url: comment.url,
      };
    },

    currentUser(): Promise<string> {
      return resolveCurrentUser();
    },

    async assignIssue(id: string, assignee: string): Promise<NativeIssue> {
      const witApi = await api();
      // '@me' resolves to the token owner; anything else is a literal email/uniqueName Azure resolves.
      const handle = assignee === ASSIGNEE_ME ? await resolveCurrentUser() : assignee;
      const updated = await witApi.updateWorkItem(
        null,
        [{ op: Operation.Add, path: fieldPath(FIELD.ASSIGNED_TO), value: handle }],
        Number(id),
      );
      return toNative(updated);
    },

    async listIterations(): Promise<readonly Iteration[]> {
      const workApi = await work();
      const iterations = await workApi.getTeamIterations({ project, team });
      const now = Date.now();
      return (iterations ?? []).map((it): Iteration => {
        const start = it.attributes?.startDate;
        const finish = it.attributes?.finishDate;
        // Current = within [start, finish] by date. Undated iterations are never "current" — mirrors
        // Azure's own "no active sprint until dates are set" behaviour (the reference's warn case).
        const current =
          start != null && finish != null && start.getTime() <= now && now <= finish.getTime();
        return {
          id: String(it.id ?? it.path ?? ''),
          name: it.name ?? '',
          // System.IterationPath is backslash-separated; getTeamIterations returns a forward-slash
          // node path — normalize so setIteration's value round-trips as a valid IterationPath.
          path: (it.path ?? it.name ?? '').replace(/\//g, '\\'),
          ...(start != null ? { startDate: start.toISOString() } : {}),
          ...(finish != null ? { finishDate: finish.toISOString() } : {}),
          current,
        };
      });
    },

    async setIteration(id: string, iterationPath: string): Promise<NativeIssue> {
      const witApi = await api();
      const updated = await witApi.updateWorkItem(
        null,
        [{ op: Operation.Add, path: fieldPath(FIELD.ITERATION_PATH), value: iterationPath }],
        Number(id),
      );
      return toNative(updated);
    },

    async linkIssues(fromId: string, toId: string, nativeLinkType: string): Promise<void> {
      const witApi = await api();
      await witApi.updateWorkItem(
        null,
        [
          {
            op: Operation.Add,
            path: '/relations/-',
            value: { rel: nativeLinkType, url: `${orgUrl}/_apis/wit/workItems/${toId}` },
          },
        ],
        Number(fromId),
      );
    },

    async queryIssues(query: NativeQuery): Promise<readonly NativeIssue[]> {
      const witApi = await api();
      const wiql = buildWorkItemsWiql(
        project,
        query.target?.[TARGET.STATE],
        query.nativeType,
        query.assignee,
        query.iterationPath,
      );

      const result = await witApi.queryByWiql({ query: wiql }, { project }, undefined, query.limit);
      const ids = (result.workItems ?? [])
        .map((ref) => ref.id)
        .filter((id): id is number => id !== undefined);
      if (ids.length === 0) return [];

      // getWorkItems is server-capped at 200 ids; batch so a query matching more than 200 items
      // returns them all instead of failing with an opaque 400. A lean field set (no body/relations)
      // is requested so a large listing stays small — `get` is the full-fidelity read.
      const items: WorkItem[] = [];
      for (let offset = 0; offset < ids.length; offset += GET_WORK_ITEMS_BATCH) {
        const batch = await witApi.getWorkItems(
          ids.slice(offset, offset + GET_WORK_ITEMS_BATCH),
          [...QUERY_FIELDS],
          undefined,
          undefined,
          undefined,
          project,
        );
        items.push(...batch);
      }
      return items.map((item) => toNative(item));
    },
  };
}
