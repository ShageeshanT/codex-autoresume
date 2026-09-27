import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { eligibility, nextCheck, parseResetHint } from '../src/core/limits.js';
import { Store } from '../src/core/store.js';
import { transition } from '../src/core/state.js';
import { initialState } from '../src/demo/demo.js';
import { repositoryFingerprint } from '../src/core/fingerprint.js';
import { validateArgs } from '../src/adapters/codex.js';

const temp = () => mkdtempSync(path.join(os.tmpdir(), 'car-test-'));
test('only explicit zoned reset hints are accepted', () => {
  assert.equal(parseResetHint('Reset at 2026-09-27T03:15:00+05:30'), Date.parse('2026-09-26T21:45:00Z'));
  assert.equal(parseResetHint('reset at 03:15 AM'), null);
  assert.equal(parseResetHint('network timeout'), null);
});
test('all exhausted windows must reset, including model buckets', () => {
  const result = eligibility({ rateLimitsByLimitId: { codex: { primary: { usedPercent: 100, resetsAt: 10 }, secondary: { usedPercent: 100, resetsAt: 100 } }, model: { primary: { usedPercent: 101, resetsAt: 500 } } } });
  assert.deepEqual(result, { kind: 'limited', resetAt: 500_000 });
});
test('stale reset does not make an exhausted bucket available', () => {
  assert.equal(eligibility({ rateLimits: { primary: { usedPercent: 100, resetsAt: 1 } } }).kind, 'limited');
});
test('missing and malformed data cannot authorize a resume', () => {
  for (const data of [null, {}, { rateLimits: {} }, { rateLimits: { primary: { usedPercent: '10' } } }, { rateLimitsByLimitId: { a: { primary: { usedPercent: 10 } }, b: {} } }]) assert.equal(eligibility(data).kind, 'unknown');
});
test('credit and spending blocks cannot be overridden by unused windows', () => {
  assert.equal(eligibility({ rateLimits: { primary: { usedPercent: 0 }, rateLimitReachedType: 'workspace_owner_credits_depleted' } }).kind, 'limited');
  assert.equal(eligibility({ rateLimits: { primary: { usedPercent: 0 }, spendControlReached: true } }).kind, 'limited');
});
test('availability requires valid positive evidence', () => {
  assert.deepEqual(eligibility({ rateLimits: { primary: { usedPercent: 5, resetsAt: 1 }, secondary: { usedPercent: 40, resetsAt: 100 } } }), { kind: 'available', resetAt: null });
});
test('scheduler uses wall clock deadlines and conservative capped backoff', () => {
  assert.equal(nextCheck(100, 200, 45, 0), 245);
  assert.equal(nextCheck(100, null, 45, 0), 900100);
  assert.equal(nextCheck(100, 0, 45, 999), 1800100);
});
test('state transitions reject a direct unverified resume', () => {
  assert.throws(() => transition(initialState(temp()), 'RESUMING'), /Invalid transition/);
  const waiting = transition(initialState(temp()), 'WAITING_FOR_RESET');
  assert.equal(transition(waiting, 'VERIFYING').status, 'VERIFYING');
});
test('atomic state round trip, run-scoped cancellation and corrupt-state handling', () => {
  const store = new Store(temp()), state = initialState(temp());
  store.write(state); assert.deepEqual(store.read(), state);
  store.cancel('older-run'); assert.equal(store.cancelled(state.runId), false);
  store.cancel(state.runId); assert.equal(store.cancelled(state.runId), true);
  store.log('state', { to: 'WAITING_FOR_RESET' });
  assert.equal(readFileSync(store.file('events.jsonl'), 'utf8').includes('WAITING_FOR_RESET'), true);
  writeFileSync(store.file('state.json'), '{oops');
  assert.throws(() => store.read(), /corrupt/);
});
test('one OS lock owner, and automatic release permits restart', async () => {
  const dir = temp(), first = new Store(dir), second = new Store(dir);
  await first.acquire();
  try { await assert.rejects(second.acquire(), /Another supervisor/); } finally { await first.release(); }
  await second.acquire(); await second.release();
});
test('argument allowlist preserves permission options and excludes prompts/config secrets', () => {
  const args = ['--sandbox', 'workspace-write', '--ask-for-approval', 'on-request', '--model', 'example'];
  assert.deepEqual(validateArgs(args), args);
  for (const args of [['--remote', 'ws://elsewhere'], ['--config', 'token=secret'], ['my prompt'], ['--sandbox']]) assert.throws(() => validateArgs(args));
});
test('fingerprint detects content changes in already-dirty and untracked files', () => {
  const cwd = temp();
  execFileSync('git', ['init', cwd], { stdio: 'ignore', windowsHide: true });
  writeFileSync(path.join(cwd, 'file.txt'), 'a');
  const a = repositoryFingerprint(cwd);
  assert.ok(a);
  writeFileSync(path.join(cwd, 'file.txt'), 'b');
  assert.notEqual(repositoryFingerprint(cwd), a);
  execFileSync('git', ['-C', cwd, 'add', '.'], { windowsHide: true });
  const b = repositoryFingerprint(cwd);
  writeFileSync(path.join(cwd, 'file.txt'), 'c');
  assert.notEqual(repositoryFingerprint(cwd), b);
});
test('Git subdirectory fingerprints still hash untracked file contents', () => {
  const root = temp(), cwd = path.join(root, 'subdir'); mkdirSync(cwd);
  execFileSync('git', ['init', root], { stdio: 'ignore', windowsHide: true });
  writeFileSync(path.join(cwd, 'note'), 'one'); const before = repositoryFingerprint(cwd);
  assert.ok(before); writeFileSync(path.join(cwd, 'note'), 'two'); assert.notEqual(repositoryFingerprint(cwd), before);
});
