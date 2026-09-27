import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const uninstall = process.argv.includes('--uninstall');
const args = process.argv.slice(2).filter(arg => arg !== '--uninstall');
if (args.length && (args.length !== 2 || args[0] !== '--codex-home')) throw new Error('Usage: node scripts/install-codex.mjs [--codex-home PATH]');
const codexHome = path.resolve(args[1] ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'));
const cli = path.join(root, 'dist', 'cli.js');
if (!uninstall && !existsSync(cli)) throw new Error('Run npm run build first.');
const skill = path.join(codexHome, 'skills', 'autoresume');
const marker = '<!-- Managed by codex-autoresume installer. -->';
const files = [
  ['autoresume/SKILL.md', path.join(skill, 'SKILL.md')],
  ['autoresume/agents/openai.yaml', path.join(skill, 'agents', 'openai.yaml')],
  ['autoresume.md', path.join(codexHome, 'prompts', 'autoresume.md')],
];
if (uninstall) {
  for (const [, destination] of files) {
    const stamp = destination.endsWith('.yaml') ? '# Managed by codex-autoresume installer.' : marker;
    if (existsSync(destination) && !readFileSync(destination, 'utf8').includes(stamp)) throw new Error(`Refusing to remove an unmanaged file: ${destination}`);
  }
  for (const [, destination] of files) {
    if (existsSync(destination)) { unlinkSync(destination); console.log(`Removed ${destination}`); }
  }
  console.log('AutoResume integration removed. Codex sessions and AutoResume state are preserved.');
  process.exit(0);
}
const { shellQuote } = await import('../dist/platform/shell.js');
const prepared = files.map(([source, destination]) => {
  let contents = readFileSync(path.join(root, 'integrations', 'codex', source), 'utf8')
    .replaceAll('__APP_CLI__', cli).replaceAll('__APP_COMMAND__', `node ${shellQuote(cli)}`)
    .replaceAll('__SHELL__', process.platform === 'win32' ? 'powershell' : 'sh')
    .replaceAll('__SKILL_PATH__', path.join(skill, 'SKILL.md'));
  const stamp = destination.endsWith('.yaml') ? '# Managed by codex-autoresume installer.' : marker;
  contents += '\n' + stamp + '\n';
  if (existsSync(destination) && !readFileSync(destination, 'utf8').includes(stamp)) throw new Error(`Refusing to overwrite an unmanaged file: ${destination}`);
  return { destination, contents };
});
for (const { destination, contents } of prepared) {
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, contents, { mode: 0o600 });
  console.log(`Installed ${destination}`);
}
console.log('Restart Codex CLI, then use /prompts:autoresume status or $autoresume status.');
