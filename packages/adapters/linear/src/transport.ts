import { BaronError } from '@lonca/baron-core';
import type {
  IssuesTransport,
  Iteration,
  LabelSpec,
  NativeComment,
  NativeCreateInput,
  NativeIssue,
  NativeQuery,
  NativeTarget,
  NativeUpdateInput,
} from '@lonca/baron-core';
import { LINEAR_STATE_KEY } from './provider.js';

const ENDPOINT = 'https://api.linear.app/graphql';
const ERROR_CODE = 'LINEAR_API';

export interface LinearTransportOptions {
  /**
   * A personal API key. Sent as a bare `Authorization` header — Linear reserves `Bearer` for OAuth
   * access tokens, and prefixing a personal key with it fails as "authentication required", which
   * reads like a bad key rather than a bad header.
   */
  readonly apiKey: string;
  /** Team key (e.g. `BAR`) new issues are created in. Linear requires a team on every create. */
  readonly team: string;
  readonly endpoint?: string | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
}

/** The issue shape every read returns, so one parser serves create, get, update and query. */
const ISSUE_FIELDS = `
  id
  identifier
  title
  description
  url
  state { id name type }
  team { id key }
  parent { id }
  assignee { id displayName email }
  cycle { id name }
  labels { nodes { id name } }
`;

interface GqlIssue {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  url?: string | null;
  state: { id: string; name: string; type: string };
  team: { id: string; key: string };
  parent?: { id: string } | null;
  assignee?: { id: string; displayName?: string | null; email?: string | null } | null;
  cycle?: { id: string; name?: string | null } | null;
  labels: { nodes: Array<{ id: string; name: string }> };
}

/**
 * Linear's GraphQL transport.
 *
 * Two things about Linear shape everything here. Its workflow states belong to a TEAM rather than
 * the workspace, so every issue reports its team as the scope the core resolves roles in — that is
 * the whole reason `NativeIssue.scope` exists. And `WorkflowState.type` is a bare `String`, not an
 * enum (the live API returns values, `duplicate` among them, that no published list contains), so
 * nothing here ever derives a role from it: roles come from the confirmed map, always.
 */
