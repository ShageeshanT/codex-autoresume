import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { WebSocket } from 'ws';
import { Bridge, type Message } from '../src/adapters/bridge.js';
import { fixtureCommand } from '../src/demo/demo.js';

async function connect(bridge: Bridge) {
  const client = new WebSocket(bridge.url, { headers: { Authorization: `Bearer ${bridge.token}` } }); await once(client, 'open');
  let sequence = 0;
  const request = (method: string, params?: unknown, id: string | number = ++sequence) => new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('test request timeout')), 5000);
    const handler = (raw: WebSocket.RawData) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id !== id || msg.method) return;
      clearTimeout(timer); client.off('message', handler);
      if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
    };
    client.on('message', handler); client.send(JSON.stringify({ id, method, params }));
  });
  await request('initialize', { clientInfo: { name: 'test', version: '1' } });
  return { client, request };
}
test('bridge separates client/status IDs and forwards actual approval decisions', async () => {
  const bridge = new Bridge(fixtureCommand(), process.cwd());
  await bridge.start();
  try {
    const { client, request } = await connect(bridge);
    const [thread, limits] = await Promise.all([request('thread/start', {}, 'car:2'), bridge.request('account/rateLimits/read')]);
    assert.equal(thread.thread.id, 'fake-session'); assert.ok(limits.rateLimits);
    const observed = new Promise<Message>(resolve => bridge.on('notification', msg => { if (msg.method === 'test/approvalResult') resolve(msg); }));
    client.on('message', raw => {
      const msg = JSON.parse(raw.toString());
      if (msg.method === 'item/commandExecution/requestApproval') client.send(JSON.stringify({ id: msg.id, result: { decision: 'decline' } }));
    });
    await bridge.request('test/approval');
    assert.equal((await observed).params.response.result.decision, 'decline');
    client.terminate();
  } finally { await bridge.close(); }
});
test('bridge rejects continuation when waiting or when permission guard fails', async () => {
  const bridge = new Bridge(fixtureCommand(), process.cwd()); await bridge.start();
  try {
    const { client, request } = await connect(bridge);
    bridge.gate = () => false;
    await assert.rejects(request('turn/start', {}), /waiting/);
    bridge.gate = () => true; bridge.threadGuard = () => false;
    await assert.rejects(request('thread/resume', {}), /permissions changed/);
    client.terminate();
  } finally { await bridge.close(); }
});
test('loopback bridge rejects browser origins and a wrong connection token', async () => {
  const bridge = new Bridge(fixtureCommand(), process.cwd()); await bridge.start();
  try {
    for (const options of [{ origin: 'https://example.com', headers: { Authorization: `Bearer ${bridge.token}` } }, { headers: { Authorization: 'Bearer wrong' } }]) {
      const client = new WebSocket(bridge.url, options);
      const [error] = await once(client, 'error'); assert.match(error.message, /40[13]/); client.terminate();
    }
  } finally { await bridge.close(); }
});
test('packaged CLI demo exercises a real PTY and exits after exactly one resume', { timeout: 30000 }, async () => {
  const { stdout } = await promisify(execFile)(process.execPath, [path.resolve('dist/cli.js'), 'demo'], { timeout: 25000, windowsHide: true });
  assert.match(stdout, /Demo passed: one continuation/);
  assert.equal((stdout.match(/Reopening session/g) ?? []).length, 1);
});
