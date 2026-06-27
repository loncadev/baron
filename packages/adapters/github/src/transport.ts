import {
  BaronError,
  type IssuesTransport,
  type NativeComment,
  type NativeCreateInput,
  type NativeIssue,
  type NativeQuery,
  type NativeTarget,
} from '@baron/core';
import { Octokit } from 'octokit';

export interface GithubTransportOptions {
  readonly owner: string;
  readonly repo: string;
  /** Fine-grained PAT or token. Read from env / secret-manager by the caller; never committed. */
  readonly token: string;
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

  const toNative = (data: IssueResponse, discriminator?: string): NativeIssue => ({
    id: String(data.number),
    key: `#${data.number}`,
    title: data.title,
    body: data.body ?? undefined,
    nativeType: GH_NATIVE_TYPE,
    discriminator: discriminator ?? data.state ?? GH_STATE.OPEN,
    parentId: undefined,
    labels: labelNames(data.labels),
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

    async linkIssues(): Promise<void> {
      // Unreachable: githubManifest.issues.issueLinks is false, so the core negotiates the gap
      // (emulate via labels / degrade) and never calls this. Fail loudly if that ever changes.
      throw new BaronError(
        'GitHub has no native typed issue links; links are handled by the gap policy, not the ' +
          'transport.',
        'NOT_SUPPORTED',
      );
    },

    async queryIssues(query: NativeQuery): Promise<readonly NativeIssue[]> {
      const state = query.target?.[TARGET.STATE];
      const label = query.target?.[TARGET.LABEL];
      const { data } = await octokit.rest.issues.listForRepo({
        owner,
        repo,
        // A label-only filter should still match closed issues; default to 'all' unless the target
        // pins a state. GitHub's union enum is open | closed | all.
        state:
          state === GH_STATE.CLOSED
            ? GH_STATE.CLOSED
            : state === GH_STATE.OPEN
              ? GH_STATE.OPEN
              : 'all',
        ...(label !== undefined ? { labels: label } : {}),
        per_page: query.limit ?? 100,
      });
      // listForRepo also returns pull requests (GitHub models them as issues) — drop them.
      return data
        .filter((item) => item.pull_request === undefined)
        .map((item) => toNative(item as unknown as IssueResponse));
    },
  };
}
