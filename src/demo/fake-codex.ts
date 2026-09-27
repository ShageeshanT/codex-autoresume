// Deterministic local fixture. This executable never contacts Codex or any service.
import { createInterface } from 'node:readline';
import { WebSocket } from 'ws';

const args = process.argv.slice(2);
if (args[0] === '--tui') {
  const client = new WebSocket(args[1]!, { headers: { Authorization: `Bearer ${process.env.CAR_BRIDGE_TOKEN}` } });
  const resume = args[2] === 'resume';
  const autoContinue = args[3] === 'continue';
  console.log(resume ? 'Fake Codex: resuming saved session.' : 'Fake Codex: terminal connected.');
  client.on('open', () => client.send(JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'fake_tui', version: '1' } } })));
  client.on('error', () => process.exit(1));
  client.on('close', () => process.exit(0));
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.on('data', data => { if (data.includes(3)) process.exit(0); });
  }
  client.on('message', raw => {
    const msg = JSON.parse(raw.toString());
    if (msg.id === 1) {
      client.send(JSON.stringify({ method: 'initialized' }));
      client.send(JSON.stringify({ id: 2, method: resume ? 'thread/resume' : 'thread/start', params: { threadId: 'fake-session', cwd: process.cwd() } }));
    }
    if (msg.id === 2) {
      if (resume && !autoContinue) { console.log('Fake Codex: session ready; no prompt submitted.'); setTimeout(() => process.exit(0), 50); }
      else client.send(JSON.stringify({ id: 3, method: 'turn/start', params: { threadId: 'fake-session', input: [{ type: 'text', text: resume ? 'Continue' : 'Demo task' }] } }));
    }
    if (msg.method === 'turn/completed') {
      console.log(msg.params.turn.status === 'failed' ? 'Fake Codex: usage allowance exhausted.' : 'Fake Codex: interrupted task completed.');
      if (msg.params.turn.status === 'completed') setTimeout(() => process.exit(0), 50);
    }
  });
} else {
  let resetAt = Date.now() + 2500;
  const thread = { id: 'fake-session', cwd: process.cwd(), updatedAt: 1, status: { type: 'idle' }, turns: [] as any[] };
  const send = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + '\n');
  createInterface({ input: process.stdin }).on('line', line => {
    const msg = JSON.parse(line);
    if (!msg.method) {
      if (msg.id === 'approval-1') send({ method: 'test/approvalResult', params: { response: msg } });
      return;
    }
    if (msg.id === undefined) return;
    const reply = (result: unknown) => send({ id: msg.id, result });
    switch (msg.method) {
      case 'initialize': reply({ userAgent: 'fake-codex/1', platformFamily: 'windows', platformOs: 'windows' }); break;
      case 'thread/start': case 'thread/resume': reply({ thread, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: { type: 'workspaceWrite' } }); break;
      case 'thread/read': reply({ thread }); break;
      case 'thread/turns/list': reply({ data: thread.turns.slice(-1), nextCursor: null }); break;
      case 'account/read': reply({ account: { type: 'chatgpt' } }); break;
      case 'account/rateLimits/read': reply({ rateLimits: { primary: { usedPercent: Date.now() < resetAt ? 100 : 20, resetsAt: resetAt / 1000 }, secondary: null, rateLimitReachedType: null } }); break;
      case 'turn/start': {
        const first = thread.turns.length === 0;
        if (first) resetAt = Date.now() + 2500;
        const scenario = args.find(a => a.startsWith('--scenario='))?.split('=')[1];
        const errorInfo = scenario === 'auth' ? 'unauthorized' : scenario === 'network' ? 'internalServerError' : 'usageLimitExceeded';
        const turn = { id: `turn-${thread.turns.length + 1}`, status: first ? 'failed' : 'completed', error: first ? { codexErrorInfo: errorInfo, message: `Usage limit reached. Reset at ${new Date(resetAt).toISOString()}` } : null };
        thread.turns.push(turn); thread.updatedAt++;
        reply({ turn: { ...turn, status: 'inProgress' } });
        send({ method: 'turn/started', params: { threadId: thread.id, turn: { ...turn, status: 'inProgress' } } });
        send({ method: 'turn/completed', params: { threadId: thread.id, turn } });
        break;
      }
      case 'test/approval': send({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { command: 'example' } }); reply({}); break;
      default: send({ id: msg.id, error: { code: -32601, message: 'Unknown fixture method' } });
    }
  }).on('close', () => process.exit(0));
}
