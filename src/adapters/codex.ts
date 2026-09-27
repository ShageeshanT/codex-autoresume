import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

export type Command = { file: string; args: string[]; env?: Record<string, string> };
export function resolveCodex(explicit?: string): string {
  const candidates = explicit ? [path.resolve(explicit)] : (process.env.PATH ?? '').split(path.delimiter).flatMap(dir => {
    const names = process.platform === 'win32' ? ['codex.exe', 'codex.cmd', 'codex.ps1'] : ['codex'];
    return names.map(name => path.join(dir, name));
  });
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    if (process.platform !== 'win32' || candidate.endsWith('.exe')) return candidate;
    const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
    const pkg = path.join(path.dirname(candidate), 'node_modules', '@openai', 'codex');
    const binary = path.join(pkg, 'node_modules', '@openai', `codex-win32-${process.arch}`, 'vendor', `${arch}-pc-windows-msvc`, 'bin', 'codex.exe');
    if (existsSync(binary)) return binary;
  }
  throw new Error('Cannot find a native Codex executable. Install @openai/codex, or pass --codex PATH to codex.exe.');
}
export function codexVersion(file: string): string {
  return execFileSync(file, ['--version'], { encoding: 'utf8', timeout: 10_000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}
export function checkCompatibility(file: string): string {
  const version = codexVersion(file);
  const help = execFileSync(file, ['--help'], { encoding: 'utf8', timeout: 10_000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  if (!help.includes('--remote')) throw new Error(`${version} lacks --remote support. Update Codex before using this adapter.`);
  return version;
}
// Persist only approved options, never original prompts, images or arbitrary config secrets.
const valueFlags = new Set(['--model', '-m', '--sandbox', '-s', '--ask-for-approval', '-a', '--profile', '-p', '--add-dir', '--enable', '--disable']);
const switches = new Set(['--search', '--no-alt-screen', '--approve-for-me']);
export function validateArgs(args: string[]): string[] {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (switches.has(arg)) continue;
    if (valueFlags.has(arg) && args[i + 1] && !args[i + 1]!.startsWith('-')) { i++; continue; }
    throw new Error(`Unsupported Codex argument: ${arg}. Use --help for supported options; enter your prompt inside Codex.`);
  }
  return args;
}
export function backendArgs(args: string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (['--profile', '-p', '--enable', '--disable'].includes(arg)) result.push(arg, args[++i]!);
    else if (valueFlags.has(arg)) i++;
  }
  return result;
}
