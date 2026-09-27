import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../core/store.js';
import { shellQuote, shellName } from '../platform/shell.js';

export const insideActions = ['status', 'on', 'off', 'start', 'recover', 'stop'] as const;
export async function insideCommand(action: string, store: Store, cliPath: string, cwd: string, sessionId?: string): Promise<string> {
  if (!(insideActions as readonly string[]).includes(action)) throw new Error(`Use one of: ${insideActions.join(', ')}.`);
  if (sessionId && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sessionId)) throw new Error('The current Codex session ID must be a UUID.');
  const state = store.read();
  const command = `node ${shellQuote(path.resolve(cliPath))}`;
  if (action === 'recover') {
    return `Recovery needs an interactive terminal. Save your current work and exit Codex with /quit, then run in ${shellName()}:\n${command} --state-dir ${shellQuote(store.dir)} recover\nNo recovery has been started by this command.`;
  }
  const matches = !!sessionId && state?.sessionId === sessionId;
  const active = !!state && matches && await store.hasOwner();
  const summary = !state ? 'No saved AutoResume session.' : `Saved state: ${state.status}\nSaved session: ${state.sessionId ?? 'not initialized'}\nAutomatic continuation: ${state.autoContinue ? 'on' : 'off'}\nCurrent session supervised: ${active ? 'yes' : 'no'}\nState directory: ${store.dir}`;
  if (action === 'status') return summary;
  if (action === 'start' || (action === 'on' && !active)) {
    if (active) return `${summary}\nThis session is already supervised. Use the on action to enable continuation.`;
    if (!sessionId) return `${summary}\nI cannot identify this session automatically. Find its session ID with /status; do not guess or use --last. Then exit Codex and launch the wrapper with --resume followed by that ID.`;
    return `${summary}\nAutoResume is not attached to this session. To supervise this same conversation, finish the current turn, use /quit, then run in ${shellName()}:\n${command} --state-dir ${shellQuote(store.dir)} -C ${shellQuote(cwd)} --resume ${shellQuote(sessionId)}${action === 'on' ? ' --auto-continue' : ''}\nThis is a handoff instruction only; no supervisor has been started. If this state directory belongs to another active session, choose a separate --state-dir.`;
  }
  if (!active || !state || !sessionId) throw new Error(`${summary}\nNo active supervisor for this session. No changes made.`);
  if (action === 'stop') {
    store.cancel(state.runId);
    return 'Cancellation requested for this session. Its wrapper terminal will close; Codex history is preserved.';
  }
  if (action === 'on' && state.status !== 'RUNNING') throw new Error('Enable continuation before a usage interruption. A wait already in progress cannot acquire a retroactive workspace fingerprint.');
  const id = store.requestAutoContinue(state.runId, sessionId, action === 'on');
  for (let attempt = 0; attempt < 20; attempt++) {
    await delay(150);
    const current = store.read();
    if (current?.runId !== state.runId) throw new Error('Supervisor changed while applying the request. Check status.');
    if (current.controlId === id) return `Automatic continuation is now ${current.autoContinue ? 'on' : 'off'} for this session.${current.autoContinue ? ' Submission after reset requires unchanged session, permissions and Git workspace.' : ' After reset the session will reopen and wait for your input.'}`;
  }
  return 'Request saved but not yet acknowledged. Run status to verify; do not assume the setting has changed.';
}
