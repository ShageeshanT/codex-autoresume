import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { shellQuote } from '../src/platform/shell.js';

test('generated commands round-trip spaces, quotes, dollars and backticks through the host shell', () => {
  const value = "my project's $files `literal` & (test)";
  const command = `${process.platform === 'win32' ? '& ' : ''}${shellQuote(process.execPath)} -p ${shellQuote('process.argv[1]')} ${shellQuote(value)}`;
  const result = process.platform === 'win32'
    ? execFileSync('powershell.exe', ['-NoProfile', '-Command', command], { encoding: 'utf8', windowsHide: true })
    : execFileSync('/bin/sh', ['-c', command], { encoding: 'utf8' });
  assert.equal(result.trim(), value);
});

test('install, reinstall and uninstall preserve unrelated Codex files', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'car install test '));
  writeFileSync(path.join(home, 'config.toml'), 'keep-this-config');
  const script = path.resolve('scripts/install-codex.mjs');
  const run = (...args: string[]) => execFileSync(process.execPath, [script, '--codex-home', home, ...args], { encoding: 'utf8', windowsHide: true });
  run(); run();
  const skill = readFileSync(path.join(home, 'skills', 'autoresume', 'SKILL.md'), 'utf8');
  assert.equal(skill.includes('__APP_'), false); assert.equal(skill.includes('rtk proxy'), false);
  assert.ok(skill.includes(path.resolve('dist/cli.js')));
  const prompt = readFileSync(path.join(home, 'prompts', 'autoresume.md'), 'utf8');
  assert.ok(prompt.includes(path.join(home, 'skills', 'autoresume', 'SKILL.md')));
  assert.ok(prompt.includes('$ARGUMENTS'));
  run('--uninstall');
  assert.equal(existsSync(path.join(home, 'prompts', 'autoresume.md')), false);
  assert.equal(existsSync(path.join(home, 'skills', 'autoresume', 'SKILL.md')), false);
  assert.equal(readFileSync(path.join(home, 'config.toml'), 'utf8'), 'keep-this-config');
});

test('installer and uninstaller refuse to overwrite an unrelated command', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'car-conflict-'));
  mkdirSync(path.join(home, 'prompts'));
  const prompt = path.join(home, 'prompts', 'autoresume.md');
  writeFileSync(prompt, 'my own command');
  for (const extra of [[], ['--uninstall']]) {
    assert.throws(() => execFileSync(process.execPath, [path.resolve('scripts/install-codex.mjs'), '--codex-home', home, ...extra], { stdio: 'pipe', windowsHide: true }), /unmanaged/);
    assert.equal(readFileSync(prompt, 'utf8'), 'my own command');
    assert.equal(existsSync(path.join(home, 'skills', 'autoresume', 'SKILL.md')), false);
  }
});

test('npm integration scripts preserve a custom home path containing spaces', { skip: !process.env.npm_execpath }, () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'car npm install test '));
  const run = (script: string) => execFileSync(process.execPath, [process.env.npm_execpath!, 'run', script, '--', '--codex-home', home], {
    encoding: 'utf8', windowsHide: true, timeout: 60_000,
  });
  run('install:codex');
  const skill = path.join(home, 'skills', 'autoresume', 'SKILL.md');
  assert.ok(existsSync(skill));
  run('uninstall:codex');
  assert.equal(existsSync(skill), false);
});
