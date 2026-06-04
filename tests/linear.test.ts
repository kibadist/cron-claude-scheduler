import { describe, it, expect } from 'vitest';
import { compareTickets } from '../src/linear.js';
import type { TicketInfo } from '../src/types.js';

function ticket(over: Partial<TicketInfo>): TicketInfo {
  return {
    id: 'x',
    identifier: 'X-1',
    title: 't',
    description: '',
    comments: [],
    priority: 0,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    projectName: 'P',
    ...over,
  };
}

describe('compareTickets', () => {
  it('orders urgent (1) before low (4)', () => {
    const urgent = ticket({ priority: 1 });
    const low = ticket({ priority: 4 });
    expect([low, urgent].sort(compareTickets)[0]).toBe(urgent);
  });

  it('orders no-priority (0) last', () => {
    const none = ticket({ priority: 0 });
    const low = ticket({ priority: 4 });
    expect([none, low].sort(compareTickets)[0]).toBe(low);
  });

  it('breaks priority ties by oldest createdAt first', () => {
    const older = ticket({ priority: 2, createdAt: '2026-06-01T00:00:00.000Z' });
    const newer = ticket({ priority: 2, createdAt: '2026-06-02T00:00:00.000Z' });
    expect([newer, older].sort(compareTickets)[0]).toBe(older);
  });
});
