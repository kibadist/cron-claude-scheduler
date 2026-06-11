import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergePr } from '../src/verify.js';

// mergePr shells out to `gh` and `git`. We put fake executables on PATH that
// record their argv and behave per env vars, so we can assert the exact flags
// and the idempotent already-merged path without a real GitHub repo.

const BRANCH = 'claude/det-1-thing';
let bin: string;
let ghLog: string;
let gitLog: string;
let originalPath: string | undefined;

function writeShim(name: string, body: string): void {
  const p = join(bin, name);
  writeFileSync(p, body);
  chmodSync(p, 0o755);
}

beforeEach(() => {
  bin = mkdtempSync(join(tmpdir(), 'sched-bin-'));
  ghLog = join(bin, 'gh.log');
  gitLog = join(bin, 'git.log');

  // gh: log argv; `pr merge` honours GH_MERGE_EXIT; `pr view` echoes GH_PR_STATE.
  writeShim(
    'gh',
    `#!/usr/bin/env bash
echo "$@" >> "${ghLog}"
if [ "$1" = "pr" ] && [ "$2" = "merge" ]; then
  if [ "\${GH_MERGE_EXIT:-0}" = "0" ]; then exit 0; else echo "merge boom" >&2; exit 1; fi
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then echo "\${GH_PR_STATE:-OPEN}"; exit 0; fi
exit 0
`,
  );
  // git: log argv, always succeed (covers `push origin --delete`).
  writeShim('git', `#!/usr/bin/env bash\necho "$@" >> "${gitLog}"\nexit 0\n`);

  originalPath = process.env.PATH;
  process.env.PATH = `${bin}:${originalPath ?? ''}`;
});

afterEach(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  delete process.env.GH_MERGE_EXIT;
  delete process.env.GH_PR_STATE;
});

describe('mergePr', () => {
  it('squash-merges without --delete-branch and deletes the remote branch separately', () => {
    const result = mergePr(bin, BRANCH);
    expect(result.ok).toBe(true);

    const ghArgs = readFileSync(ghLog, 'utf8');
    expect(ghArgs).toContain(`pr merge ${BRANCH} --squash`);
    expect(ghArgs).not.toContain('--delete-branch'); // must never touch the local branch
    // remote branch cleanup goes through git, not gh --delete-branch
    expect(readFileSync(gitLog, 'utf8')).toContain(`push origin --delete ${BRANCH}`);
  });

  it('treats an already-merged PR as success even when gh merge exits non-zero', () => {
    process.env.GH_MERGE_EXIT = '1'; // e.g. post-merge local-branch deletion failed
    process.env.GH_PR_STATE = 'MERGED';
    const result = mergePr(bin, BRANCH);
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('squash-merged');
  });

  it('reports failure when the merge errors and the PR is not merged', () => {
    process.env.GH_MERGE_EXIT = '1';
    process.env.GH_PR_STATE = 'OPEN';
    const result = mergePr(bin, BRANCH);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('boom');
    // a failed merge must not try to delete the remote branch
    expect(existsSync(gitLog)).toBe(false);
  });
});
