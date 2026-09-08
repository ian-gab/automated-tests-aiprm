import { test, expect } from './fixtures';
import { shot, googleLogin, chatgptLoginViaGoogle } from './login-helpers';

test.describe('Google login → AIPRM extension → ChatGPT', () => {
  test.setTimeout(120_000);

  test('logs into Google, loads AIPRM, then logs into ChatGPT via Google', async ({ page, extensionId }) => {
    await test.step('confirm AIPRM extension loaded', async () => {
      console.log(`AIPRM extension loaded, id=${extensionId}`);
      expect(extensionId).toMatch(/^[a-z]{32}$/);
    });

    await test.step('Google login', async () => {
      await googleLogin(page);
    });

    await test.step('open chatgpt.com', async () => {
      await page.goto('https://chatgpt.com', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);
      await shot(page, '09-chatgpt-loaded');
    });

    await test.step('log into ChatGPT via Google', async () => {
      await chatgptLoginViaGoogle(page);
    });

    await test.step('refresh chatgpt.com tab', async () => {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);
      await shot(page, '13-chatgpt-after-refresh');
    });

    // AIPRM UI element verification and the "Your AIPRM Account" modal check
    // now live in verify-aiprm-elements.spec.ts, which runs after this file
    // (alphabetically later, and the two spec files share the same
    // persistent Chrome profile, so it picks up right where this test left
    // off — see login-helpers.ts for the shared googleLogin/
    // chatgptLoginViaGoogle steps both files reuse).
  });
});
