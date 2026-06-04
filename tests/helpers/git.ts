import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

export interface RepoPair {
  /** bare repo acting as the remote ("origin") */
  origin: string;
  /** clone the scheduler will treat as the local workspace */
  workspace: string;
}

export function makeRepoPair(): RepoPair {
  const dir = mkdtempSync(join(tmpdir(), 'sched-git-'));
  const origin = join(dir, 'origin.git');
  const workspace = join(dir, 'workspace');

  execFileSync('git', ['init', '--bare', '--initial-branch=main', origin], { encoding: 'utf8' });
  execFileSync('git', ['clone', origin, workspace], { encoding: 'utf8' });
  git(workspace, 'config', 'user.email', 'test@test.local');
  git(workspace, 'config', 'user.name', 'Test');
  writeFileSync(join(workspace, 'README.md'), 'hello\n');
  git(workspace, 'add', '.');
  git(workspace, 'commit', '-m', 'init');
  git(workspace, 'push', 'origin', 'main');
  return { origin, workspace };
}

export function commitAndPush(workspace: string, branch: string, file: string): void {
  git(workspace, 'checkout', '-b', branch);
  writeFileSync(join(workspace, file), 'content\n');
  git(workspace, 'add', '.');
  git(workspace, 'commit', '-m', `add ${file}`);
  git(workspace, 'push', '-u', 'origin', branch);
}
