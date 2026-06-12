import { LinearClient, type Issue } from '@linear/sdk';
import type { TicketComment, TicketInfo } from './types.js';

/** Linear workflow-state types that mean "not yet started and not terminal" —
 * everything the scheduler should pick up as work. Excludes `started`
 * (In Progress / In Review), `completed` (Done), and `canceled`. */
const WORKABLE_STATE_TYPES = ['triage', 'backlog', 'unstarted'];

export interface LinearGateway {
  /** Issues in the given projects in one specific workflow state, sorted by
   * priority (urgent first, none last), then oldest first */
  fetchIssuesByStatus(projectNames: string[], statusName: string): Promise<TicketInfo[]>;
  /** Every issue in the given projects that needs work — any non-terminal state
   * that isn't already started (so not In Progress / In Review / Done /
   * Canceled) — sorted the same way. Drives the whole project to Done. */
  fetchWorkableIssues(projectNames: string[]): Promise<TicketInfo[]>;
  moveIssue(issueId: string, statusName: string): Promise<void>;
  addComment(issueId: string, body: string): Promise<void>;
  getUpdatedAt(issueId: string): Promise<string>;
  /** Fetch a private Linear upload (uploads.linear.app); null on any failure. */
  downloadImage(url: string): Promise<Buffer | null>;
}

const NO_PRIORITY = 0;

export function compareTickets(a: TicketInfo, b: TicketInfo): number {
  const pa = a.priority === NO_PRIORITY ? 5 : a.priority;
  const pb = b.priority === NO_PRIORITY ? 5 : b.priority;
  if (pa !== pb) return pa - pb;
  return a.createdAt.localeCompare(b.createdAt);
}

export class LinearApi implements LinearGateway {
  private readonly client: LinearClient;
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.client = new LinearClient({ apiKey });
    this.apiKey = apiKey;
  }

  async downloadImage(url: string): Promise<Buffer | null> {
    try {
      // Linear uploads are private and need the API key — never send it anywhere else.
      if (new URL(url).hostname !== 'uploads.linear.app') return null;
      const res = await fetch(url, {
        headers: { Authorization: this.apiKey },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) return null;
      return Buffer.from(await res.arrayBuffer());
    } catch {
      return null;
    }
  }

  async fetchIssuesByStatus(projectNames: string[], statusName: string): Promise<TicketInfo[]> {
    const result = await this.client.issues({
      filter: {
        project: { name: { in: projectNames } },
        state: { name: { eqIgnoreCase: statusName } },
      },
      first: 50,
    });
    return this.collect(result.nodes);
  }

  async fetchWorkableIssues(projectNames: string[]): Promise<TicketInfo[]> {
    const result = await this.client.issues({
      filter: {
        project: { name: { in: projectNames } },
        state: { type: { in: WORKABLE_STATE_TYPES } },
      },
      first: 50,
    });
    return this.collect(result.nodes);
  }

  private async collect(nodes: Issue[]): Promise<TicketInfo[]> {
    const tickets: TicketInfo[] = [];
    for (const issue of nodes) {
      const ticket = await this.toTicketInfo(issue);
      if (ticket) tickets.push(ticket);
    }
    return tickets.sort(compareTickets);
  }

  private async toTicketInfo(issue: Issue): Promise<TicketInfo | null> {
    const project = await issue.project;
    if (!project) return null;

    // TODO: paginate if a ticket ever has more than the SDK's default page of comments
    const commentsConn = await issue.comments();
    const comments: TicketComment[] = [];
    for (const c of commentsConn.nodes) {
      const user = await c.user;
      comments.push({ author: user?.name ?? 'unknown', body: c.body });
    }
    comments.reverse(); // Linear returns newest first; the prompt wants chronological order

    return {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description ?? '',
      comments,
      priority: issue.priority,
      createdAt: issue.createdAt.toISOString(),
      updatedAt: issue.updatedAt.toISOString(),
      projectName: project.name,
      ...(project.description ? { projectDescription: project.description } : {}),
    };
  }

  async moveIssue(issueId: string, statusName: string): Promise<void> {
    const issue = await this.client.issue(issueId);
    const team = await issue.team;
    if (!team) throw new Error(`Issue ${issueId} has no team`);
    const states = await team.states();
    const target = states.nodes.find((s) => s.name.toLowerCase() === statusName.toLowerCase());
    if (!target) throw new Error(`Workflow state "${statusName}" not found in team "${team.name}"`);
    await this.client.updateIssue(issueId, { stateId: target.id });
  }

  async addComment(issueId: string, body: string): Promise<void> {
    await this.client.createComment({ issueId, body });
  }

  async getUpdatedAt(issueId: string): Promise<string> {
    const issue = await this.client.issue(issueId);
    return issue.updatedAt.toISOString();
  }
}
