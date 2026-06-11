export type GitFlow = 'branch-pr' | 'branch-push' | 'main-push';

export interface ProjectConfig {
  linearProject: string;
  path: string;
  gitFlow: GitFlow;
  baseBranch: string;
  /** branch-pr only: squash-merge the PR automatically after browser
   * verification passes, before moving the ticket to Done (default false) */
  mergeOnVerified?: boolean;
  /** overrides claude.model for this project's work and review runs
   * (e.g. "opus" for a hard repo, "sonnet" for QA) */
  model?: string;
}

export interface ClaudeConfig {
  command: string;
  timeoutMinutes: number;
  /** how long to pause all ticks after claude hits a usage/rate limit
   * (default 30) */
  limitCooldownMinutes?: number;
  /** default model passed as `--model` to every run (e.g. "opus", "sonnet");
   * the bare claude CLI default is used when unset. A project's own `model`
   * takes precedence. */
  model?: string;
  /** extra CLI flags appended to every claude invocation (escape hatch) */
  args?: string[];
}

export interface StatusConfig {
  todo: string;
  inProgress: string;
  inReview: string;
  /** target status after a successful verification run (defaults to "Done") */
  done: string;
}

export interface Config {
  pollIntervalMinutes: number;
  claude: ClaudeConfig;
  statuses: StatusConfig;
  projects: ProjectConfig[];
  /** how many times a failed verification automatically moves the ticket back
   * to Todo so the work agent re-implements it (with the verifier's findings
   * in its prompt) before falling back to skip-until-touched
   * (default 1; 0 disables) */
  maxRetries?: number;
}

export interface TicketComment {
  author: string;
  body: string;
}

export interface TicketInfo {
  id: string; // Linear issue UUID
  identifier: string; // e.g. KIB-123
  title: string;
  description: string;
  comments: TicketComment[];
  priority: number; // 0 = none, 1 = urgent, 2 = high, 3 = medium, 4 = low
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
  projectName: string;
  /** the Linear project's description — shared context included in agent prompts */
  projectDescription?: string;
}
