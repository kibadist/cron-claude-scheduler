import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  remoteBranchExists,
  remoteHeadSha,
  prUrlForBranch,
  verifyWork,
} from '../src/verify.js';
import { makeRepoPair, commitAndPush, git } from './helpers/git.js';
import type { ProjectConfig } from '../src/types.js';

function project(workspace: string, gitFlow: ProjectConfig['gitFlow']): ProjectConfig {
  return { linearProject: 'X', path: workspace, gitFlow, baseBranch: 'main' };
}

describe('remoteBranchExists', () => {
  it('is false before push, true after', () => {
    const { workspace } = makeRepoPair();
    expect(remoteBranchExists(workspace, 'claude/kib-1-test')).toBe(false);
    commitAndPush(workspace, 'claude/kib-1-test', 'work.txt');
    expect(remoteBranchExists(workspace, 'claude/kib-1-test')).toBe(true);
  });
});

describe('remoteHeadSha', () => {
  it('returns a sha that changes when the branch advances', () => {
    const { workspace } = makeRepoPair();
    const before = remoteHeadSha(workspace, 'main');
    expect(before).toMatch(/^[0-9a-f]{40}$/);

    writeFileSync(join(workspace, 'new.txt'), 'x\n');
    git(workspace, 'add', '.');
    git(workspace, 'commit', '-m', 'more');
    git(workspace, 'push', 'origin', 'main');

    const after = remoteHeadSha(workspace, 'main');
    expect(after).toMatch(/^[0-9a-f]{40}$/);
    expect(after).not.toBe(before);
  });

  it('returns empty string for a missing branch', () => {
    const { workspace } = makeRepoPair();
    expect(remoteHeadSha(workspace, 'no-such-branch')).toBe('');
  });
});

describe('prUrlForBranch', () => {
  it('returns null when gh cannot find a PR (or is unavailable)', () => {
    const { workspace } = makeRepoPair();
    expect(prUrlForBranch(workspace, 'claude/kib-1-test')).toBeNull();
  });
});

describe('verifyWork', () => {
  it('branch-push: ok when the branch is on the remote', () => {
    const { workspace } = makeRepoPair();
    commitAndPush(workspace, 'claude/kib-1-test', 'work.txt');
    const result = verifyWork(project(workspace, 'branch-push'), 'claude/kib-1-test', '');
    expect(result.ok).toBe(true);
  });

  it('branch-push: fails when the branch was never pushed', () => {
    const { workspace } = makeRepoPair();
    const result = verifyWork(project(workspace, 'branch-push'), 'claude/kib-1-test', '');
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('not pushed');
  });

  it('branch-pr: fails when the branch is pushed but no PR exists', () => {
    const { workspace } = makeRepoPair();
    commitAndPush(workspace, 'claude/kib-1-test', 'work.txt');
    const result = verifyWork(project(workspace, 'branch-pr'), 'claude/kib-1-test', '');
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('no PR');
  });

  it('main-push: ok only when the remote base branch advanced', () => {
    const { workspace } = makeRepoPair();
    const preSha = remoteHeadSha(workspace, 'main');

    const unchanged = verifyWork(project(workspace, 'main-push'), 'unused', preSha);
    expect(unchanged.ok).toBe(false);

    writeFileSync(join(workspace, 'new.txt'), 'x\n');
    git(workspace, 'add', '.');
    git(workspace, 'commit', '-m', 'work');
    git(workspace, 'push', 'origin', 'main');

    const changed = verifyWork(project(workspace, 'main-push'), 'unused', preSha);
    expect(changed.ok).toBe(true);
  });
});
