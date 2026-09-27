import { fork, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Command } from './codex.js';

export class PtySession {
  private host?: ChildProcess;
  start(command: Command, cwd: string, cols: number, rows: number, onData: (data: string) => void, onExit: (code: number) => void): void {
    const js = fileURLToPath(new URL('./pty-host.js', import.meta.url));
    const compiled = existsSync(js);
    const host = fork(compiled ? js : js.replace(/\.js$/, '.ts'), [], { execArgv: compiled ? [] : ['--import', 'tsx'], windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    this.host = host;
    let completed = false;
    const exit = (code: number) => { if (!completed) { completed = true; if (this.host === host) this.host = undefined; onExit(code); } };
    host.on('message', (msg: any) => {
      if (msg.type === 'data') onData(msg.data);
      if (msg.type === 'exit') exit(msg.code);
      if (msg.type === 'failure') exit(1);
    });
    host.on('error', () => exit(1)); host.on('exit', code => exit(code ?? 1));
    const env: NodeJS.ProcessEnv = { ...process.env, ...command.env, TERM: !process.env.TERM || process.env.TERM === 'dumb' ? 'xterm-256color' : process.env.TERM };
    delete env.CODEX_THREAD_ID;
    host.send({ type: 'start', file: command.file, args: command.args, cwd, cols, rows, env });
  }
  write(data: string): void { this.send({ type: 'write', data }); }
  resize(cols: number, rows: number): void { this.send({ type: 'resize', cols, rows }); }
  private send(msg: unknown): void { if (this.host?.connected) this.host.send(msg as any, () => {}); }
  stop(): void { this.send({ type: 'stop' }); }
}
