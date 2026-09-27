#!/usr/bin/env node
import { Command } from 'commander';
import path from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { Store, defaultStateDir } from './core/store.js';
import { isWaiting } from './core/state.js';
import { Supervisor } from './core/supervisor.js';
import { Bridge } from './adapters/bridge.js';
import { Terminal } from './adapters/terminal.js';
import { resolveCodex, checkCompatibility, validateArgs, backendArgs } from './adapters/codex.js';
import { initialState, runDemo } from './demo/demo.js';
import { fileURLToPath } from 'node:url';
import { insideCommand } from './commands/inside.js';

const program = new Command();
const divider = process.argv.indexOf('--');
const codexArgs = divider < 0 ? [] : process.argv.slice(divider + 1);
const argv = divider < 0 ? process.argv : process.argv.slice(0, divider);
program.name('car').description('Keep the Codex terminal recoverable across usage resets.').version('0.1.0')
  .option('--state-dir <directory>', 'local supervision state directory', defaultStateDir())
  .option('--codex <file>', 'native Codex executable path')
  .option('-C, --cwd <directory>', 'project directory', process.cwd())
  .option('--auto-continue', 'submit one continuation after a verified reset (requires Git)', false)
  .option('--resume <session-id>', 'start by opening a specific saved session')
  .addHelpText('after', '\nExamples:\n  car\n  car --auto-continue -- --model MODEL --sandbox workspace-write\n  car --resume UUID\n  car status\n  car recover\n  car demo\n\nAfter --, supported Codex options: --model, --sandbox, --ask-for-approval,\n--profile, --add-dir, --enable, --disable, --search, --no-alt-screen, --approve-for-me.\nEnter prompts in the Codex terminal. Ctrl+C while waiting saves the timer.\nUse car cancel in another terminal to cancel supervision.');
const getStore = () => new Store(program.opts().stateDir);

async function supervise(recover: boolean) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Open an interactive terminal to run Codex. Try npm run demo to test the recovery flow.');
  const opts = program.opts(), store = getStore();
  await store.acquire();
  let supervisor: Supervisor | undefined;
  const stop = () => supervisor?.interrupt();
  try {
    const previous = store.read();
    if (!recover && previous && !['COMPLETED', 'CANCELLED', 'PAUSED'].includes(previous.status)) throw new Error('A saved session exists. Use car recover or car cancel before starting another.');
    if (recover && !previous) throw new Error('No saved session to recover.');
    const file = recover ? previous!.codexPath : resolveCodex(opts.codex);
    const version = checkCompatibility(file);
    const state = recover ? previous! : initialState(path.resolve(opts.cwd), {
      codexPath: file, codexVersion: version, codexArgs: validateArgs(codexArgs), autoContinue: opts.autoContinue, sessionId: opts.resume ?? null,
    });
    if (recover && state.codexVersion !== version) throw new Error('Codex version changed while waiting. Resume the saved session manually, then start a new supervision run.');
    const bridge = new Bridge({ file, args: [...backendArgs(state.codexArgs), 'app-server', '--listen', 'stdio://'] }, state.cwd);
    supervisor = new Supervisor(store, state, bridge, new Terminal());
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    await supervisor.start(recover); await supervisor.done;
  } finally {
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
    await supervisor?.close(); await store.release();
  }
}
program.action(() => supervise(false));
program.command('recover').description('Recover a persisted quota wait; never replay an uncertain dispatch').action(() => supervise(true));
program.command('status').description('Show the saved session and next check').option('--json', 'print JSON').action(opts => {
  const store = getStore(), state = store.read();
  if (opts.json) { console.log(JSON.stringify(state, null, 2)); return; }
  if (!state) { console.log('No supervised session.'); return; }
  console.log(`State: ${state.status}${store.cancelled(state.runId) ? ' (cancellation requested)' : ''}\nSession: ${state.sessionId ?? 'not started'}\nProject: ${state.cwd}\nAuto-continue: ${state.autoContinue ? 'on' : 'off'}\nResume attempts: ${state.resumeAttempts}`);
  if (state.nextCheckAt && isWaiting(state)) console.log(`Next check: ${new Date(state.nextCheckAt).toLocaleString()} (${new Date(state.nextCheckAt).toISOString()})`);
  if (state.reason) console.log(`Reason: ${state.reason}`);
  console.log(`State directory: ${store.dir}`);
});
program.command('cancel').description('Cancel supervision without deleting Codex history').action(async () => {
  const store = getStore(), state = store.read();
  if (!state) { console.log('No supervised session.'); return; }
  store.cancel(state.runId);
  try {
    await store.acquire();
    try { const latest = store.read(); if (latest?.runId === state.runId && !['COMPLETED', 'CANCELLED'].includes(latest.status)) store.write({ ...latest, status: 'CANCELLED', reason: 'Cancelled by user.', updatedAt: Date.now() }); }
    finally { await store.release(); }
  } catch { /* A running supervisor will consume the request on its next tick. */ }
  console.log('Cancellation requested. Codex saved sessions are preserved.');
});
program.command('logs').description('Show recent metadata-only operational events').action(() => {
  const file = getStore().file('events.jsonl');
  console.log(`Log: ${file}`);
  if (existsSync(file)) console.log(readFileSync(file, 'utf8').trim().split('\n').slice(-30).join('\n'));
});
program.command('config').description('Show effective defaults').action(() => console.log(JSON.stringify({ stateDir: getStore().dir, autoContinue: false, graceSeconds: 45, unknownResetCheckMinutes: 15, maxResumeAttempts: 5, transcriptLogging: false }, null, 2)));
program.command('doctor').description('Check Codex, PTY, state storage and the status protocol; no model turn').action(async () => {
  const opts = program.opts(), file = resolveCodex(opts.codex);
  console.log(`Node: ${process.version}\nCodex: ${checkCompatibility(file)}\nExecutable: ${file}`);
  const store = getStore(); store.ensure();
  const pty = await import('node-pty');
  console.log(`PTY: ${typeof pty.spawn === 'function' ? 'loaded' : 'unavailable'}\nState: ${store.dir}`);
  const bridge = new Bridge({ file, args: ['app-server', '--listen', 'stdio://'] }, path.resolve(opts.cwd));
  try {
    await bridge.start();
    const account = await bridge.request('account/read', { refreshToken: false });
    console.log(`Protocol: connected\nAuthentication: ${account.account?.type ?? 'not signed in'}`);
    if (account.account?.type !== 'chatgpt') console.log('Quota recovery requires ChatGPT-backed Codex authentication.');
  } finally { await bridge.close(); }
});
program.command('demo').description('Run a local fake-Codex PTY reset/resume demonstration').action(runDemo);
program.command('inside [action]').description('Control AutoResume from a Codex skill or slash prompt').option('--session <uuid>', 'current Codex thread ID', process.env.CODEX_THREAD_ID).action(async (action, opts) => {
  console.log(await insideCommand(action ?? 'status', getStore(), fileURLToPath(import.meta.url), path.resolve(program.opts().cwd), opts.session));
});

program.parseAsync(argv).catch(error => { console.error(`AutoResume: ${(error as Error).message}`); process.exitCode = 1; });
