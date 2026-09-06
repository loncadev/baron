import { BaronError } from '@lonca/baron-core';
import type {
  IssuesTransport,
  Iteration,
  NativeComment,
  NativeCreateInput,
  NativeIssue,
  NativeQuery,
  NativeTarget,
  NativeUpdateInput,
  TransitionField,
  TransitionFields,
} from '@lonca/baron-core';
import { JIRA_STATE_KEY } from './provider.js';
import { normalizeSite } from './site.js';

const ERROR_CODE = 'JIRA_API';

/**
 * REST v2, not v3, and deliberately. v3 speaks Atlassian Document Format for every description and
 * comment body — a JSON tree Baron would have to render on the way out and flatten on the way in,
 * losing formatting in both directions. v2 takes and returns plain text (Jira wiki markup) in the
 * same fields, is fully supported on Jira Cloud, and shares every other endpoint this transport
 * uses, including the newer `search/jql`.
 */
const API_PREFIX = '/rest/api/2';

/** The sentinel the core sends for "whoever holds this credential"; Jira has `currentUser()` for it. */
const ME = '@me';

export interface JiraTransportOptions {
  /** The site root, e.g. `https://acme.atlassian.net`. A missing scheme or trailing slash is tolerated. */
  readonly site: string;
  /** The Atlassian account email the API token was issued to. */
  readonly email: string;
  /** An API token from id.atlassian.com. Sent as HTTP Basic with the email; never as a Bearer. */
  readonly apiToken: string;
  /** Project key (e.g. `PROJ`) new issues are created in and queries are scoped to. */
  readonly project: string;
  /**
   * The Scrum board whose sprints are the project's iterations, by id or name. Sprints belong to
   * boards, not projects, and a project can have several; unset, the first Scrum board for the
   * project is used, and a project with none simply has no iterations.
   */
  readonly board?: string | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
}

/** The field set every read asks for, so one parser serves create, get, update and search. */
const ISSUE_FIELDS = 'summary,description,status,issuetype,parent,labels,assignee';

/** Sprints live on the Jira Software API, under a different prefix on the same host. */
const AGILE_PREFIX = '/rest/agile/1.0';

/** How Jira identifies its sprint field: the id varies per site, the schema type does not. */
const SPRINT_FIELD_SCHEMA = 'com.pyxis.greenhopper.jira:gh-sprint';

/** Jira's sprint states; `active` is the one the core calls the current iteration. */
const SPRINT_ACTIVE = 'active';

interface JiraSprint {
  id: number;
  name: string;
  state: string;
  startDate?: string;
  endDate?: string;
}

interface JiraUser {
  accountId: string;
  displayName?: string | null;
  emailAddress?: string | null;
}

interface JiraIssue {
  id: string;
  key: string;
  fields: {
    summary: string;
    description?: string | null;
    status: { id: string; name: string };
    issuetype: { id: string; name: string; subtask?: boolean };
    parent?: { id: string; key: string } | null;
    labels?: string[] | null;
    assignee?: JiraUser | null;
    /** The sprint custom field, under whatever id this site gave it. */
    [custom: string]: unknown;
  };
}

interface JiraTransition {
  id: string;
  name: string;
  to: { id: string; name: string };
  fields?: Record<
    string,
    {
      required: boolean;
      name?: string;
      allowedValues?: Array<{ name?: string; value?: string; id?: string | number }>;
    }
  >;
}

