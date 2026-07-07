import { describe, expect, it } from 'vitest';
import { quoteForShell } from '../src/shell.js';

describe('quoteForShell (Windows/POSIX arg safety)', () => {
  it('leaves shell-safe args untouched', () => {
    expect(quoteForShell('--shard=1/2', 'win32')).toBe('--shard=1/2');
    expect(quoteForShell('playwright', 'linux')).toBe('playwright');
  });

  it('quotes args with spaces so grep patterns survive shell: true', () => {
    expect(quoteForShell('my test name', 'win32')).toBe('"my test name"');
    expect(quoteForShell('my test name', 'linux')).toBe(`'my test name'`);
  });

  it('escapes embedded quotes', () => {
    expect(quoteForShell('say "hi"', 'win32')).toBe('"say \\"hi\\""');
    expect(quoteForShell(`it's here`, 'linux')).toBe(`'it'\\''s here'`);
  });
});