export function createLinearTransport(opts: LinearTransportOptions): IssuesTransport {
  const endpoint = opts.endpoint ?? ENDPOINT;
  const doFetch = opts.fetchImpl ?? fetch;

  async function gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const response = await doFetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: opts.apiKey },
      body: JSON.stringify({ query, ...(variables !== undefined ? { variables } : {}) }),
    });
    const payload = (await response.json()) as { data?: T; errors?: Array<{ message: string }> };
    if (payload.errors !== undefined && payload.errors.length > 0) {
      // Every message, not the first: Linear reports each invalid field separately, and showing one
      // sends you round the loop once per field.
      throw new BaronError(
        `Linear API: ${payload.errors.map((e) => e.message).join('; ')}`,
        ERROR_CODE,
      );
    }
    if (payload.data === undefined) {
      throw new BaronError('Linear API returned no data and no error.', ERROR_CODE);
    }
    return payload.data;
  }

  const toNative = (issue: GqlIssue): NativeIssue => ({
    id: issue.id,
    key: issue.identifier,
    title: issue.title,
    body: issue.description ?? undefined,
    // Linear has no work-item type: an issue is an issue. The abstract type role rides a label, the
    // same emulation GitHub uses, and the manifest declares `nativeTypes: false` so the core knows.
    nativeType: 'Issue',
    discriminator: issue.state.id,
    // The team is the scope: a role resolves to a different state id in each one.
    scope: issue.team.key,
    parentId: issue.parent?.id ?? undefined,
    labels: issue.labels.nodes.map((label) => label.name),
    assignee: issue.assignee?.email ?? issue.assignee?.displayName ?? undefined,
    iteration: issue.cycle?.name ?? undefined,
    url: issue.url ?? undefined,
  });

  async function teamId(): Promise<string> {
    const data = await gql<{ teams: { nodes: Array<{ id: string; key: string }> } }>(
      '{ teams { nodes { id key } } }',
    );
    const found = data.teams.nodes.find((team) => team.key === opts.team);
    if (found === undefined) {
      throw new BaronError(
        `Linear team '${opts.team}' not found (workspace has: ${data.teams.nodes
          .map((team) => team.key)
          .join(', ')}).`,
        ERROR_CODE,
      );
    }
    return found.id;
  }

  async function fetchIssue(id: string): Promise<GqlIssue> {
    const data = await gql<{ issue: GqlIssue | null }>(
      `query($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`,
      { id },
    );
    if (data.issue === null) throw new BaronError(`Linear issue '${id}' not found.`, ERROR_CODE);
    return data.issue;
  }

  /**
   * Resolve a label NAME to its id, creating it when absent.
   *
   * Baron's transport contract passes label names; Linear's `issueAddLabel` takes an id. Creating
   * the missing one rather than failing is what makes the role/type-role label emulation work at
   * all — the first `in-review` in a fresh workspace has no label to attach.
   */
  async function labelId(team: string, name: string): Promise<string> {
    const data = await gql<{ issueLabels: { nodes: Array<{ id: string; name: string }> } }>(
      '{ issueLabels { nodes { id name } } }',
    );
    const existing = data.issueLabels.nodes.find((label) => label.name === name);
    if (existing !== undefined) return existing.id;
    const created = await gql<{ issueLabelCreate: { issueLabel: { id: string } } }>(
      'mutation($input: IssueLabelCreateInput!) { issueLabelCreate(input: $input) { issueLabel { id } } }',
      { input: { name, teamId: team } },
    );
    return created.issueLabelCreate.issueLabel.id;
  }

  return {
    async createIssue(input: NativeCreateInput): Promise<NativeIssue> {
      const team = await teamId();
      const data = await gql<{ issueCreate: { issue: GqlIssue } }>(
        `mutation($input: IssueCreateInput!) { issueCreate(input: $input) { issue { ${ISSUE_FIELDS} } } }`,
        {
          input: {
            teamId: team,
            title: input.title,
            ...(input.body !== undefined ? { description: input.body } : {}),
            ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
            ...(input.labels.length > 0
              ? { labelIds: await Promise.all(input.labels.map((l) => labelId(team, l))) }
              : {}),
          },
        },
      );
      return toNative(data.issueCreate.issue);
    },

    async getIssue(id: string): Promise<NativeIssue> {
      return toNative(await fetchIssue(id));
    },

    async applyTarget(id: string, target: NativeTarget): Promise<NativeIssue> {
      const stateId = target[LINEAR_STATE_KEY];
      if (stateId === undefined) {
        throw new BaronError(
          `Linear targets are keyed by '${LINEAR_STATE_KEY}'; this one carries ` +
            `${Object.keys(target).join(', ') || 'nothing'}.`,
          ERROR_CODE,
        );
      }
      // Deliberately NOT pre-validating that the state belongs to the issue's team: Linear rejects
      // it itself, and its refusal is the more trustworthy answer. Duplicating the check here would
      // add a round trip to agree with the provider.
      const data = await gql<{ issueUpdate: { issue: GqlIssue } }>(
        `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { issue { ${ISSUE_FIELDS} } } }`,
        { id, input: { stateId } },
      );
      return toNative(data.issueUpdate.issue);
    },

    /**
     * The states the item's own team owns.
     *
     * Linear does not gate transitions — any of its team's states is reachable — so this is not a
     * workflow question here, it is an identity one. `WorkflowState.team` is non-null, so a role map
     * pointing at another team's state id is a real and easy mistake; answering with this team's
     * states turns the provider's eventual rejection into a refusal that names what IS available,
     * before the write rather than after it.
     */
    async availableTargets(id: string): Promise<readonly NativeTarget[]> {
      const issue = await fetchIssue(id);
      const data = await gql<{
        team: { states: { nodes: Array<{ id: string }> } } | null;
      }>('query($team: String!) { team(id: $team) { states { nodes { id } } } }', {
        team: issue.team.id,
      });
      return (data.team?.states.nodes ?? []).map((state) => ({ [LINEAR_STATE_KEY]: state.id }));
    },

    async addLabel(id: string, label: string): Promise<void> {
      const issue = await fetchIssue(id);
      await gql(
        'mutation($id: String!, $labelId: String!) { issueAddLabel(id: $id, labelId: $labelId) { success } }',
        {
          id,
          labelId: await labelId(issue.team.id, label),
        },
      );
    },

    async removeLabel(id: string, label: string): Promise<void> {
      const issue = await fetchIssue(id);
      const existing = issue.labels.nodes.find((l) => l.name === label);
      // Already absent is the desired state, not an error — and asking Linear to remove a label the
      // issue does not carry fails.
      if (existing === undefined) return;
      await gql(
        'mutation($id: String!, $labelId: String!) { issueRemoveLabel(id: $id, labelId: $labelId) { success } }',
        { id, labelId: existing.id },
      );
    },

    async ensureLabels(labels: readonly LabelSpec[]): Promise<void> {
      const team = await teamId();
      for (const spec of labels) await labelId(team, spec.name);
    },

    async addComment(id: string, body: string): Promise<NativeComment> {
      const data = await gql<{ commentCreate: { comment: { id: string; body: string } } }>(
        'mutation($input: CommentCreateInput!) { commentCreate(input: $input) { comment { id body } } }',
        { input: { issueId: id, body } },
      );
      return { id: data.commentCreate.comment.id, body: data.commentCreate.comment.body };
    },

    async linkIssues(fromId: string, toId: string, nativeLinkType: string): Promise<void> {
      await gql(
        'mutation($input: IssueRelationCreateInput!) { issueRelationCreate(input: $input) { success } }',
        { input: { issueId: fromId, relatedIssueId: toId, type: nativeLinkType } },
      );
    },

    async queryIssues(query: NativeQuery): Promise<readonly NativeIssue[]> {
      // `targets` is plural precisely for this: a role expands to one state id per team, and
      // Linear's own filter takes them as a set (`state: { id: { in: [...] } }`). The core's plural
      // contract and the provider's filter are the same shape, which is why neither needs looping.
      const stateIds = (query.targets ?? [])
        .map((target) => target[LINEAR_STATE_KEY])
        .filter((value): value is string => value !== undefined);
      const filter: Record<string, unknown> = {};
      if (stateIds.length > 0) filter.state = { id: { in: stateIds } };
      if (query.assignee !== undefined) {
        filter.assignee =
          query.assignee === '@me' ? { isMe: { eq: true } } : { email: { eq: query.assignee } };
      }
      if (query.iterationPath !== undefined) filter.cycle = { name: { eq: query.iterationPath } };
      const data = await gql<{ issues: { nodes: GqlIssue[] } }>(
        `query($filter: IssueFilter, $first: Int) { issues(filter: $filter, first: $first) { nodes { ${ISSUE_FIELDS} } } }`,
        { filter, first: query.limit ?? 50 },
      );
      return data.issues.nodes.map(toNative);
    },

    async updateIssue(id: string, update: NativeUpdateInput): Promise<NativeIssue> {
      const data = await gql<{ issueUpdate: { issue: GqlIssue } }>(
        `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { issue { ${ISSUE_FIELDS} } } }`,
        {
          id,
          input: {
            ...(update.title !== undefined ? { title: update.title } : {}),
            ...(update.body !== undefined ? { description: update.body } : {}),
          },
        },
      );
      return toNative(data.issueUpdate.issue);
    },

    async assignIssue(id: string, assignee: string): Promise<NativeIssue> {
      const users = await gql<{ users: { nodes: Array<{ id: string; email: string }> } }>(
        '{ users { nodes { id email } } }',
      );
      const wanted =
        assignee === '@me'
          ? (await gql<{ viewer: { id: string } }>('{ viewer { id } }')).viewer.id
          : users.users.nodes.find((user) => user.email === assignee)?.id;
      if (wanted === undefined) {
        throw new BaronError(`Linear user '${assignee}' not found in this workspace.`, ERROR_CODE);
      }
      const data = await gql<{ issueUpdate: { issue: GqlIssue } }>(
        `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { issue { ${ISSUE_FIELDS} } } }`,
        { id, input: { assigneeId: wanted } },
      );
      return toNative(data.issueUpdate.issue);
    },

    async currentUser(): Promise<string> {
      const data = await gql<{ viewer: { email: string } }>('{ viewer { email } }');
      return data.viewer.email;
    },

    async listIterations(): Promise<readonly Iteration[]> {
      const data = await gql<{
        cycles: {
          nodes: Array<{
            id: string;
            name?: string | null;
            number: number;
            startsAt: string;
            endsAt: string;
          }>;
        };
      }>('{ cycles { nodes { id name number startsAt endsAt } } }');
      const now = Date.now();
      return data.cycles.nodes.map((cycle) => ({
        id: cycle.id,
        name: cycle.name ?? `Cycle ${cycle.number}`,
        // Linear has no "path"; the name is the addressable handle, so it doubles as one.
        path: cycle.name ?? `Cycle ${cycle.number}`,
        current: Date.parse(cycle.startsAt) <= now && now <= Date.parse(cycle.endsAt),
      }));
    },

    async setIteration(id: string, iterationPath: string): Promise<NativeIssue> {
      const cycles = await this.listIterations();
      const cycle = cycles.find((c) => c.path === iterationPath);
      if (cycle === undefined) {
        throw new BaronError(`Linear cycle '${iterationPath}' not found.`, ERROR_CODE);
      }
      const data = await gql<{ issueUpdate: { issue: GqlIssue } }>(
        `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { issue { ${ISSUE_FIELDS} } } }`,
        { id, input: { cycleId: cycle.id } },
      );
      return toNative(data.issueUpdate.issue);
    },
  };
}
