import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, openSync, closeSync, fsyncSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createServer, type Server } from 'node:net';
import { createHash } from 'node:crypto';
import { stateSchema, type SessionState } from './state.js';

export function defaultStateDir(): string {
  if (process.env.CAR_STATE_DIR) return path.resolve(process.env.CAR_STATE_DIR);
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'codex-autoresume');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'codex-autoresume');
  return path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local', 'state'), 'codex-autoresume');
}

// An OS-owned local socket lock is released on process death, including a crash.
// On Unix a loopback port avoids stale filesystem sockets; the state path determines the port.
export class Store {
  readonly dir: string;
  private lock?: Server;
  constructor(dir: string) { this.dir = path.resolve(dir); }
  file(name: string): string { return path.join(this.dir, name); }
  ensure(): void { mkdirSync(this.dir, { recursive: true, mode: 0o700 }); }
  read(): SessionState | null {
    if (!existsSync(this.file('state.json'))) return null;
    try { return stateSchema.parse(JSON.parse(readFileSync(this.file('state.json'), 'utf8'))); }
    catch { throw new Error(`State is corrupt or has an unsupported version: ${this.file('state.json')}. Keep it for inspection; move it aside before starting a new session.`); }
  }
  write(state: SessionState): void {
    this.ensure();
    const temp = this.file(`state.${randomUUID()}.tmp`);
    const fd = openSync(temp, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(stateSchema.parse(state), null, 2) + '\n'); fsyncSync(fd); }
    finally { closeSync(fd); }
    try { renameSync(temp, this.file('state.json')); }
    finally { if (existsSync(temp)) unlinkSync(temp); }
  }
  log(event: string, data: Record<string, string | number | boolean | null> = {}): void {
    this.ensure();
    appendFileSync(this.file('events.jsonl'), JSON.stringify({ at: new Date().toISOString(), event, ...data }) + '\n', { mode: 0o600 });
  }
  cancel(runId: string): void { this.ensure(); writeFileSync(this.file('cancel.json'), JSON.stringify({ runId }), { mode: 0o600 }); }
  cancelled(runId: string): boolean {
    try { return JSON.parse(readFileSync(this.file('cancel.json'), 'utf8')).runId === runId; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw new Error('Cannot read cancellation request; stopping automation.'); }
  }
  requestAutoContinue(runId: string, sessionId: string, enabled: boolean): string {
    this.ensure();
    const id = randomUUID(), temp = this.file(`control.${id}.tmp`);
    writeFileSync(temp, JSON.stringify({ id, runId, sessionId, autoContinue: enabled }), { mode: 0o600 });
    renameSync(temp, this.file('control.json'));
    return id;
  }
  readControl(): { id: string; runId: string; sessionId: string; autoContinue: boolean } | null {
    try {
      const value = JSON.parse(readFileSync(this.file('control.json'), 'utf8'));
      if (typeof value.id !== 'string' || typeof value.runId !== 'string' || typeof value.sessionId !== 'string' || typeof value.autoContinue !== 'boolean') throw new Error('Invalid control request');
      return value;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new Error('Cannot read AutoResume control request.'); }
  }
  async hasOwner(): Promise<boolean> {
    const probe = new Store(this.dir);
    try { await probe.acquire(); await probe.release(); return false; }
    catch { return true; }
  }
  async acquire(): Promise<void> {
    this.ensure();
    // Canonical path prevents two differently spelled paths from bypassing the lock.
    const { realpathSync } = await import('node:fs');
    let canonical = realpathSync(this.dir);
    if (process.platform === 'win32') canonical = canonical.toLowerCase();
    const hash = createHash('sha256').update(canonical).digest('hex');
    const server = createServer(socket => socket.destroy());
    const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\codex-autoresume-${hash}` : { host: '127.0.0.1', port: 30000 + (parseInt(hash.slice(0, 8), 16) % 20000), exclusive: true };
    await new Promise<void>((resolve, reject) => {
      server.once('error', () => reject(new Error('Another supervisor owns this state directory (or its lock endpoint is occupied). Use car status or car cancel.')));
      server.listen(endpoint as never, resolve);
    });
    this.lock = server;
  }
  async release(): Promise<void> {
    if (this.lock) await new Promise<void>(resolve => this.lock!.close(() => resolve()));
    this.lock = undefined;
  }
}
