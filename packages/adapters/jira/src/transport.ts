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
  /** The site root, e.g. `https://acme.atlassian.net`. A trailing slash is tolerated. */
  readonly site: string;
  /** The Atlassian account email the API token was issued to. */
  readonly email: string;
  /** An API token from id.atlassian.com. Sent as HTTP Basic with the email; never as a Bearer. */
  readonly apiToken: string;
  /** Project key (e.g. `PROJ`) new issues are created in and queries are scoped to. */
  readonly project: string;
  readonly fetchImpl?: typeof fetch | undefined;
}

/** The field set every read asks for, so one parser serves create, get, update and search. */
const ISSUE_FIELDS = 'summary,description,status,issuetype,parent,labels,assignee';

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
  const site = opts.site.replace(/\/+$/, '');
  const doFetch = opts.fetchImpl ?? fetch;
  const authorization = `Basic ${Buffer.from(`${opts.email}:${opts.apiToken}`).toString('base64')}`;

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await doFetch(`${site}${API_PREFIX}${path}`, {
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

  const toNative = (issue: JiraIssue): NativeIssue => ({
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
    url: `${site}/browse/${issue.key}`,
  });

  const fetchIssue = (key: string): Promise<JiraIssue> =>
    call<JiraIssue>('GET', `/issue/${encodeURIComponent(key)}?fields=${ISSUE_FIELDS}`);

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
      return toNative(await fetchIssue(created.key));
    },

    async getIssue(id: string): Promise<NativeIssue> {
      return toNative(await fetchIssue(id));
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
      return toNative(await fetchIssue(id));
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
      const data = await call<{ issues: JiraIssue[] }>('POST', '/search/jql', {
        jql: `${clauses.join(' AND ')} ORDER BY updated DESC`,
        maxResults: query.limit ?? 50,
        fields: ISSUE_FIELDS.split(','),
      });
      return data.issues.map(toNative);
    },

    async updateIssue(id: string, update: NativeUpdateInput): Promise<NativeIssue> {
      await call<void>('PUT', `/issue/${encodeURIComponent(id)}`, {
        fields: {
          ...(update.title !== undefined ? { summary: update.title } : {}),
          ...(update.body !== undefined ? { description: update.body } : {}),
        },
      });
      return toNative(await fetchIssue(id));
    },

    async assignIssue(id: string, assignee: string): Promise<NativeIssue> {
      await call<void>('PUT', `/issue/${encodeURIComponent(id)}/assignee`, {
        accountId: await accountId(assignee),
      });
      return toNative(await fetchIssue(id));
    },

    async currentUser(): Promise<string> {
      const me = await call<JiraUser>('GET', '/myself');
      // The same handle `toNative` reports for an assignee, so `assign('@me')` then a read agree.
      return me.emailAddress ?? me.displayName ?? me.accountId;
    },

    // Sprints live in the Jira Software (agile) API, on boards rather than projects, and the
    // manifest declares `sprints: false`, so the core degrades or errors by policy before reaching
    // these. They exist because the contract requires them; reaching one is a core bug.
    async listIterations(): Promise<readonly Iteration[]> {
      throw new BaronError(
        'Jira sprints are not supported by this adapter yet (the manifest declares sprints: false).',
        ERROR_CODE,
      );
    },

    async setIteration(): Promise<NativeIssue> {
      throw new BaronError(
        'Jira sprints are not supported by this adapter yet (the manifest declares sprints: false).',
        ERROR_CODE,
      );
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
