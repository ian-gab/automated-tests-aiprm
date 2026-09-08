import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  timeout: 90_000,
  // Every spec file drives the same single persistent Chrome profile (see
  // fixtures.ts) — Chrome refuses a second instance against the same
  // user-data-dir, so keep this at 1 rather than letting workers race.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    trace: 'retain-on-failure',
  },
  // Explicit run order via project `dependencies`, rather than relying on
  // alphabetical file-name ordering (which is Playwright's default and is
  // what silently put aiprm-connect-disconnect.spec.ts first — its name
  // just happens to sort earliest). Per Ian, 2026-08-27: connect/disconnect
  // should run LAST, after the plain login test and the AIPRM element/
  // account check, since it's the most disruptive test (it actually
  // disconnects the account) and shouldn't affect what the other two verify
  // first. Playwright runs a project's tests only after every project it
  // depends on has finished, so this chain guarantees
  // login-and-chatgpt -> verify-aiprm-elements -> verify-aiprm-composer-pages
  // -> aiprm-connect-disconnect regardless of file naming.
  projects: [
    {
      name: 'login-and-chatgpt',
      testMatch: 'login-and-chatgpt.spec.ts',
    },
    {
      name: 'verify-aiprm-elements',
      testMatch: 'verify-aiprm-elements.spec.ts',
      dependencies: ['login-and-chatgpt'],
    },
    {
      name: 'verify-aiprm-composer-pages',
      testMatch: 'verify-aiprm-composer-pages.spec.ts',
      dependencies: ['verify-aiprm-elements'],
    },
    {
      name: 'aiprm-connect-disconnect',
      testMatch: 'aiprm-connect-disconnect.spec.ts',
      dependencies: ['verify-aiprm-composer-pages'],
    },
  ],
});
