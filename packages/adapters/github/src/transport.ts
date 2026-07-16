import {
  ASSIGNEE_ME,
  BaronError,
  type IssuesTransport,
  type NativeComment,
  type NativeCreateInput,
  type NativeIssue,
  type NativeQuery,
  type NativeTarget,
  type NativeUpdateInput,
} from '@lonca/baron-core';
import { Octokit } from 'octokit';

export interface GithubTransportOptions {
  readonly owner: string;
  readonly repo: string;
  /** Fine-grained PAT or token. Read from env / secret-manager by the caller; never committed. */
  readonly token: string;
  /**
   * Integration branch to fork from and target PRs at when omitted; defaults to the repo default
   * branch. Only the scm transport reads it (the issues transport ignores it).
   */
  readonly baseBranch?: string | undefined;
}

/** GitHub's binary issue states. */
const GH_STATE = { OPEN: 'open', CLOSED: 'closed' } as const;

/**
 * NativeTarget keys this transport reads VERBATIM (invariant #4: no role translation here — the
 * role map already resolved roles to these keys in BaseIssuesAdapter). `label` carries the workflow
 * role; `state` carries the binary open/closed transition.
 */
const TARGET = { STATE: 'state', LABEL: 'label' } as const;

/** GitHub has one native type; every type role maps onto it (matches the example type map). */
const GH_NATIVE_TYPE = 'issue';

type IssueResponse = Awaited<ReturnType<Octokit['rest']['issues']['get']>>['data'];

function labelNames(labels: IssueResponse['labels']): string[] {
  return labels
    .map((label) => (typeof label === 'string' ? label : (label.name ?? '')))
    .filter((name) => name.length > 0);
}

/**
 * Live transport over the GitHub REST API (octokit). Baron's issue `id` is the per-repo issue
 * NUMBER (every REST path keys on `issue_number`); hierarchy is emulated by the core via labels, so
 * this transport never deals with parents. The role-bearing discriminator is a label, so writes
 * ECHO `target.label` back as the discriminator (a cold {@link getIssue} can only report open/closed
 * — recovering a mid-workflow role from labels would need the role map, which invariant #4 forbids
 * the transport from holding; this lossy cold read is the same documented debt as type-role reverse
 * resolution).
 */
