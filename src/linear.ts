import { LinearClient } from '@linear/sdk';
import type { TicketComment, TicketInfo } from './types.js';

export interface LinearGateway {
  /** Todo issues in the given projects, sorted by priority (urgent first, none last), then oldest first */
  fetchTodoIssues(projectNames: string[], todoStatus: string): Promise<TicketInfo[]>;
  moveIssue(issueId: string, statusName: string): Promise<void>;
  addComment(issueId: string, body: string): Promise<void>;
  getUpdatedAt(issueId: string): Promise<string>;
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

  constructor(apiKey: string) {
    this.client = new LinearClient({ apiKey });
  }

  async fetchTodoIssues(projectNames: string[], todoStatus: string): Promise<TicketInfo[]> {
    const result = await this.client.issues({
      filter: {
        project: { name: { in: projectNames } },
        state: { name: { eqIgnoreCase: todoStatus } },
      },
      first: 50,
    });

    const tickets: TicketInfo[] = [];
    for (const issue of result.nodes) {
      const project = await issue.project;
      if (!project) continue;

      // TODO: paginate if a ticket ever has more than the SDK's default page of comments
      const commentsConn = await issue.comments();
      const comments: TicketComment[] = [];
      for (const c of commentsConn.nodes) {
        const user = await c.user;
        comments.push({ author: user?.name ?? 'unknown', body: c.body });
      }
      comments.reverse(); // Linear returns newest first; the prompt wants chronological order

      tickets.push({
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description ?? '',
        comments,
        priority: issue.priority,
        createdAt: issue.createdAt.toISOString(),
        updatedAt: issue.updatedAt.toISOString(),
        projectName: project.name,
      });
    }
    return tickets.sort(compareTickets);
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
