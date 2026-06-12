import type { LinearGateway } from '../../src/linear.js';
import { compareTickets } from '../../src/linear.js';
import type { TicketInfo } from '../../src/types.js';

export interface FakeIssue {
  ticket: TicketInfo;
  status: string;
  comments: string[];
}

export function makeTicket(over: Partial<TicketInfo> = {}): TicketInfo {
  return {
    id: 'issue-1',
    identifier: 'KIB-1',
    title: 'Add hello endpoint',
    description: 'Make it say hello',
    comments: [],
    priority: 2,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    projectName: 'Test Project',
    ...over,
  };
}

export class FakeLinear implements LinearGateway {
  readonly issues = new Map<string, FakeIssue>();

  /** url -> image bytes served by downloadImage; unknown urls return null */
  readonly images = new Map<string, Buffer>();

  add(ticket: TicketInfo, status = 'Todo'): void {
    this.issues.set(ticket.id, { ticket, status, comments: [] });
  }

  async downloadImage(url: string): Promise<Buffer | null> {
    return this.images.get(url) ?? null;
  }

  // The real gateway decides workability by Linear state TYPE; the fake stores
  // only status names, so it approximates with the well-known non-workable names
  // (started/terminal states the scheduler manages itself).
  private static readonly NON_WORKABLE = new Set([
    'in progress',
    'in review',
    'done',
    'canceled',
    'cancelled',
  ]);

  async fetchIssuesByStatus(projectNames: string[], statusName: string): Promise<TicketInfo[]> {
    const names = projectNames.map((n) => n.toLowerCase());
    return [...this.issues.values()]
      .filter((i) => i.status.toLowerCase() === statusName.toLowerCase())
      .filter((i) => names.includes(i.ticket.projectName.toLowerCase()))
      .map((i) => ({ ...i.ticket }))
      .sort(compareTickets);
  }

  async fetchWorkableIssues(projectNames: string[]): Promise<TicketInfo[]> {
    const names = projectNames.map((n) => n.toLowerCase());
    return [...this.issues.values()]
      .filter((i) => !FakeLinear.NON_WORKABLE.has(i.status.toLowerCase()))
      .filter((i) => names.includes(i.ticket.projectName.toLowerCase()))
      .map((i) => ({ ...i.ticket }))
      .sort(compareTickets);
  }

  async moveIssue(issueId: string, statusName: string): Promise<void> {
    this.get(issueId).status = statusName;
    this.touch(issueId);
  }

  async addComment(issueId: string, body: string): Promise<void> {
    this.get(issueId).comments.push(body);
    this.touch(issueId);
  }

  async getUpdatedAt(issueId: string): Promise<string> {
    return this.get(issueId).ticket.updatedAt;
  }

  /** simulate Linear bumping updatedAt on every mutation (the trap the spec calls out) */
  private touch(issueId: string): void {
    const issue = this.get(issueId);
    issue.ticket.updatedAt = new Date(
      new Date(issue.ticket.updatedAt).getTime() + 1_000,
    ).toISOString();
  }

  private get(issueId: string): FakeIssue {
    const issue = this.issues.get(issueId);
    if (!issue) throw new Error(`no such issue: ${issueId}`);
    return issue;
  }
}
