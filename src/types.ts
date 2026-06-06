export type GitFlow = 'branch-pr' | 'branch-push' | 'main-push';

export interface ProjectConfig {
  linearProject: string;
  path: string;
  gitFlow: GitFlow;
  baseBranch: string;
  /** branch-pr only: squash-merge the PR automatically after browser
   * verification passes, before moving the ticket to Done (default false) */
  mergeOnVerified?: boolean;
}

export interface ClaudeConfig {
  command: string;
  timeoutMinutes: number;
  /** how long to pause all ticks after claude hits a usage/rate limit
   * (default 30) */
  limitCooldownMinutes?: number;
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
