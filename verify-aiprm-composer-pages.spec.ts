import { test, expect } from './fixtures';
import { shot, googleLogin, chatgptLoginViaGoogle } from './login-helpers';
import type { Page } from '@playwright/test';

// Add more pages here in the future — every page in this list gets the same
// full composer/sidebar check below.
const PAGES_TO_CHECK: string[] = [
  'https://chatgpt.com/images',
  'https://chatgpt.com/shopping',
  'https://chatgpt.com/scheduled',
];

type ElementCheck = { label: string; selector: string };

// Elements expected to be visible on these pages with no extra interaction —
// the AIPRM composer toolbar injected above the chat input.
const COMPOSER_ELEMENTS: ElementCheck[] = [
  { label: 'Language select', selector: '#languageSelect' },
  { label: 'Tone select', selector: '#toneSelect' },
  { label: 'Writing style select', selector: '#writingStyleSelect' },
  { label: 'AIPRM prompt composer search text', selector: '#prompt-textarea' },
  { label: 'Include text', selector: '#includeMyProfileInfoSelectWrapper > div > label:nth-child(1)' },
  {
    label: 'My profile info link',
    selector: '#includeMyProfileInfoSelectWrapper > div > label.AIPRM__font-medium > a',
  },
  { label: 'Profile info select', selector: '#includeMyProfileInfoSelect' },
];

// Substring rather than an exact match — the spec for this check gave the
// title with a trailing "..." (title="Press / to search AIPRM prompts ..."),
// meaning the real attribute has more text after "prompts" than what's
// pinned down here.
const PROMPT_TEXTAREA_TITLE_SUBSTRING = 'Press / to search AIPRM prompts';

const SIDEBAR_ICON_SELECTOR = '#AIPRM__sidebar-icon';
const PUBLIC_PROMPTS_TAB_SELECTOR = '#publicPromptsTab';

/**
 * Waits for `selector` to become visible (up to `timeout`) and logs a
 * PASS/FAIL line either way instead of throwing immediately — same pattern
 * as verify-aiprm-elements.spec.ts's element loop, duplicated here rather
 * than shared, matching this project's existing pattern of self-contained
 * spec files. Uses expect.soft() so one missing element doesn't stop the
 * rest of the page's checks (or the other pages') from running.
 */
async function checkVisible(page: Page, label: string, selector: string, timeout = 20_000): Promise<boolean> {
  const visible = await page
    .locator(selector)
    .first()
    .waitFor({ state: 'visible', timeout })
    .then(() => true)
    .catch(() => false);
  console.log(`${visible ? 'PASS' : 'FAIL'}: ${label} (${selector})`);
  expect.soft(visible, `${label} (${selector}) not visible`).toBe(true);
  return visible;
}

function slugForUrl(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '-');
}

test.describe('AIPRM prompt composer on secondary ChatGPT pages', () => {
  // Worst case (every element missing on every page) is 3 pages × up to ~9
  // 20s visibility checks each, plus login — 15 minutes gives real headroom
  // above that without being unbounded.
  test.setTimeout(15 * 60_000);

  test('AIPRM composer and sidebar appear on every page in PAGES_TO_CHECK', async ({ page, extensionId }) => {
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
    });

    await test.step('log into ChatGPT via Google', async () => {
      await chatgptLoginViaGoogle(page);
    });

    await test.step('dismiss AIPRM onboarding modal if present', async () => {
      // Only shows on a fresh extension load — skip entirely if absent.
      const closeButton = page.locator('#AIPRM__onboardingCloseButton');
      const shown = await closeButton
        .waitFor({ state: 'visible', timeout: 6000 })
        .then(() => true)
        .catch(() => false);
      if (shown) {
        await closeButton.click();
      } else {
        console.log('No onboarding modal this run — skipping.');
      }
    });

    for (const url of PAGES_TO_CHECK) {
      const slug = slugForUrl(url);

      await test.step(`${url}: open page`, async () => {
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(3000);
        await shot(page, `composer-${slug}-loaded`);
      });

      await test.step(`${url}: verify AIPRM composer elements are visible`, async () => {
        for (const { label, selector } of COMPOSER_ELEMENTS) {
          await checkVisible(page, label, selector);
        }

        // #prompt-textarea gets an extra check on top of plain visibility:
        // its title attribute is AIPRM's own hint text for the "/"
        // prompt-search shortcut.
        const promptTextarea = page.locator('#prompt-textarea').first();
        const title = await promptTextarea.getAttribute('title').catch(() => null);
        const titleOk = !!title && title.includes(PROMPT_TEXTAREA_TITLE_SUBSTRING);
        console.log(
          `${titleOk ? 'PASS' : 'FAIL'}: AIPRM prompt composer search text title (#prompt-textarea) — got: ${
            title ?? '(none)'
          }`
        );
        expect
          .soft(
            titleOk,
            `#prompt-textarea title did not contain "${PROMPT_TEXTAREA_TITLE_SUBSTRING}" — got: ${title ?? '(none)'}`
          )
          .toBe(true);

        await shot(page, `composer-${slug}-elements`);
      });

      await test.step(`${url}: open AIPRM sidebar and verify public prompts tab`, async () => {
        const sidebarIconVisible = await checkVisible(page, 'AIPRM sidebar icon', SIDEBAR_ICON_SELECTOR);
        if (sidebarIconVisible) {
          await page.locator(SIDEBAR_ICON_SELECTOR).first().click();
        }
        await checkVisible(page, 'Public prompts tab in AIPRM sidebar', PUBLIC_PROMPTS_TAB_SELECTOR);
        await shot(page, `composer-${slug}-sidebar`);
      });
    }
  });
});
