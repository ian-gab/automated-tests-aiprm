import { test as base, chromium, type BrowserContext } from '@playwright/test';
import path from 'path';
import fs from 'fs';

// Path to the *unpacked* AIPRM extension folder (manifest.json patched so
// chatgpt.com is a static host_permission, see AIPRMforChatGPT-1.4.7.23-patched.zip).
const EXTENSION_PATH = process.env.AIPRM_EXTENSION_PATH ?? path.resolve(__dirname, 'extension');

// Persistent Chrome profile dir, reused across runs like a real install.
// Delete this folder for a genuinely from-scratch browser/profile.
const USER_DATA_DIR = process.env.CHROME_USER_DATA_DIR ?? path.resolve(__dirname, '.chrome-profile');

/**
 * Extensions only load in a *persistent* browser context, which the default
 * Playwright Test `browser`/`context` fixtures don't support — this is the
 * pattern Playwright's own docs use for testing extensions: override
 * `context` to launch via `launchPersistentContext` with `--load-extension`,
 * and derive `page` from the context's already-open tab instead of the
 * default `context.newPage()`.
 */
export const test = base.extend<{
  context: BrowserContext;
  extensionId: string;
}>({
  context: async ({}, use) => {
    if (!fs.existsSync(EXTENSION_PATH)) {
      throw new Error(
        `Extension path not found: ${EXTENSION_PATH}. Set AIPRM_EXTENSION_PATH in .env or place the unpacked (patched) extension at ./extension`
      );
    }
    // fs.existsSync on the folder isn't enough — Chrome's --load-extension
    // fails *silently* (no error to Node/Playwright, just a banner in
    // chrome://extensions) if manifest.json isn't directly inside that
    // folder. Catching that here turns a mystery 90s timeout in the
    // extensionId fixture into an immediate, actionable error.
    const manifestPath = path.join(EXTENSION_PATH, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      throw new Error(
        `No manifest.json directly inside ${EXTENSION_PATH}. Chrome's --load-extension needs the manifest at the ` +
          `top level of this folder — if you unzipped the extension, check whether it created a nested ` +
          `subfolder (e.g. ${EXTENSION_PATH}\\AIPRMforChatGPT...\\manifest.json) and point AIPRM_EXTENSION_PATH ` +
          `at that inner folder instead.`
      );
    }

    console.log(`Launching Chromium with extension from ${EXTENSION_PATH}`);
    // Chrome 137+ (branded Google Chrome) removed --load-extension /
    // --disable-extensions-except entirely — the flags are just silently
    // ignored, no error, no banner, extension list stays empty (confirmed
    // 2026-08-24 against a real Chrome install: chrome://extensions showed
    // Developer mode on and zero extensions after a 20s wait). Playwright's
    // own docs now say to use the bundled `chromium` channel instead for
    // exactly this reason — Chromium/Chrome-for-Testing builds still honor
    // the flags. See https://playwright.dev/docs/chrome-extensions.
    const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
      headless: false,
      channel: 'chromium',
      viewport: { width: 1280, height: 900 },
      args: [
        '--disable-blink-features=AutomationControlled',
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
      ],
    });
    await use(context);
    await context.close();
  },

  page: async ({ context }, use) => {
    // launchPersistentContext opens one tab automatically — reuse it rather
    // than opening a second blank one. AIPRM's own background script can
    // additionally pop its own onboarding/welcome tab shortly after the
    // extension finishes installing; give that a moment to happen, then
    // close everything except the original tab so a stray extra tab can't
    // grab focus, get mistaken for a `waitForEvent('page')` result elsewhere
    // in the flow (e.g. the AIPRM connect-tab handling), or otherwise
    // interfere with the test.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const pages = context.pages();
    const page = pages[0] ?? (await context.newPage());
    for (const extraTab of pages.slice(1)) {
      console.log(`Closing extra tab opened alongside the extension install: ${extraTab.url()}`);
      await extraTab.close().catch(() => {});
    }
    await use(page);
  },

  extensionId: async ({ context }, use) => {
    let [background] = context.serviceWorkers();
    if (!background) {
      // Bounded wait with a clear message, instead of silently eating the
      // whole test timeout — if this fires, the extension folder loaded
      // (we got past the manifest.json check above) but Chrome never
      // started its service worker, which almost always means Chrome
      // rejected the extension for some other reason. Check
      // chrome://extensions in a manually-opened Chrome window pointed at
      // the same --user-data-dir for the actual error Chrome logged.
      background = await context
        .waitForEvent('serviceworker', { timeout: 20_000 })
        .catch(() => {
          throw new Error(
            "AIPRM's service worker never started within 20s. The extension folder has a manifest.json, but Chrome " +
              'may still be rejecting it for another reason (bad JSON, unsupported manifest key, wrong Chrome ' +
              'version). Open chrome://extensions in a normal Chrome window and check for an error banner on ' +
              'AIPRM for ChatGPT — that message will say exactly what Chrome didn\'t like.'
          );
        });
    }
    const extensionId = new URL(background.url()).host;
    console.log(`AIPRM extension loaded, id=${extensionId}`);
    await use(extensionId);
  },
});

export const expect = test.expect;
