import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Bridge } from '../src/adapters/bridge.js';
import type { Command } from '../src/adapters/codex.js';
import { Supervisor, type TerminalAdapter } from '../src/core/supervisor.js';
import { Store } from '../src/core/store.js';
import { initialState } from '../src/demo/demo.js';
import { threadStamp, policyStamp } from '../src/core/fingerprint.js';
import { insideCommand } from '../src/commands/inside.js';

class MockBridge extends Bridge {
  reads: string[] = [];
  available = false;
  failReads = false;
  afterRead?: () => void;
  thread = { id: 'session-a', cwd: process.cwd(), updatedAt: 1, status: { type: 'idle' }, turns: [{ id: 'turn-a', status: 'failed' }] };
  constructor() { super({ file: 'fake', args: [] }, process.cwd()); }
  override async start() { this.url = 'ws://fake'; }
  override async close() {}
  override disconnectTerminal() {}
  override async request(method: string): Promise<any> {
    this.reads.push(method);
    if (method === 'thread/read') return { thread: this.thread };
    if (method === 'thread/turns/list') return { data: this.thread.turns.slice(-1) };
    this.afterRead?.();
    if (this.failReads) throw new Error('offline');
    return { rateLimits: { primary: { usedPercent: this.available ? 10 : 100, resetsAt: 2 } } };
  }
}
class MockTerminal implements TerminalAdapter {
  commands: Command[] = [];
  start(command: Command) { this.commands.push(command); }
  stop() {}
}
async function setup(extra = {}) {
  const store = new Store(mkdtempSync(path.join(os.tmpdir(), 'car-supervisor-')));
  const bridge = new MockBridge(), terminal = new MockTerminal();
  let now = 1000;
  const state = initialState(process.cwd(), { sessionId: 'session-a', autoContinue: true, ...extra });
  const supervisor = new Supervisor(store, state, bridge, terminal, { pollMs: 100_000, graceMs: 100, now: () => now, fingerprint: () => 'unchanged', say: () => {} });
  await supervisor.start();
  return { store, bridge, terminal, supervisor, setNow: (value: number) => { now = value; } };
}
async function failTurn(bridge: MockBridge, code = 'usageLimitExceeded', threadId = 'session-a') {
  bridge.emit('notification', { method: 'turn/completed', params: { threadId, turn: { id: 'turn-a', status: 'failed', error: { codexErrorInfo: code, message: 'not persisted' } } } });
  await delay(20);
}
test('quota -> wait -> verify -> same-session resume once, with claim persisted first', async () => {
  const h = await setup();
  try {
    await failTurn(h.bridge); assert.equal(h.supervisor.state.status, 'WAITING_FOR_RESET');
    h.setNow(2099); await h.supervisor.tick(); assert.equal(h.terminal.commands.length, 1);
    h.setNow(2100); h.bridge.available = true;
    await h.supervisor.tick();
    assert.equal(h.supervisor.state.status, 'RESUMING'); assert.ok(h.store.read()!.claim);
    assert.equal(h.terminal.commands.length, 2); assert.ok(h.terminal.commands[1]!.args.includes('session-a'));
    await h.supervisor.tick(); assert.equal(h.terminal.commands.length, 2);
  } finally { await h.supervisor.close(); }
});
test('auth, network, generic 429 and unrelated thread failures do not create quota waits', async () => {
  for (const code of ['unauthorized', 'internalServerError', 'other', 'rateLimitExceeded']) {
    const h = await setup(); h.bridge.available = true;
    try { await failTurn(h.bridge, code); assert.equal(h.supervisor.state.status, 'RUNNING'); await failTurn(h.bridge, 'usageLimitExceeded', 'other'); assert.equal(h.supervisor.state.status, 'RUNNING'); }
    finally { await h.supervisor.close(); }
  }
});
test('unknown allowance backs off without dispatching work', async () => {
  const h = await setup();
  try { await failTurn(h.bridge); h.bridge.failReads = true; h.setNow(3000); await h.supervisor.tick(); assert.equal(h.supervisor.state.status, 'AWAITING_RESET_INFO'); assert.equal(h.terminal.commands.length, 1); assert.ok(h.supervisor.state.nextCheckAt! >= 903000); }
  finally { await h.supervisor.close(); }
});
test('cancel racing an allowance response wins before dispatch', async () => {
  const h = await setup();
  try { await failTurn(h.bridge); h.bridge.available = true; h.bridge.afterRead = () => h.store.cancel(h.supervisor.state.runId); h.setNow(3000); await h.supervisor.tick(); assert.equal(h.supervisor.state.status, 'CANCELLED'); assert.equal(h.terminal.commands.length, 1); }
  finally { await h.supervisor.close(); }
});
test('manual session activity stops automated continuation', async () => {
  const h = await setup();
  try { await failTurn(h.bridge); h.bridge.thread.updatedAt++; h.bridge.available = true; h.setNow(3000); await h.supervisor.tick(); assert.equal(h.supervisor.state.status, 'PAUSED'); assert.equal(h.terminal.commands.length, 1); }
  finally { await h.supervisor.close(); }
});
test('workspace changes stop automated continuation', async () => {
  const h = await setup();
  try { await failTurn(h.bridge); h.supervisor.state.fingerprint = 'changed'; h.bridge.available = true; h.setNow(3000); await h.supervisor.tick(); assert.equal(h.supervisor.state.status, 'PAUSED'); assert.equal(h.terminal.commands.length, 1); }
  finally { await h.supervisor.close(); }
});
test('default recovery reopens a session without a continuation prompt', async () => {
  const h = await setup({ autoContinue: false });
  try { await failTurn(h.bridge); h.bridge.available = true; h.setNow(3000); await h.supervisor.tick(); assert.equal(h.terminal.commands[1]!.args.some(a => a.startsWith('Continue ')), false); }
  finally { await h.supervisor.close(); }
});
test('restart after dispatch claim never repeats a continuation', async () => {
  const h = await setup();
  try {
    await failTurn(h.bridge); h.bridge.available = true; h.setNow(3000); await h.supervisor.tick();
    const state = h.store.read()!;
    const terminal = new MockTerminal();
    const recovered = new Supervisor(h.store, state, new MockBridge(), terminal, { say: () => {} });
    await recovered.start(true); assert.equal(recovered.state.status, 'PAUSED'); assert.equal(terminal.commands.length, 0); await recovered.close();
  } finally { await h.supervisor.close(); }
});
test('recover after sleep/restart checks a past deadline and resumes exactly once', async () => {
  const store = new Store(mkdtempSync(path.join(os.tmpdir(), 'car-recover-'))), bridge = new MockBridge(), terminal = new MockTerminal();
  bridge.available = true;
  const state = initialState(process.cwd(), { status: 'WAITING_FOR_RESET', sessionId: 'session-a', turnId: 'turn-a', nextCheckAt: 2, threadStamp: threadStamp(bridge.thread) });
  const supervisor = new Supervisor(store, state, bridge, terminal, { pollMs: 100_000, say: () => {} });
  try { await supervisor.start(true); await delay(20); assert.equal(supervisor.state.status, 'RESUMING'); assert.equal(terminal.commands.length, 1); }
  finally { await supervisor.close(); }
});
test('permission changes are rejected before a successful resume reaches the terminal', async () => {
  const h = await setup();
  try {
    const policy = { approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: { type: 'workspaceWrite' } };
    h.supervisor.state.policyStamp = policyStamp(policy);
    await failTurn(h.bridge); h.bridge.available = true; h.setNow(3000); await h.supervisor.tick();
    assert.equal(h.bridge.threadGuard({ thread: h.bridge.thread, ...policy, sandbox: { type: 'dangerFullAccess' } }), false);
    assert.equal(h.supervisor.state.status, 'PAUSED');
  } finally { await h.supervisor.close(); }
});
test('replayed failure notifications cannot continue an already claimed turn again', async () => {
  const h = await setup();
  try {
    const policy = { approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: { type: 'workspaceWrite' } };
    h.supervisor.state.policyStamp = policyStamp(policy);
    await failTurn(h.bridge); h.bridge.available = true; h.setNow(3000); await h.supervisor.tick();
    assert.equal(h.bridge.threadGuard({ thread: h.bridge.thread, ...policy }), true);
    await failTurn(h.bridge); assert.equal(h.supervisor.state.status, 'RUNNING');
    assert.equal(h.supervisor.state.resumeAttempts, 1);
  } finally { await h.supervisor.close(); }
});
test('inside-Codex controls acknowledge the current session and reject other sessions', async () => {
  const sessionId = '12345678-1234-1234-1234-123456789abc';
  const h = await setup({ sessionId, autoContinue: false });
  await h.store.acquire();
  const timer = setInterval(() => { void h.supervisor.tick(); }, 20);
  try {
    const result = await insideCommand('on', h.store, 'dist/cli.js', process.cwd(), sessionId);
    assert.match(result, /now on/); assert.equal(h.store.read()!.autoContinue, true);
    assert.match(await insideCommand('off', h.store, 'dist/cli.js', process.cwd(), sessionId), /now off/);
    assert.equal(h.store.read()!.autoContinue, false);
    await assert.rejects(insideCommand('stop', h.store, 'dist/cli.js', process.cwd(), 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), /No active supervisor/);
    assert.equal(h.store.cancelled(h.supervisor.state.runId), false);
    assert.equal(h.terminal.commands[0]!.env!.CAR_STATE_DIR, h.store.dir);
  } finally { clearInterval(timer); await h.supervisor.close(); await h.store.release(); }
});
test('stale controls are ignored and continuation cannot be enabled partway through a wait', async () => {
  const h = await setup({ autoContinue: false });
  try {
    h.store.requestAutoContinue('old-run', 'session-a', true);
    await h.supervisor.tick(); assert.equal(h.supervisor.state.autoContinue, false);
    h.store.requestAutoContinue(h.supervisor.state.runId, 'different-session', true);
    await h.supervisor.tick(); assert.equal(h.supervisor.state.autoContinue, false);
    await failTurn(h.bridge);
    h.store.requestAutoContinue(h.supervisor.state.runId, 'session-a', true);
    await h.supervisor.tick(); assert.equal(h.supervisor.state.autoContinue, false);
  } finally { await h.supervisor.close(); }
});
test('an ordinary Codex session gets handoff instructions without starting a second client', async () => {
  const h = await setup();
  try {
    const result = await insideCommand('on', h.store, "C:/a'b/app/dist/cli.js", "C:/my project's files", '12345678-1234-1234-1234-123456789abc');
    assert.match(result, /not attached/); assert.match(result, /handoff instruction only/);
    assert.ok(result.includes(process.platform === 'win32' ? "'C:/my project''s files'" : "'C:/my project'\\''s files'"));
    assert.match(result, /--resume '12345678-1234-1234-1234-123456789abc'/);
    assert.equal(h.terminal.commands.length, 1);
  } finally { await h.supervisor.close(); }
});
