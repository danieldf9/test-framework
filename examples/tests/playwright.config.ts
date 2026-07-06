import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './specs',
  timeout: 90_000,
  // fullyParallel lets --shard split individual tests across CI shards;
  // workers stays 1 so local runs remain strictly ordered.
  fullyParallel: true,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    headless: true,
  },
  webServer: {
    command: 'node ../demo-app/server.mjs',
    url: 'http://127.0.0.1:4173/__chaos',
    reuseExistingServer: true,
    timeout: 20_000,
  },
});
