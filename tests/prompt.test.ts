import { describe, it, expect } from 'vitest';
import { branchName, buildPrompt, buildVerifyPrompt } from '../src/prompt.js';
import type { ProjectConfig, TicketInfo } from '../src/types.js';

function makeTicket(over: Partial<TicketInfo> = {}): TicketInfo {
  return {
    id: 'issue-1',
    identifier: 'KIB-12',
    title: 'Fix the Login!! Flow',
    description: 'Users cannot log in with Google.',
    comments: [],
    priority: 2,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    projectName: 'Test Project',
    ...over,
  };
}

function makeProject(over: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    linearProject: 'Test Project',
    path: '/tmp/workspace',
    gitFlow: 'branch-pr',
    baseBranch: 'main',
    ...over,
  };
}

describe('branchName', () => {
  it('builds a slugged branch from identifier and title', () => {
    expect(branchName('KIB-12', 'Fix the Login!! Flow')).toBe('claude/kib-12-fix-the-login-flow');
  });

  it('truncates long titles to 30 slug chars without a trailing dash', () => {
    const branch = branchName('KIB-1', 'a very long ticket title that goes on and on forever');
    expect(branch.length).toBeLessThanOrEqual('claude/kib-1-'.length + 30);
    expect(branch.endsWith('-')).toBe(false);
  });

  it('handles a title with no usable characters', () => {
    expect(branchName('KIB-3', '!!!')).toBe('claude/kib-3');
  });
});

describe('buildPrompt', () => {
  it('includes ticket identifier, title, description and comments', () => {
    const prompt = buildPrompt(
      makeTicket({ comments: [{ author: 'Max', body: 'Please also check Safari' }] }),
      makeProject(),
      'claude/kib-12-fix-the-login-flow',
    );
    expect(prompt).toContain('KIB-12: Fix the Login!! Flow');
    expect(prompt).toContain('Users cannot log in with Google.');
    expect(prompt).toContain('**Max:** Please also check Safari');
  });

  it('includes PR instructions only for branch-pr', () => {
    const ticket = makeTicket();
    const branch = 'claude/kib-12-fix-the-login-flow';
    expect(buildPrompt(ticket, makeProject({ gitFlow: 'branch-pr' }), branch)).toContain('gh pr create');
    expect(buildPrompt(ticket, makeProject({ gitFlow: 'branch-push' }), branch)).not.toContain('gh pr create');
    expect(buildPrompt(ticket, makeProject({ gitFlow: 'main-push' }), branch)).not.toContain('gh pr create');
  });

  it('tells branch flows the exact branch name', () => {
    const prompt = buildPrompt(makeTicket(), makeProject({ gitFlow: 'branch-push' }), 'claude/kib-12-x');
    expect(prompt).toContain('claude/kib-12-x');
  });

  it('tells main-push to work on the base branch', () => {
    const prompt = buildPrompt(makeTicket(), makeProject({ gitFlow: 'main-push', baseBranch: 'main' }), 'unused');
    expect(prompt).toContain('git push origin HEAD:main');
  });

  it('verify prompt explains the base-branch case when there is no PR branch', () => {
    const onBranch = buildVerifyPrompt(makeTicket(), 'claude/kib-12-x', [], false);
    expect(onBranch).toContain('the branch containing the work');

    const onBase = buildVerifyPrompt(makeTicket(), 'main', [], true);
    expect(onBase).toContain('ALREADY be merged into `main`');
    expect(onBase).toContain('that is a FAIL');
  });
});