/** JQL string literal: double-quoted, with the two characters that would break out escaped. */
function jql(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Jira Cloud's REST transport.
 *
 * Two things about Jira shape everything here. A status cannot be SET: the workflow permits some
 * transitions from the issue's current status, each landing on one status, and a transition may
 * carry a screen that demands fields. So `applyTarget` finds the transition whose destination is the
 * target and performs it, `availableTargets` reports the destinations reachable right now, and
 * `transitionFields` reports what the screen wants — all three from the one `transitions` read the
 * core's gated-transition contract was designed around. And the issue KEY (`PROJ-123`) is the id
 * everywhere: every endpoint accepts it, it is what a person calls the issue, and it reads well in
 * a branch name, so the numeric id is never surfaced.
 */
export function createJiraTransport(opts: JiraTransportOptions): IssuesTransport {
  const site = normalizeSite(opts.site);
  const doFetch = opts.fetchImpl ?? fetch;
  const authorization = `Basic ${Buffer.from(`${opts.email}:${opts.apiToken}`).toString('base64')}`;

  async function call<T>(
    method: string,
    path: string,
    body?: unknown,
    prefix: string = API_PREFIX,
  ): Promise<T> {
    const response = await doFetch(`${site}${prefix}${path}`, {
      method,
      headers: {
        authorization,
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new BaronError(
        `Jira API ${method} ${path}: ${describeFailure(response.status, text)}`,
        ERROR_CODE,
      );
    }
    // 204 on transitions, assignee and label updates: nothing to parse, and parsing "" throws.
    return (text.length > 0 ? JSON.parse(text) : undefined) as T;
  }

  const agile = <T>(method: string, path: string, body?: unknown): Promise<T> =>
    call<T>(method, path, body, AGILE_PREFIX);

  // The sprint field's id differs per site (customfield_10020 on one, another number elsewhere),
  // so it is discovered once from the field catalogue by its schema type and cached for the life
  // of the transport. Undefined when the site has no Jira Software at all.
  let sprintFieldId: Promise<string | undefined> | undefined;
  const sprintField = (): Promise<string | undefined> => {
    sprintFieldId ??= call<Array<{ id: string; schema?: { custom?: string } }>>(
      'GET',
      '/field',
    ).then((fields) => fields.find((f) => f.schema?.custom === SPRINT_FIELD_SCHEMA)?.id);
    return sprintFieldId;
  };

  /** The sprint the issue is in now: the last entry, since Jira keeps the ones it was carried over from. */
  const currentSprintName = (issue: JiraIssue, field: string | undefined): string | undefined => {
    if (field === undefined) return undefined;
    const value = issue.fields[field];
    if (!Array.isArray(value) || value.length === 0) return undefined;
    const last: unknown = value[value.length - 1];
    if (typeof last === 'object' && last !== null && 'name' in last) {
      return String((last as { name: unknown }).name);
    }
    // Older payloads serialise the sprint as "…Sprint@1a2b[id=1,…,name=Sprint 1,…]".
    return typeof last === 'string' ? /name=([^,\]]+)/.exec(last)?.[1] : undefined;
  };

  const toNative = (issue: JiraIssue, field?: string): NativeIssue => ({
    id: issue.key,
    key: issue.key,
    title: issue.fields.summary,
    body: issue.fields.description ?? undefined,
    nativeType: issue.fields.issuetype.name,
    discriminator: issue.fields.status.name,
    parentId: issue.fields.parent?.key ?? undefined,
    labels: issue.fields.labels ?? [],
    // The email when the site shows it; Atlassian's privacy controls can hide it, and then the
    // display name is the only handle a person would recognise.
    assignee:
      issue.fields.assignee?.emailAddress ?? issue.fields.assignee?.displayName ?? undefined,
    iteration: currentSprintName(issue, field),
    url: `${site}/browse/${issue.key}`,
  });

  const issueFields = async (): Promise<string[]> => {
    const field = await sprintField();
    return field === undefined ? ISSUE_FIELDS.split(',') : [...ISSUE_FIELDS.split(','), field];
  };

  const fetchIssue = async (key: string): Promise<NativeIssue> => {
    const fields = await issueFields();
    const issue = await call<JiraIssue>(
      'GET',
      `/issue/${encodeURIComponent(key)}?fields=${fields.join(',')}`,
    );
    return toNative(issue, await sprintField());
  };

  // Resolved once: by id or name when configured, else the project's first Scrum board. A project
  // with no Scrum board has no sprints, which is an honest empty rather than an error.
  let boardId: Promise<number | undefined> | undefined;
  const scrumBoard = (): Promise<number | undefined> => {
    boardId ??= agile<{ values: Array<{ id: number; name: string }> }>(
      'GET',
      `/board?projectKeyOrId=${encodeURIComponent(opts.project)}&type=scrum`,
    ).then(({ values }) => {
      const wanted = opts.board;
      if (wanted === undefined || wanted.length === 0) return values[0]?.id;
      return values.find((b) => String(b.id) === wanted || b.name === wanted)?.id;
    });
    return boardId;
  };

  const sprints = async (): Promise<readonly JiraSprint[]> => {
    const board = await scrumBoard();
    if (board === undefined) return [];
    return (await agile<{ values: JiraSprint[] }>('GET', `/board/${board}/sprint?maxResults=100`))
      .values;
  };

  const toIteration = (sprint: JiraSprint): Iteration => ({
    id: String(sprint.id),
    name: sprint.name,
    // The name is the path: it is what a person calls the sprint and what JQL accepts.
    path: sprint.name,
    ...(sprint.startDate !== undefined ? { startDate: sprint.startDate } : {}),
    ...(sprint.endDate !== undefined ? { finishDate: sprint.endDate } : {}),
    current: sprint.state === SPRINT_ACTIVE,
  });

  /** A sprint by its path (name) or id, or a refusal that names the ones that exist. */
  const findSprint = async (iterationPath: string): Promise<JiraSprint> => {
    const known = await sprints();
    const found = known.find((s) => s.name === iterationPath || String(s.id) === iterationPath);
    if (found === undefined) {
      throw new BaronError(
        `Jira has no sprint '${iterationPath}' on the project's Scrum board` +
          `${known.length > 0 ? ` (it has: ${known.map((s) => s.name).join(', ')})` : ' (it has none)'}.`,
        ERROR_CODE,
      );
    }
    return found;
  };

  const transitions = (key: string, withFields: boolean): Promise<JiraTransition[]> =>
    call<{ transitions: JiraTransition[] }>(
      'GET',
      `/issue/${encodeURIComponent(key)}/transitions${withFields ? '?expand=transitions.fields' : ''}`,
    ).then((data) => data.transitions);

  const toTarget = (transition: JiraTransition): NativeTarget => ({
    [JIRA_STATE_KEY]: transition.to.name,
  });

  function wantedStatus(target: NativeTarget): string {
    const status = target[JIRA_STATE_KEY];
    if (status === undefined) {
      throw new BaronError(
        `Jira targets are keyed by '${JIRA_STATE_KEY}'; this one carries ` +
          `${Object.keys(target).join(', ') || 'nothing'}.`,
        ERROR_CODE,
      );
    }
    return status;
  }

  async function accountId(handle: string): Promise<string> {
    if (handle === ME) return (await call<JiraUser>('GET', '/myself')).accountId;
    const found = await call<JiraUser[]>('GET', `/user/search?query=${encodeURIComponent(handle)}`);
    const match =
      found.find((user) => user.emailAddress === handle) ??
      found.find((user) => user.displayName === handle) ??
      found[0];
    if (match === undefined) {
      throw new BaronError(`Jira user '${handle}' not found on this site.`, ERROR_CODE);
    }
    return match.accountId;
  }

  const updateLabels = (key: string, op: 'add' | 'remove', label: string): Promise<void> =>
    call<void>('PUT', `/issue/${encodeURIComponent(key)}`, {
      update: { labels: [{ [op]: label }] },
    });

  return {
    async createIssue(input: NativeCreateInput): Promise<NativeIssue> {
      const created = await call<{ key: string }>('POST', '/issue', {
        fields: {
          project: { key: opts.project },
          summary: input.title,
          issuetype: { name: input.nativeType },
          ...(input.body !== undefined ? { description: input.body } : {}),
          // One `parent` field serves both a sub-task under its story and a story under its epic:
          // Jira unified the two in 2022, so nothing here has to know which kind of child this is.
          ...(input.parentId !== undefined ? { parent: { key: input.parentId } } : {}),
          ...(input.labels.length > 0 ? { labels: [...input.labels] } : {}),
        },
      });
      // The create response carries only id/key/self, so the issue is read back for its fields.
      return fetchIssue(created.key);
    },

    async getIssue(id: string): Promise<NativeIssue> {
      return fetchIssue(id);
    },

    async applyTarget(
      id: string,
      target: NativeTarget,
      fields?: TransitionFields,
    ): Promise<NativeIssue> {
      const status = wantedStatus(target);
      const permitted = await transitions(id, false);
      const transition = permitted.find((t) => t.to.name === status);
      if (transition === undefined) {
        // The core normally refuses this earlier via `availableTargets`; reached only when a
        // transition vanished between the two reads. Jira's own 400 would say less.
        throw new BaronError(
          `Jira has no transition to '${status}' from this issue's current status ` +
            `(it permits: ${permitted.map((t) => t.to.name).join(', ') || 'nothing'}).`,
          ERROR_CODE,
        );
      }
      await call<void>('POST', `/issue/${encodeURIComponent(id)}/transitions`, {
        transition: { id: transition.id },
        // Passed through untouched: what `resolution` means, and what shape its value takes, is
        // Jira's business (invariant 4). The core only checked the required ones were present.
        ...(fields !== undefined && Object.keys(fields).length > 0 ? { fields } : {}),
      });
      return fetchIssue(id);
    },

    async availableTargets(id: string): Promise<readonly NativeTarget[]> {
      return (await transitions(id, false)).map(toTarget);
    },

    async transitionFields(id: string, target: NativeTarget): Promise<readonly TransitionField[]> {
      const status = wantedStatus(target);
      const transition = (await transitions(id, true)).find((t) => t.to.name === status);
      // No transition to that target: nothing to demand. Reachability is `availableTargets`' job,
      // and the core has already asked it by the time it asks this.
      if (transition === undefined) return [];
      return Object.entries(transition.fields ?? {}).map(([name, field]) => {
        const allowed = field.allowedValues
          ?.map(
            (value) =>
              value.name ?? value.value ?? (value.id !== undefined ? String(value.id) : undefined),
          )
          .filter((value): value is string => value !== undefined);
        return {
          name,
          required: field.required,
          ...(allowed !== undefined && allowed.length > 0 ? { allowedValues: allowed } : {}),
        };
      });
    },

    async addLabel(id: string, label: string): Promise<void> {
      await updateLabels(id, 'add', label);
    },

    async removeLabel(id: string, label: string): Promise<void> {
      // Removing a label the issue does not carry is a no-op on Jira's side too, so no read-first.
      await updateLabels(id, 'remove', label);
    },

    // No `ensureLabels`: Jira labels are free-form strings that exist by being used, so there is
    // nothing to provision and the base adapter's no-op is the correct behaviour.

    async addComment(id: string, body: string): Promise<NativeComment> {
      const comment = await call<{
        id: string;
        body: string;
        author?: JiraUser | null;
        created?: string;
      }>('POST', `/issue/${encodeURIComponent(id)}/comment`, { body });
      return {
        id: comment.id,
        body: comment.body,
        author: comment.author?.emailAddress ?? comment.author?.displayName ?? undefined,
        createdAt: comment.created,
      };
    },

    async linkIssues(fromId: string, toId: string, nativeLinkType: string): Promise<void> {
      // Jira links are directional and named from the OUTWARD side: for "Blocks", the outward
      // issue blocks the inward one. `from` is always the outward side here, which is what makes
      // the abstract `blocks` map onto the type's name with no direction flag of its own.
      await call<void>('POST', '/issueLink', {
        type: { name: nativeLinkType },
        outwardIssue: { key: fromId },
        inwardIssue: { key: toId },
      });
    },

    async queryIssues(query: NativeQuery): Promise<readonly NativeIssue[]> {
      const clauses = [`project = ${jql(opts.project)}`];
      const statuses = (query.targets ?? [])
        .map((target) => target[JIRA_STATE_KEY])
        .filter((value): value is string => value !== undefined);
      if (statuses.length > 0) clauses.push(`status in (${statuses.map(jql).join(', ')})`);
      if (query.nativeType !== undefined) clauses.push(`issuetype = ${jql(query.nativeType)}`);
      if (query.assignee !== undefined) {
        clauses.push(
          query.assignee === ME ? 'assignee = currentUser()' : `assignee = ${jql(query.assignee)}`,
        );
      }
      if (query.iterationPath !== undefined) {
        // By id, not name: a name is unique on a board, not across a site, and the id is what the
        // board answered when the path was resolved from it.
        clauses.push(`sprint = ${(await findSprint(query.iterationPath)).id}`);
      }
      const data = await call<{ issues: JiraIssue[] }>('POST', '/search/jql', {
        jql: `${clauses.join(' AND ')} ORDER BY updated DESC`,
        maxResults: query.limit ?? 50,
        fields: await issueFields(),
      });
      const field = await sprintField();
      return data.issues.map((issue) => toNative(issue, field));
    },

    async updateIssue(id: string, update: NativeUpdateInput): Promise<NativeIssue> {
      await call<void>('PUT', `/issue/${encodeURIComponent(id)}`, {
        fields: {
          ...(update.title !== undefined ? { summary: update.title } : {}),
          ...(update.body !== undefined ? { description: update.body } : {}),
        },
      });
      return fetchIssue(id);
    },

    async assignIssue(id: string, assignee: string): Promise<NativeIssue> {
      await call<void>('PUT', `/issue/${encodeURIComponent(id)}/assignee`, {
        accountId: await accountId(assignee),
      });
      return fetchIssue(id);
    },

    async currentUser(): Promise<string> {
      const me = await call<JiraUser>('GET', '/myself');
      // The same handle `toNative` reports for an assignee, so `assign('@me')` then a read agree.
      return me.emailAddress ?? me.displayName ?? me.accountId;
    },

    async listIterations(): Promise<readonly Iteration[]> {
      return (await sprints()).map(toIteration);
    },

    async setIteration(id: string, iterationPath: string): Promise<NativeIssue> {
      const sprint = await findSprint(iterationPath);
      // Moving an issue INTO a sprint is a sprint operation on the agile API, not an issue edit:
      // the sprint field is not writable through the platform API.
      await agile<void>('POST', `/sprint/${sprint.id}/issue`, { issues: [id] });
      return fetchIssue(id);
    },
  };
}

/**
 * Jira's error bodies come in two shapes — `errorMessages: []` for the request as a whole and
 * `errors: { field: message }` per field — and a transition screen rejection uses the second, so
 * both are read. Every message, not the first: showing one sends you round the loop once per field.
 */
function describeFailure(status: number, text: string): string {
  try {
    const payload = JSON.parse(text) as {
      errorMessages?: string[];
      errors?: Record<string, string>;
    };
    const messages = [
      ...(payload.errorMessages ?? []),
      ...Object.entries(payload.errors ?? {}).map(([field, message]) => `${field}: ${message}`),
    ];
    if (messages.length > 0) return `HTTP ${status} — ${messages.join('; ')}`;
  } catch {
    // Not JSON (a proxy page, an empty body): fall through to the status alone.
  }
  return `HTTP ${status}`;
}
