import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Bridge, type Message } from '../adapters/bridge.js';
import { type Command } from '../adapters/codex.js';
import { Store } from './store.js';
import { transition, isWaiting, type SessionState, type Status } from './state.js';
import { eligibility, nextCheck, parseResetHint } from './limits.js';
import { repositoryFingerprint, threadStamp, policyStamp } from './fingerprint.js';

export const CONTINUE_PROMPT = 'Continue the interrupted task from the current session state. Do not redo completed work.';
const threadSchema = z.object({ id: z.string(), cwd: z.string(), updatedAt: z.number(), status: z.object({ type: z.string() }), turns: z.array(z.object({ id: z.string(), status: z.string() })) });
export interface TerminalAdapter { start(command: Command, cwd: string, onExit: (code: number) => void): void; stop(): void }
export interface SupervisorOptions {
  graceMs?: number; pollMs?: number; maxAttempts?: number;
  now?: () => number; fingerprint?: (cwd: string) => string | null;
  terminalCommand?: (url: string, state: SessionState, resume: boolean) => Command;
  say?: (message: string) => void;
}

export class Supervisor {
  private queue: Promise<void> = Promise.resolve();
  private timer?: NodeJS.Timeout;
  private finished = false;
  private held = false;
  private resolveDone!: () => void;
  readonly done = new Promise<void>(resolve => { this.resolveDone = resolve; });
  private now: () => number;
  private fingerprint: (cwd: string) => string | null;
  private say: (message: string) => void;
  constructor(readonly store: Store, public state: SessionState, readonly bridge: Bridge, private terminal: TerminalAdapter, private options: SupervisorOptions = {}) {
    this.now = options.now ?? Date.now;
    this.fingerprint = options.fingerprint ?? repositoryFingerprint;
    this.say = options.say ?? (message => process.stdout.write(`[AutoResume] ${message}\n`));
    bridge.gate = () => !this.held && ['RUNNING', 'RESUMING'].includes(this.state.status);
    // This guard is synchronous: validate before the TUI sees resume success and can submit its prompt.
    bridge.threadGuard = result => {
      if (!['RUNNING', 'RESUMING'].includes(this.state.status)) return false;
      const thread = result.thread, stamp = policyStamp(result);
      if (this.state.status === 'RESUMING' && (thread.id !== this.state.sessionId || thread.cwd !== this.state.cwd)) { this.pause('Codex reopened an unexpected session.'); return false; }
      if (this.state.status === 'RESUMING' && (!stamp || stamp !== this.state.policyStamp)) { this.pause('Codex permissions changed since the interrupted turn. Automatic submission is paused.'); return false; }
      if (typeof thread.id !== 'string' || typeof thread.cwd !== 'string' || !stamp) { this.pause('Codex session or permission metadata is incompatible.'); return false; }
      this.save('RUNNING', { sessionId: thread.id, cwd: thread.cwd, policyStamp: stamp });
      return true;
    };
    bridge.on('notification', (msg: Message) => this.enqueue(() => this.notification(msg)));
    bridge.on('failure', () => this.enqueue(async () => this.pause('Codex app-server disconnected. Saved waiting state can be inspected with car status.')));
  }
  private enqueue(fn: () => Promise<void>): void {
    this.queue = this.queue.then(async () => { if (!this.finished) await fn(); }).catch(() => {
      try { this.pause('Supervision failed. Inspect car status and verify Codex compatibility before restarting.'); }
      catch { this.finish(); }
    });
  }
  private save(status: Status, patch: Partial<SessionState> = {}): void {
    const previous = this.state.status;
    this.state = transition(this.state, status, patch);
    this.store.write(this.state);
    if (previous !== status) this.store.log('state', { from: previous, to: status, sessionId: this.state.sessionId, resetAt: this.state.resetAt });
  }
  async start(recover = false): Promise<void> {
    this.store.write(this.state);
    if (recover && !isWaiting(this.state)) {
      if (['RUNNING', 'RESUMING'].includes(this.state.status)) this.pause('Previous dispatch may already have run. Automatic replay is disabled; resume this session manually.');
      else { this.say(`State is ${this.state.status}; there is no recoverable wait.`); this.finish(); }
      return;
    }
    await this.bridge.start();
    if (recover) {
      this.held = true;
      if (this.state.status === 'VERIFYING') this.save('AWAITING_RESET_INFO');
      this.say(`Recovered session ${this.state.sessionId}. Waiting until ${new Date(this.state.nextCheckAt ?? this.now()).toLocaleString()}.`);
    } else this.launch(false);
    this.timer = setInterval(() => this.enqueue(() => this.tick()), this.options.pollMs ?? 1000);
    this.enqueue(() => this.tick());
  }
  private launch(resume: boolean): void {
    const state = this.state;
    const command = this.options.terminalCommand?.(this.bridge.url, state, resume) ?? {
      file: state.codexPath,
      args: [...state.codexArgs, ...(state.sessionId ? ['resume', state.sessionId] : []), '--remote', this.bridge.url, '--remote-auth-token-env', 'CAR_BRIDGE_TOKEN', ...(resume && state.autoContinue ? [CONTINUE_PROMPT] : [])],
    };
    command.env = { ...command.env, CAR_BRIDGE_TOKEN: this.bridge.token, CAR_STATE_DIR: this.store.dir };
    this.held = false;
    this.terminal.start(command, state.cwd, code => this.enqueue(async () => {
      if (this.state.status === 'RUNNING') this.save(code === 0 ? 'COMPLETED' : 'PAUSED', { reason: code === 0 ? null : `Codex terminal exited with code ${code}.` });
      else if (this.state.status === 'RESUMING') this.save('PAUSED', { reason: 'Terminal exited before resume was confirmed. Automatic replay is disabled.' });
      this.finish();
    }));
  }
  private async notification(msg: Message): Promise<void> {
    const p = msg.params;
    if (p?.threadId !== this.state.sessionId) return;
    if (msg.method === 'thread/settings/updated' && this.state.status === 'RUNNING') {
      this.save('RUNNING', { policyStamp: policyStamp(p.threadSettings ?? {}) }); return;
    }
    if (msg.method === 'turn/started') {
      if (isWaiting(this.state)) { this.pause('Session activity changed while waiting. Resume manually to avoid duplicate work.'); return; }
      if (this.state.status === 'RUNNING') this.save('RUNNING', { turnId: p.turn?.id ?? null });
      return;
    }
    if (msg.method !== 'turn/completed' || this.state.status !== 'RUNNING' || p.turn?.status !== 'failed') return;
    const error = p.turn.error;
    if (!['usageLimitExceeded', 'rateLimitExceeded'].includes(error?.codexErrorInfo)) return;
    if (typeof p.turn.id !== 'string') return;
    if (this.state.claimedTurnIds.includes(p.turn.id)) return;
    this.held = true;
    let limits: ReturnType<typeof eligibility> = { kind: 'unknown', resetAt: null };
    try { limits = eligibility(await this.bridge.request('account/rateLimits/read')); } catch { /* confirmed usage errors may wait without a known reset */ }
    if (error.codexErrorInfo === 'rateLimitExceeded' && limits.kind !== 'limited') { this.held = false; return; }
    this.terminal.stop(); this.bridge.disconnectTerminal();
    const resetAt = limits.resetAt ?? parseResetHint(error.message ?? '');
    this.save(resetAt === null ? 'AWAITING_RESET_INFO' : 'WAITING_FOR_RESET', {
      turnId: p.turn.id, detectedAt: this.now(), resetAt,
      nextCheckAt: nextCheck(this.now(), resetAt, this.options.graceMs ?? 45_000, 0),
      verificationFailures: 0, fingerprint: this.state.autoContinue ? this.fingerprint(this.state.cwd) : null,
      claim: null, reason: null,
    });
    try {
      const thread = await this.readThread();
      if (thread.turns.at(-1)?.id !== this.state.turnId || thread.turns.at(-1)?.status !== 'failed') {
        this.pause('Saved session does not match the interrupted turn.'); return;
      }
      this.save(this.state.status, { threadStamp: threadStamp(thread) });
    } catch { this.pause('Cannot verify the saved Codex session. Automatic continuation is paused.'); return; }
    this.say(`Usage limit confirmed. Session ${this.state.sessionId} saved.`);
    this.say(`Next allowance check: ${new Date(this.state.nextCheckAt!).toLocaleString()}. Leave this terminal open, or use car recover later.`);
  }
  private async readThread() {
    // Read metadata and only the latest turn, avoiding full chat-history hydration.
    const result = await this.bridge.request('thread/read', { threadId: this.state.sessionId, includeTurns: false });
    const turns = await this.bridge.request('thread/turns/list', { threadId: this.state.sessionId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' });
    result.thread.turns = turns.data;
    const thread = threadSchema.parse(result.thread);
    if (thread.id !== this.state.sessionId || thread.cwd !== this.state.cwd) throw new Error('Wrong saved session');
    return thread;
  }
  async tick(): Promise<void> {
    if (this.finished) return;
    if (this.store.cancelled(this.state.runId)) { this.save('CANCELLED', { reason: 'Cancelled by user.' }); this.say('Automatic resumption cancelled.'); this.finish(); return; }
    const control = this.store.readControl();
    if (control && control.id !== this.state.controlId && control.runId === this.state.runId && control.sessionId === this.state.sessionId) {
      // Turning on requires a new interruption fingerprint. Do not enable it partway through a wait.
      if (this.state.status === 'RUNNING' || !control.autoContinue) {
        this.save(this.state.status, { autoContinue: control.autoContinue, controlId: control.id });
        this.store.log('auto_continue', { enabled: control.autoContinue });
      }
    }
    if (!isWaiting(this.state) || this.now() < (this.state.nextCheckAt ?? Infinity)) return;
    this.save('VERIFYING');
    this.say('Checking current Codex allowance...');
    let limits: ReturnType<typeof eligibility>;
    try { limits = eligibility(await this.bridge.request('account/rateLimits/read')); }
    catch { limits = { kind: 'unknown', resetAt: null }; }
    if (this.store.cancelled(this.state.runId)) { this.save('CANCELLED'); this.finish(); return; }
    if (limits.kind !== 'available') {
      const failures = this.state.verificationFailures + 1;
      this.save(limits.resetAt === null ? 'AWAITING_RESET_INFO' : 'WAITING_FOR_RESET', {
        resetAt: limits.resetAt, verificationFailures: failures,
        nextCheckAt: nextCheck(this.now(), limits.resetAt, this.options.graceMs ?? 45_000, failures),
      });
      this.say(`Allowance ${limits.kind === 'limited' ? 'still exhausted' : 'could not be verified'}. Next check: ${new Date(this.state.nextCheckAt!).toLocaleString()}.`);
      return;
    }
    const thread = await this.readThread();
    if (thread.status.type === 'active' || threadStamp(thread) !== this.state.threadStamp) { this.pause('Saved session changed while waiting. Resume manually to avoid duplicate work.'); return; }
    if (this.state.autoContinue && (!this.state.fingerprint || this.fingerprint(this.state.cwd) !== this.state.fingerprint)) {
      this.pause('Workspace changed or cannot be fingerprinted. Automatic prompt submission requires an unchanged Git workspace.'); return;
    }
    if (this.state.resumeAttempts >= (this.options.maxAttempts ?? 5)) { this.pause('Maximum automatic resumes reached.'); return; }
    if (this.store.cancelled(this.state.runId)) { this.save('CANCELLED'); this.finish(); return; }
    // Commit the claim BEFORE dispatch. Recovery from RESUMING never resends a prompt.
    this.save('RESUMING', { claim: randomUUID(), claimedTurnIds: [...this.state.claimedTurnIds, this.state.turnId!], resumeAttempts: this.state.resumeAttempts + 1 });
    this.say(`Allowance available. Reopening session ${this.state.sessionId}${this.state.autoContinue ? ' with one continuation prompt' : ''}.`);
    try { this.launch(true); }
    catch { this.pause('Could not open Codex after claiming this resume. Automatic replay is disabled.'); }
  }
  pause(reason: string): void {
    if (this.finished) return;
    this.save('PAUSED', { reason }); this.say(reason); this.finish();
  }
  interrupt(): void {
    if (this.finished) return;
    this.say(isWaiting(this.state) ? 'Waiting state saved. Use car recover to continue supervision.' : 'Supervisor stopped. Inspect car status before resuming.');
    this.finish();
  }
  private finish(): void {
    if (this.finished) return;
    this.finished = true; this.held = true; clearInterval(this.timer); this.terminal.stop(); this.resolveDone();
  }
  async close(): Promise<void> { this.finish(); await this.queue; await this.bridge.close(); }
}