export function createGithubTransport(options: GithubTransportOptions): IssuesTransport {
  const { owner, repo, token } = options;
  const octokit = new Octokit({ auth: token });

  // '@me' has no REST equivalent on listForRepo; resolve the token's login once and cache it.
  let myLogin: Promise<string> | undefined;
  const resolveAssignee = (assignee: string): Promise<string> => {
    if (assignee !== ASSIGNEE_ME) return Promise.resolve(assignee);
    myLogin ??= octokit.rest.users.getAuthenticated().then(({ data }) => data.login);
    return myLogin;
  };

  const toNative = (data: IssueResponse, discriminator?: string): NativeIssue => ({
    id: String(data.number),
    key: `#${data.number}`,
    title: data.title,
    body: data.body ?? undefined,
    nativeType: GH_NATIVE_TYPE,
    discriminator: discriminator ?? data.state ?? GH_STATE.OPEN,
    parentId: undefined,
    labels: labelNames(data.labels),
    assignee: data.assignee?.login ?? undefined,
    url: data.html_url,
  });

  return {
    async createIssue(input: NativeCreateInput): Promise<NativeIssue> {
      const { data } = await octokit.rest.issues.create({
        owner,
        repo,
        title: input.title,
        ...(input.body !== undefined ? { body: input.body } : {}),
        labels: [...input.labels],
      });
      // A fresh issue carries the default 'open' discriminator, which resolves to no role by design.
      return toNative(data);
    },

    async getIssue(id: string): Promise<NativeIssue> {
      const { data } = await octokit.rest.issues.get({ owner, repo, issue_number: Number(id) });
      return toNative(data);
    },

    async applyTarget(id: string, target: NativeTarget): Promise<NativeIssue> {
      const issue_number = Number(id);
      const roleLabel = target[TARGET.LABEL];
      const state = target[TARGET.STATE];

      if (roleLabel !== undefined) {
        await octokit.rest.issues.addLabels({ owner, repo, issue_number, labels: [roleLabel] });
      }
      if (state === GH_STATE.CLOSED) {
        await octokit.rest.issues.update({
          owner,
          repo,
          issue_number,
          state: GH_STATE.CLOSED,
          state_reason: 'completed',
        });
      } else if (state === GH_STATE.OPEN) {
        await octokit.rest.issues.update({
          owner,
          repo,
          issue_number,
          state: GH_STATE.OPEN,
          state_reason: 'reopened',
        });
      }

      const { data } = await octokit.rest.issues.get({ owner, repo, issue_number });
      // Echo the role-bearing token we just applied so reverse role lookup resolves immediately.
      return toNative(data, roleLabel ?? state);
    },

    async addLabel(id: string, label: string): Promise<void> {
      await octokit.rest.issues.addLabels({
        owner,
        repo,
        issue_number: Number(id),
        labels: [label],
      });
    },

    async updateIssue(id: string, update: NativeUpdateInput): Promise<NativeIssue> {
      // GitHub has one body field for every type, so typeRole needs no routing here.
      const { data } = await octokit.rest.issues.update({
        owner,
        repo,
        issue_number: Number(id),
        ...(update.title !== undefined ? { title: update.title } : {}),
        ...(update.body !== undefined ? { body: update.body } : {}),
      });
      return toNative(data as IssueResponse);
    },

    currentUser(): Promise<string> {
      // Same resolver '@me' assignment uses, so the handle matches what reads report (login).
      return resolveAssignee(ASSIGNEE_ME);
    },

    async addComment(id: string, body: string): Promise<NativeComment> {
      const { data } = await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: Number(id),
        body,
      });
      return {
        id: String(data.id),
        body: data.body ?? body,
        author: data.user?.login,
        createdAt: data.created_at,
        url: data.html_url,
      };
    },

    async assignIssue(id: string, assignee: string): Promise<NativeIssue> {
      // Baron's single-assignee model maps to GitHub's assignees ARRAY: setting replaces the set
      // with exactly this login (update, not addAssignees, so a previous assignee doesn't linger).
      const { data } = await octokit.rest.issues.update({
        owner,
        repo,
        issue_number: Number(id),
        assignees: [assignee],
      });
      return toNative(data);
    },

    async linkIssues(): Promise<void> {
      // Unreachable: githubManifest.issues.issueLinks is false, so the core negotiates the gap
      // (emulate via labels / degrade) and never calls this. Fail loudly if that ever changes.
      throw new BaronError(
        'GitHub has no native typed issue links; links are handled by the gap policy, not the ' +
          'transport.',
        'NOT_SUPPORTED',
      );
    },

    async listIterations(): Promise<never> {
      // Unreachable: githubManifest.issues.sprints is false, so the core negotiates the gap (the
      // issues port returns [] / degrades) and never calls this. GitHub issues have no sprints.
      throw new BaronError(
        'GitHub issues have no native iterations/sprints; handled by the gap policy, not the transport.',
        'NOT_SUPPORTED',
      );
    },

    async setIteration(): Promise<never> {
      throw new BaronError(
        'GitHub issues have no native iterations/sprints; handled by the gap policy, not the transport.',
        'NOT_SUPPORTED',
      );
    },

    async queryIssues(query: NativeQuery): Promise<readonly NativeIssue[]> {
      const stateValue = query.target?.[TARGET.STATE];
      const label = query.target?.[TARGET.LABEL];
      // A label-only filter should still match closed issues; default to 'all' unless the target
      // pins a state. GitHub's union enum is open | closed | all.
      const state =
        stateValue === GH_STATE.CLOSED
          ? GH_STATE.CLOSED
          : stateValue === GH_STATE.OPEN
            ? GH_STATE.OPEN
            : 'all';
      const { limit } = query;
      const assignee =
        query.assignee === undefined ? undefined : await resolveAssignee(query.assignee);

      // Paginate (per_page caps at 100) and stop once `limit` non-PR issues are collected, so a
      // limit > 100 is honored rather than silently truncated. GitHub models PRs as issues — skip
      // them, which also keeps `limit` counting actual issues.
      const results: NativeIssue[] = [];
      for await (const { data } of octokit.paginate.iterator(octokit.rest.issues.listForRepo, {
        owner,
        repo,
        state,
        ...(label !== undefined ? { labels: label } : {}),
        ...(assignee !== undefined ? { assignee } : {}),
        per_page: 100,
      })) {
        for (const item of data) {
          if (item.pull_request !== undefined) continue;
          results.push(toNative(item as unknown as IssueResponse));
          if (limit !== undefined && results.length >= limit) return results;
        }
      }
      return results;
    },
  };
}
