import { describe, it, expect } from 'vitest';
import { classifyFailure } from '../src/verify.js';

describe('classifyFailure', () => {
  it('treats workspace-prep failures as transient', () => {
    expect(classifyFailure('could not prepare the verification workspace: fatal: unable to access')).toBe(
      'transient',
    );
    expect(classifyFailure('could not prepare the work workspace: network is unreachable')).toBe('transient');
  });

  it('treats network errors as transient (from detail or log text)', () => {
    expect(classifyFailure('connect ECONNREFUSED 127.0.0.1:3000')).toBe('transient');
    expect(classifyFailure('boom', 'fetch failed: getaddrinfo ENOTFOUND api')).toBe('transient');
    expect(classifyFailure('claude finished without a final VERDICT: PASS line', 'Error: socket hang up')).toBe(
      'transient',
    );
  });

  it('treats dev-server / gh-auth problems as transient', () => {
    expect(classifyFailure('the dev server did not start', '')).toBe('transient');
    expect(classifyFailure('error', 'address already in use :::3000')).toBe('transient');
    expect(classifyFailure('gh auth: not logged in to github.com')).toBe('transient');
  });

  it('treats a genuine verification failure as genuine', () => {
    expect(classifyFailure('claude finished without a final `VERDICT: PASS` line')).toBe('genuine');
    expect(classifyFailure('the save button is broken', 'VERDICT: FAIL — save button broken')).toBe('genuine');
    expect(classifyFailure('claude exited with code 1', 'pushed nothing to origin')).toBe('genuine');
  });

  it('defaults to genuine for an empty/unknown detail', () => {
    expect(classifyFailure('')).toBe('genuine');
    expect(classifyFailure('something went wrong')).toBe('genuine');
  });
});
