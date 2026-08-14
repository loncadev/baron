/**
 * Tool names and the published-tool shapes, in their own module so both the primitive layer
 * (`tools.ts`) and the consolidated surface (`consolidated.ts`) can import them without a cycle.
 */
/** Tool names: snake_case, `baron_` (product) namespace, singular noun to mirror the primitives. */
export const MCP_TOOL_NAMES = {
  create: 'baron_issue_create',
  get: 'baron_issue_get',
  update: 'baron_issue_update',
  transition: 'baron_issue_transition',
  reconcile: 'baron_issue_reconcile',
  block: 'baron_issue_block',
  unblock: 'baron_issue_unblock',
  comment: 'baron_issue_comment',
  link: 'baron_issue_link',
  assign: 'baron_issue_assign',
  iterations: 'baron_issue_iterations',
  setIteration: 'baron_issue_set_iteration',
  query: 'baron_issue_query',
} as const;

export const SCM_TOOL_NAMES = {
  branchCreate: 'baron_scm_branch_create',
  prCreate: 'baron_scm_pr_create',
  prThread: 'baron_scm_pr_thread',
  prStatus: 'baron_scm_pr_status',
  prForBranch: 'baron_scm_pr_for_branch',
  prReady: 'baron_scm_pr_ready',
  prMerge: 'baron_scm_pr_merge',
} as const;

export const CI_TOOL_NAMES = {
  pipelines: 'baron_ci_pipelines',
  runs: 'baron_ci_runs',
  runGet: 'baron_ci_run_get',
  runLogs: 'baron_ci_run_logs',
  runTrigger: 'baron_ci_run_trigger',
  runCancel: 'baron_ci_run_cancel',
} as const;

export const NOTIFY_TOOL_NAMES = {
  send: 'baron_notify_send',
} as const;

export const DEPLOY_TOOL_NAMES = {
  environments: 'baron_deploy_environments',
  deployments: 'baron_deploy_deployments',
} as const;

export const NATIVE_TOOL_NAMES = {
  request: 'baron_native_request',
} as const;

export const RECIPE_TOOL_NAMES = {
  list: 'baron_recipe_list',
  run: 'baron_recipe_run',
} as const;

export const LOOP_TOOL_NAMES = {
  learningAppend: 'baron_learning_append',
  learningQuery: 'baron_learning_query',
  followupAppend: 'baron_followup_append',
  followupList: 'baron_followup_list',
} as const;

/** A tool definition shaped for the MCP ListTools response (plain JSON Schema, no zod). */
export interface ToolDefinition {
  readonly name: string;
  /**
   * Whether calling this changes something in a PROVIDER — a work item, a branch, a PR, a pipeline.
   * Required, so a new tool cannot be added without someone deciding; a hand-kept list elsewhere
   * would drift the first time one was.
   *
   * False for the knowledge loop's appends: they write Baron's own store, and refusing them would
   * cost the record of a decision without preventing a single provider write. False for
   * `baron_recipe_run`, which IS the sanctioned channel — it mutates only by running primitives the
   * engine ordered, which is the entire point of {@link MUTATION_CHANNELS}.
   */
  readonly mutatesProvider: boolean;
  readonly description: string;
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties: Record<string, unknown>;
    readonly required?: readonly string[];
    readonly additionalProperties: false;
  };
}

/** The MCP text result shape (structurally a CallToolResult); kept SDK-agnostic for testability. */
export interface ToolResult {
  readonly content: ReadonlyArray<{ readonly type: 'text'; readonly text: string }>;
  readonly isError?: boolean;
  readonly structuredContent?: Record<string, unknown>;
}
