import { test, expect } from './fixtures';
import { shot, googleLogin, chatgptLoginViaGoogle, EMAIL } from './login-helpers';

// Runs after login-and-chatgpt.spec.ts (alphabetically later, and this
// project runs with workers: 1 / fullyParallel: false, so spec files run
// strictly in that order) — both files share the same persistent Chrome
// profile (see fixtures.ts), so by the time this test's own login steps run
// they're almost always no-ops confirming the session login-and-chatgpt.spec.ts
// already established, rather than logging in from scratch.
test.describe('AIPRM UI elements and account info', () => {
  test.setTimeout(120_000);

  test('verifies AIPRM UI elements are visible and account info is correct on chatgpt.com', async ({
    page,
    extensionId,
  }) => {
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

    // This step is also the live test of a content_scripts gap: manifest.json
    // only statically matches chat.openai.com, not chatgpt.com — every
    // selector here was derived by reading AIPRM's own inject.js source, not
    // from a live chatgpt.com inspection, so this run is what actually
    // confirms them.
    await test.step('verify AIPRM UI elements are visible', async () => {
      const idsToCheck: Array<[string, string]> = [
        ['favoritePromptsTab', 'Favorites tab'],
        ['AIPRMVerifiedPromptsTab', 'AIPRM verified prompts tab'],
        ['publicPromptsTab', 'Public prompts tab'],
        ['ownPromptsTab', 'Own prompts tab'],
        ['languageSelect', 'Language select'],
        ['toneSelect', 'Tone select'],
        ['writingStyleSelect', 'Writing style select'],
        ['includeMyProfileInfoSelect', 'Profile info select'],
        ['export-button', 'Export button'],
        ['AppName', 'AIPRM link'],
      ];

      // Check every element and log a PASS/FAIL line for each one rather
      // than stopping at the first miss — expect.soft() records a failure
      // without throwing, so the loop still visits (and logs) every
      // remaining id, and the test/step still ends up failing overall if
      // anything didn't show up.
      for (const [id, label] of idsToCheck) {
        const visible = await page
          .locator(`#${id}`)
          .waitFor({ state: 'visible', timeout: 20_000 })
          .then(() => true)
          .catch(() => false);
        console.log(`${visible ? 'PASS' : 'FAIL'}: ${label} (#${id})`);
        expect.soft(visible, `${label} (#${id}) not visible on chatgpt.com`).toBe(true);
      }
      await shot(page, '14-aiprm-elements-visible');
    });

    await test.step('open "Your AIPRM Account" modal and verify account info', async () => {
      // AIPRM's own markup: a plain <a onclick="AIPRM.showAccountModal()">
      // inside #templates-wrapper — role-based locator used instead of the
      // given xpath, since it survives DOM reshuffling that would break an
      // absolute xpath.
      const accountLink = page.getByRole('link', { name: 'Your AIPRM Account' });
      await expect(accountLink, '"Your AIPRM Account" link not visible on chatgpt.com').toBeVisible({
        timeout: 20_000,
      });
      await shot(page, '15-before-account-modal-click');

      await accountLink.click();

      // #AIPRM__accountModal itself is never a valid visibility target: it's
      // a plain block div whose only child is `position: fixed` (Tailwind's
      // AIPRM__fixed AIPRM__inset-0), which takes that child out of normal
      // flow — so the wrapper's own computed height is permanently 0px even
      // while the dialog is fully shown on screen (confirmed live
      // 2026-08-27: display:block, visibility:visible, opacity:1,
      // height:0px). Check the actual heading inside it instead — but keep
      // `accountModal` for the descendant .locator() calls below, which are
      // plain DOM queries and don't care about the ancestor's box size.
      const accountModal = page.locator('#AIPRM__accountModal');
      await expect(
        accountModal.getByRole('heading', { name: 'Your AIPRM Account', level: 2 }),
        'AIPRM account modal (#AIPRM__accountModal) did not open after clicking "Your AIPRM Account"'
      ).toBeVisible({ timeout: 10_000 });
      await shot(page, '16-account-modal-open');

      // Neither row in the modal's account-info <dl> has a unique id — only
      // the <dt> label text distinguishes them, so each row is located by
      // that text and its <dd> value read from within it.
      //
      // Note: AIPRM's own source labels the second row "ChatGPT Account",
      // not "OpenAI account" as originally requested — using the label that
      // actually renders so the selector matches.
      const aiprmAccountRow = accountModal
        .locator('dl > div')
        .filter({ has: page.getByText('AIPRM Account', { exact: true }) });
      const chatgptAccountRow = accountModal
        .locator('dl > div')
        .filter({ has: page.getByText('ChatGPT Account', { exact: true }) });

      const aiprmAccountValue = aiprmAccountRow.locator('dd div').first();
      const chatgptAccountValue = chatgptAccountRow.locator('dd div').first();

      await expect(aiprmAccountValue, 'AIPRM Account value not visible in modal').toBeVisible({ timeout: 10_000 });
      await expect(
        aiprmAccountValue,
        `AIPRM Account value did not contain "${EMAIL}"`
      ).toContainText(EMAIL, { timeout: 10_000 });

      await expect(chatgptAccountValue, 'ChatGPT Account value not visible in modal').toBeVisible({
        timeout: 10_000,
      });
      console.log(`ChatGPT Account value in modal: ${await chatgptAccountValue.textContent()}`);

      await shot(page, '17-account-modal-values');
    });
  });
});
