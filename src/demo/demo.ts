import { existsSync, mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Bridge } from '../adapters/bridge.js';
import type { Command } from '../adapters/codex.js';
import { Store } from '../core/store.js';
import { Supervisor, type TerminalAdapter } from '../core/supervisor.js';
import type { SessionState } from '../core/state.js';
import { PtySession } from '../adapters/pty-session.js';

export function fixtureCommand(): Command {
  const js = fileURLToPath(new URL('./fake-codex.js', import.meta.url));
  return { file: process.execPath, args: existsSync(js) ? [js] : ['--import', 'tsx', js.replace(/\.js$/, '.ts')] };
}
export class DemoTerminal implements TerminalAdapter {
  private child?: PtySession;
  launches: Command[] = [];
  constructor(private output: (data: string) => void = data => process.stdout.write(data)) {}
  start(command: Command, cwd: string, onExit: (code: number) => void): void {
    this.launches.push(command);
    const child = new PtySession();
    this.child = child;
    child.start(command, cwd, 100, 25, this.output, code => { if (this.child === child) { this.child = undefined; onExit(code); } });
  }
  stop(): void { const child = this.child; this.child = undefined; child?.stop(); }
}
export function initialState(cwd: string, extra: Partial<SessionState> = {}): SessionState {
  return { schemaVersion: 1, runId: randomUUID(), status: 'RUNNING', cwd, codexPath: process.execPath, codexVersion: 'fake-codex/1', codexArgs: [], autoContinue: false,
    sessionId: null, turnId: null, detectedAt: null, resetAt: null, nextCheckAt: null, resumeAttempts: 0, verificationFailures: 0, fingerprint: null, threadStamp: null, policyStamp: null, claim: null, claimedTurnIds: [], controlId: null, reason: null, updatedAt: Date.now(), ...extra };
}
export async function runDemo(): Promise<void> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'codex-autoresume-demo-'));
  const store = new Store(dir), command = fixtureCommand();
  const terminal = new DemoTerminal();
  const supervisor = new Supervisor(store, initialState(process.cwd(), { autoContinue: true }), new Bridge(command, process.cwd()), terminal, {
    graceMs: 100, pollMs: 100, fingerprint: () => 'demo-workspace',
    terminalCommand: (url, _state, resume) => ({ file: command.file, args: [...command.args, '--tui', url, resume ? 'resume' : 'start', 'continue'] }),
  });
  console.log('Local demo: simulated quota, short reset, verified resume. No service requests.');
  await store.acquire();
  try {
    await supervisor.start(); await supervisor.done;
    if (supervisor.state.status !== 'COMPLETED' || supervisor.state.resumeAttempts !== 1) throw new Error('Demo did not complete exactly one resume.');
    console.log(`Demo passed: one continuation. Demo state: ${dir}`);
  } finally { await supervisor.close(); await store.release(); }
}
