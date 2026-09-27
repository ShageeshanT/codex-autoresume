import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import type { Command } from './codex.js';

export type Message = { id?: string | number; method?: string; params?: any; result?: any; error?: any };
export class Bridge extends EventEmitter {
  private proc?: ChildProcessWithoutNullStreams;
  private server?: WebSocketServer;
  private client?: WebSocket;
  private sequence = 0;
  private initialized: unknown;
  private closing = false;
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private forwarded = new Map<string, { id: string | number; method: string; client: WebSocket }>();
  private serverRequests = new Map<string, string | number>();
  gate: () => boolean = () => true;
  threadGuard: (result: any) => boolean = () => true;
  url = '';
  readonly token = randomUUID();
  constructor(private command: Command, private cwd: string, private timeoutMs = 20_000) { super(); }
  async start(): Promise<void> {
    const env = { ...process.env };
    delete env.CODEX_THREAD_ID;
    this.proc = spawn(this.command.file, this.command.args, { cwd: this.cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stderr.resume(); // Never persist Codex diagnostics that may contain user content.
    this.proc.on('error', () => this.fail('Could not start the Codex app-server.'));
    this.proc.on('exit', () => { if (!this.closing) this.fail('Codex app-server exited. Run car recover after checking Codex.'); });
    this.proc.stdin.on('error', () => { if (!this.closing) this.fail('Codex app-server input closed.'); });
    createInterface({ input: this.proc.stdout }).on('line', line => {
      try { this.receive(JSON.parse(line)); }
      catch { this.fail('Codex sent an incompatible protocol message.'); }
    });
    this.initialized = await this.request('initialize', { clientInfo: { name: 'codex_autoresume', title: 'Codex AutoResume', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    this.send({ method: 'initialized', params: {} });
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: 16 * 1024 * 1024, verifyClient: (info: { origin: string; req: IncomingMessage }) => !info.origin && info.req.url === '/' && info.req.headers.authorization === `Bearer ${this.token}` && !this.client });
    this.server = server;
    await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    server.on('error', () => this.fail('Local terminal bridge failed.'));
    const address = server.address();
    if (typeof address !== 'object' || !address) throw new Error('Cannot bind local terminal bridge.');
    this.url = `ws://127.0.0.1:${address.port}`;
    server.on('connection', client => {
      if (this.client) { client.close(1008); return; }
      this.client = client;
      client.on('error', () => client.close());
      client.on('message', raw => {
        try { this.fromClient(client, JSON.parse(raw.toString())); }
        catch { client.close(1008, 'Invalid protocol message'); }
      });
      client.on('close', () => {
        if (this.client === client) this.client = undefined;
        for (const [key, req] of this.forwarded) if (req.client === client) this.forwarded.delete(key);
        // A missing terminal must never turn into implicit approval.
        for (const [key, id] of this.serverRequests) {
          this.send({ id, error: { code: -32000, message: 'Terminal disconnected; user approval unavailable.' } });
          this.serverRequests.delete(key);
        }
      });
    });
  }
  private send(msg: Message): void { if (!this.proc?.stdin.destroyed) this.proc?.stdin.write(JSON.stringify(msg) + '\n'); }
  private sendClient(client: WebSocket | undefined, msg: Message): void { if (client?.readyState === WebSocket.OPEN) client.send(JSON.stringify(msg)); }
  private fromClient(client: WebSocket, msg: Message): void {
    if (msg.method === 'initialize') { this.sendClient(client, { id: msg.id, result: this.initialized }); return; }
    if (msg.method === 'initialized') return;
    if (msg.method && msg.id !== undefined) {
      if (!this.gate()) {
        this.sendClient(client, { id: msg.id, error: { code: -32000, message: 'AutoResume is waiting. Cancel supervision to resume manually.' } }); return;
      }
      const id = `ui:${++this.sequence}`;
      this.forwarded.set(id, { id: msg.id, method: msg.method, client });
      this.send({ ...msg, id });
    } else if (msg.id !== undefined) {
      const original = this.serverRequests.get(String(msg.id));
      if (original !== undefined) { this.serverRequests.delete(String(msg.id)); this.send({ ...msg, id: original }); }
    } else if (this.gate()) this.send(msg);
  }
  private receive(msg: Message): void {
    if (!msg || typeof msg !== 'object') throw new Error('Invalid message');
    if (msg.id !== undefined && !msg.method) {
      const own = this.pending.get(String(msg.id));
      if (own) {
        this.pending.delete(String(msg.id)); clearTimeout(own.timer);
        if (msg.error) own.reject(new Error('Codex could not complete a status request. Check login, connectivity and compatibility.'));
        else own.resolve(msg.result);
        return;
      }
      const forward = this.forwarded.get(String(msg.id));
      if (forward) {
        this.forwarded.delete(String(msg.id));
        if (['thread/start', 'thread/resume', 'thread/fork'].includes(forward.method) && msg.result?.thread) {
          if (!this.threadGuard(msg.result)) {
            this.sendClient(forward.client, { id: forward.id, error: { code: -32000, message: 'AutoResume paused because the saved session or permissions changed.' } });
            return;
          }
          this.emit('thread', msg.result.thread);
        }
        this.sendClient(forward.client, { ...msg, id: forward.id });
      }
      return;
    }
    if (msg.id !== undefined && msg.method) {
      if (!this.client) { this.send({ id: msg.id, error: { code: -32000, message: 'User interaction requires a connected terminal.' } }); return; }
      const id = `server:${++this.sequence}`;
      this.serverRequests.set(id, msg.id);
      this.sendClient(this.client, { ...msg, id });
      return;
    }
    this.emit('notification', msg);
    this.sendClient(this.client, msg);
  }
  request(method: string, params?: unknown): Promise<any> {
    if (this.closing) return Promise.reject(new Error('Bridge is closed.'));
    const id = `car:${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Codex status request timed out.')); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, ...(params === undefined ? {} : { params }) });
    });
  }
  private fail(message: string): void {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(message)); }
    this.pending.clear();
    if (!this.closing) this.emit('failure', new Error(message));
  }
  disconnectTerminal(): void { this.client?.terminate(); this.client = undefined; }
  async close(): Promise<void> {
    this.closing = true;
    this.fail('Bridge closed.');
    this.disconnectTerminal();
    if (this.server) await new Promise<void>(resolve => this.server!.close(() => resolve()));
    const proc = this.proc;
    if (proc && proc.exitCode === null && proc.signalCode === null) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { proc.kill(); resolve(); }, 2000);
        proc.once('exit', () => { clearTimeout(timer); resolve(); });
        proc.stdin.end();
      });
    }
  }
}
