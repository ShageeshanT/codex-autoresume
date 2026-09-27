export function shellQuote(value: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", "'\\''")}'`;
}
export function shellName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'PowerShell' : 'a POSIX shell (bash or zsh)';
}
