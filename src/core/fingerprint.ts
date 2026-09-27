import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import path from 'node:path';

// Hash contents as well as status: editing an already-dirty file must invalidate the wait.
export function repositoryFingerprint(cwd: string): string | null {
  let workingRoot = cwd;
  const git = (...args: string[]): Buffer => execFileSync('git', ['-C', workingRoot, ...args], { windowsHide: true, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    const root = git('rev-parse', '--show-toplevel').toString().trim();
    workingRoot = root;
    const hash = createHash('sha256');
    try { hash.update(git('rev-parse', 'HEAD')); } catch { hash.update('unborn'); }
    hash.update(git('status', '--porcelain=v1', '-z', '--untracked-files=all'));
    hash.update(git('diff', '--no-ext-diff', '--binary'));
    hash.update(git('diff', '--no-ext-diff', '--cached', '--binary'));
    const files = git('ls-files', '--cached', '--others', '--exclude-standard', '-z').toString().split('\0').filter(Boolean).sort();
    for (const name of files) {
      hash.update(name + '\0');
      try {
        const file = path.join(root, name), stat = lstatSync(file);
        if (stat.isSymbolicLink()) hash.update(readlinkSync(file));
        else if (stat.isFile()) {
          if (stat.size > 32 * 1024 * 1024) return null;
          hash.update(readFileSync(file));
        } else return null; // e.g. submodules: require manual continuation
      } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') hash.update('deleted'); else return null; }
    }
    return hash.digest('hex');
  } catch { return null; }
}

export function threadStamp(thread: { id: string; updatedAt: number; turns: { id: string; status: string }[] }): string {
  return createHash('sha256').update(JSON.stringify({ id: thread.id, updatedAt: thread.updatedAt, turns: thread.turns.map(t => [t.id, t.status]) })).digest('hex');
}

export function policyStamp(settings: { approvalPolicy?: unknown; approvalsReviewer?: unknown; sandbox?: unknown; sandboxPolicy?: unknown }): string | null {
  if (!settings.approvalPolicy || !settings.approvalsReviewer || !(settings.sandbox ?? settings.sandboxPolicy)) return null;
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
  return createHash('sha256').update(JSON.stringify(canonical({ approvalPolicy: settings.approvalPolicy, approvalsReviewer: settings.approvalsReviewer, sandbox: settings.sandbox ?? settings.sandboxPolicy }))).digest('hex');
}
