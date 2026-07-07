/**
 * Quoting for spawnSync(..., { shell: true }): Node concatenates the args
 * WITHOUT quoting when a shell is used, so `--grep "my test"` would reach
 * cmd.exe / sh as two words. Args that are already shell-safe pass through
 * untouched (keeps `--shard=1/2` etc. readable in process listings).
 */
export function quoteForShell(arg: string, platform: NodeJS.Platform = process.platform): string {
  if (/^[A-Za-z0-9_\-./:=,@\\]+$/.test(arg)) return arg;
  if (platform === 'win32') {
    return `"${arg.replace(/"/g, '\\"')}"`;
  }
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}
