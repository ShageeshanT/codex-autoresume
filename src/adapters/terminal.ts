import { StringDecoder } from 'node:string_decoder';
import type { Command } from './codex.js';
import { PtySession } from './pty-session.js';

export class Terminal {
  private child?: PtySession;
  private cleanup?: () => void;
  start(command: Command, cwd: string, onExit: (code: number) => void): void {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Launch car in an interactive terminal. Use car demo for a non-interactive check.');
    const child = new PtySession(); this.child = child;
    const decoder = new StringDecoder('utf8');
    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true); process.stdin.resume();
    const input = (data: Buffer) => child.write(decoder.write(data));
    const resize = () => child.resize(process.stdout.columns || 100, process.stdout.rows || 30);
    process.stdin.on('data', input); process.stdout.on('resize', resize);
    this.cleanup = () => {
      process.stdin.off('data', input); process.stdout.off('resize', resize);
      process.stdin.setRawMode(wasRaw ?? false); process.stdin.pause();
    };
    child.start(command, cwd, process.stdout.columns || 100, process.stdout.rows || 30,
      data => { if (this.child === child) process.stdout.write(data); },
      code => {
        if (this.child !== child) return;
        this.cleanup?.(); this.cleanup = undefined; this.child = undefined; onExit(code);
      });
  }
  stop(): void {
    const child = this.child; this.child = undefined;
    this.cleanup?.(); this.cleanup = undefined;
    if (child) { child.stop(); process.stdout.write('\x1b[?1049l\x1b[?25h\x1b[0m\r\n'); }
  }
}
