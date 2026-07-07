#!/usr/bin/env node
// Stable bin entrypoint, committed to git so it exists when pnpm links
// workspace bins at install time. Pointing `bin` straight at dist/index.js
// breaks fresh checkouts: `pnpm install` runs before `pnpm build`, pnpm
// silently skips linking a bin whose target file is missing, and a later
// `npx sentinel` falls back to the unrelated `sentinel` package on the npm
// registry.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const entry = new URL('../dist/index.js', import.meta.url);
if (!existsSync(fileURLToPath(entry))) {
  console.error('sentinel: dist/index.js not found — build @sentinel/cli first (pnpm build).');
  process.exit(1);
}
await import(entry.href);
