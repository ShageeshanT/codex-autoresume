// One host per terminal: exiting also releases node-pty's Windows output workers.
import * as pty from 'node-pty';
let child: pty.IPty | undefined;
let closing = false;
const send = (message: unknown) => { if (process.connected) process.send?.(message); };
const finish = (code: number) => {
  if (process.connected) process.send?.({ type: 'exit', code }, () => process.exit(0));
  else process.exit(0);
};
function stop() {
  if (closing) return; closing = true;
  if (!child) { finish(0); return; }
  try { child.write('\x03'); } catch { /* exited */ }
  setTimeout(() => { try { child?.write('\x03'); } catch { /* exited */ } }, 150);
  setTimeout(() => {
    try { child?.kill(); } catch { /* exited */ }
    setTimeout(() => finish(0), 300);
  }, 2000);
}
process.on('message', (msg: any) => {
  try {
    if (msg.type === 'start') {
      if (child) return;
      child = pty.spawn(msg.file, msg.args, { name: 'xterm-256color', cwd: msg.cwd, cols: msg.cols, rows: msg.rows, env: msg.env });
      child.onData(data => send({ type: 'data', data }));
      child.onExit(({ exitCode }) => finish(exitCode));
    } else if (msg.type === 'write') child?.write(msg.data);
    else if (msg.type === 'resize') child?.resize(msg.cols, msg.rows);
    else if (msg.type === 'stop') stop();
  } catch { send({ type: 'failure' }); stop(); }
});
process.on('disconnect', stop);
process.on('SIGTERM', stop);
