import {
  BaseCiAdapter,
  type CiManifest,
  type CiStatusMaps,
  type CiTransport,
  type GapPolicy,
  type LogOptions,
  type Logger,
  type NativeLog,
  type NativeRun,
  type NativeRunDetail,
  type NativeTriggerResult,
  type Pipeline,
  type PipelineQuery,
  type RunQuery,
  type TriggerInput,
} from '@baron/core';
import { Octokit } from 'octokit';
import { GITHUB_PROVIDER } from './provider.js';
import type { GithubTransportOptions } from './transport.js';

/** GitHub Actions capabilities. Jobs (≈ stages) are not surfaced as stages in slice 1. */
export const githubCiManifest: CiManifest = {
  provider: GITHUB_PROVIDER,
  ci: {
    canTrigger: true,
    canCancel: true,
    hasStages: false,
    hasApprovalGates: true,
    providesLogs: true,
    hasArtifacts: true,
  },
};

/**
 * GitHub Actions' fixed string enums → normalized RunStatus. A completed run is decided by its
 * `conclusion`; an in-flight run by its `status`. 'completed' is intentionally absent from the status
 * map so a finished run is always classified by its conclusion (which is null until then).
 */
export const githubCiStatusMaps: CiStatusMaps = {
  status: {
    queued: 'queued',
    in_progress: 'running',
    requested: 'queued',
    waiting: 'waiting',
    pending: 'queued',
  },
  result: {
    success: 'succeeded',
    failure: 'failed',
    cancelled: 'canceled',
    skipped: 'skipped',
    timed_out: 'failed',
    action_required: 'waiting',
    neutral: 'succeeded',
    startup_failure: 'failed',
  },
};

const DEFAULT_RUN_LIMIT = 50;
const DEFAULT_TAIL_LINES = 200;

/** The workflow-run fields this transport reads (a structural subset of octokit's response type). */
interface GhRun {
  id: number;
  name?: string | null;
  status?: string | null;
  conclusion?: string | null;
  head_branch?: string | null;
  run_number?: number;
  html_url?: string;
  created_at?: string;
  updated_at?: string;
  workflow_id?: number;
}

function toNativeRun(r: GhRun): NativeRun {
  return {
    id: String(r.id),
    pipelineId: String(r.workflow_id ?? ''),
    pipelineName: r.name ?? undefined,
    status: r.status ?? 'queued',
    // conclusion is null until the run finishes; treat that as "no result yet" so status classifies it.
    result: r.conclusion ?? undefined,
    branch: r.head_branch ?? undefined,
    number: r.run_number !== undefined ? String(r.run_number) : undefined,
    url: r.html_url,
    createdAt: r.created_at,
    finishedAt: r.updated_at,
  };
}

/**
 * Live `ci` transport over the GitHub Actions REST API (octokit). Read-only in slice 1. Run logs are
 * a zip archive on GitHub, so `fetchLogs` tails the last job's plain-text log instead.
 */
export function createGithubCiTransport(options: GithubTransportOptions): CiTransport {
  const { owner, repo, token } = options;
  const octokit = new Octokit({ auth: token });

  return {
    async listPipelines(query: PipelineQuery): Promise<readonly Pipeline[]> {
      const { data } = await octokit.rest.actions.listRepoWorkflows({
        owner,
        repo,
        per_page: query.limit ?? 100,
      });
      return data.workflows.map((w) => ({ id: String(w.id), name: w.name, url: w.html_url }));
    },

    async listRuns(query: RunQuery): Promise<readonly NativeRun[]> {
      const { data } = await octokit.rest.actions.listWorkflowRunsForRepo({
        owner,
        repo,
        ...(query.branch !== undefined ? { branch: query.branch } : {}),
        per_page: query.limit ?? DEFAULT_RUN_LIMIT,
      });
      const runs = data.workflow_runs.map(toNativeRun);
      return query.pipelineId !== undefined
        ? runs.filter((r) => r.pipelineId === query.pipelineId)
        : runs;
    },

    async getRun(id: string): Promise<NativeRunDetail> {
      const { data } = await octokit.rest.actions.getWorkflowRun({
        owner,
        repo,
        run_id: Number(id),
      });
      return { ...toNativeRun(data), stages: [] };
    },

    async fetchLogs(runId: string, options: LogOptions): Promise<NativeLog> {
      const jobs = await octokit.rest.actions.listJobsForWorkflowRun({
        owner,
        repo,
        run_id: Number(runId),
        per_page: 100,
      });
      const list = jobs.data.jobs;
      const last = list[list.length - 1];
      if (last === undefined) return { content: '', truncated: false };
      const logResp = await octokit.rest.actions.downloadJobLogsForWorkflowRun({
        owner,
        repo,
        job_id: last.id,
      });
      const lines = String(logResp.data ?? '').split('\n');
      const tail = options.tailLines ?? DEFAULT_TAIL_LINES;
      const start = Math.max(0, lines.length - tail);
      return { content: lines.slice(start).join('\n'), truncated: start > 0 || list.length > 1 };
    },

    async triggerRun(input: TriggerInput): Promise<NativeTriggerResult> {
      // workflow_dispatch returns 204 with no run id, so the created run can't be reported back.
      const ref = input.ref ?? (await octokit.rest.repos.get({ owner, repo })).data.default_branch;
      await octokit.rest.actions.createWorkflowDispatch({
        owner,
        repo,
        workflow_id: Number(input.pipelineId),
        ref,
        ...(input.variables !== undefined ? { inputs: input.variables } : {}),
      });
      return { accepted: true };
    },

    async cancelRun(runId: string): Promise<NativeRun> {
      // cancelWorkflowRun returns 202 with no body; re-read the run to report its updated state.
      await octokit.rest.actions.cancelWorkflowRun({ owner, repo, run_id: Number(runId) });
      const { data } = await octokit.rest.actions.getWorkflowRun({
        owner,
        repo,
        run_id: Number(runId),
      });
      return toNativeRun(data);
    },
  };
}

export function defineGithubCiAdapter(
  transport: CiTransport,
  gapPolicy?: GapPolicy,
  logger?: Logger,
): BaseCiAdapter {
  return new BaseCiAdapter(githubCiManifest, githubCiStatusMaps, transport, gapPolicy, logger);
}
