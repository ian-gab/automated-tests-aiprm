import { chromium, type Page, type BrowserContext } from 'playwright';
// otplib v13 dropped the old `authenticator` namespace entirely (it's a
// ground-up rewrite) — `generate()` is the current, async, functional-API
// replacement. See https://otplib.yeojz.dev for the migration notes.
import { generate as generateTotp } from 'otplib';
import * as dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

dotenv.config();

const EMAIL = process.env.GOOGLE_TEST_EMAIL ?? '';
const PASSWORD = process.env.GOOGLE_TEST_PASSWORD ?? '';
const TOTP_SECRET = process.env.GOOGLE_TOTP_SECRET ?? '';

// Path to the *unpacked* AIPRM extension folder (the manifest.json patched so
// chatgpt.com is a static host_permission instead of an optional one — see
// AIPRMforChatGPT-1.4.7.23-patched.zip). Chrome cannot silently install from
// the Web Store (that flow triggers a native, unscriptable confirmation
// dialog), so instead we load the extension straight from disk at browser
// launch, which requires zero dialogs.
const EXTENSION_PATH = process.env.AIPRM_EXTENSION_PATH ?? path.resolve(__dirname, 'extension');

// Persistent Chrome profile dir. Extensions only load in a *persistent*
// context in Playwright, and reusing the same profile dir across runs means
// the extension (and any accepted permissions) stick around like a real
// install would. Delete this folder if you want a genuinely from-scratch run.
const USER_DATA_DIR = process.env.CHROME_USER_DATA_DIR ?? path.resolve(__dirname, '.chrome-profile');

const SHOT_DIR = path.resolve(__dirname, 'screenshots');
if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });

async function shot(page: Page, name: string) {
  const file = path.join(SHOT_DIR, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`[screenshot] ${name} -> ${file}`);
}

/**
 * Click a button by its accessible name if it shows up within `timeout`, and
 * do nothing (no throw) if it never appears. Google's post-login speedbumps
 * (passkey enrollment offer, "add a recovery phone" nag, "set a home
 * address" nag) only appeared on the very first login against this test
 * account in manual testing — on repeat logins none of them showed up. This
 * makes each one an optional step instead of a hard requirement.
 */
async function dismissIfPresent(page: Page, name: string, timeout = 4000): Promise<boolean> {
  const btn = page.getByRole('button', { name });
  const visible = await btn
    .waitFor({ state: 'visible', timeout })
    .then(() => true)
    .catch(() => false);
  if (visible) {
    console.log(`[dismiss] "${name}" appeared — clicking it`);
    await btn.click();
    return true;
  }
  return false;
}

/**
 * Selectors below were captured live against accounts.google.com on
 * 2026-08-24 across three consecutive runs (fresh login, session-persisted
 * re-navigation, and post-Logout re-login). See selectors-notes.md for the
 * full walk-through per page/step.
 */
async function googleLogin(page: Page): Promise<void> {
  console.log(`Starting Google login for ${EMAIL}`);

  await page.goto('https://accounts.google.com/signin/v2/identifier', {
    waitUntil: 'domcontentloaded',
  });
  await shot(page, '01-identifier-page');

  // Case 1: browser profile already has a valid Google session — Google
  // redirects straight past the whole login form.
  if (page.url().includes('myaccount.google.com')) {
    console.log('Already signed into Google — skipping login.');
    return;
  }

  const emailField = page.getByRole('textbox', { name: 'Email or phone' });
  // Case 2: signed-out-but-known account — Google shows an account chooser
  // instead of a blank identifier field.
  const existingAccountLink = page.getByRole('link', { name: new RegExp(EMAIL, 'i') });

  const emailFieldVisible = await emailField
    .waitFor({ state: 'visible', timeout: 5000 })
    .then(() => true)
    .catch(() => false);

  if (emailFieldVisible) {
    await emailField.fill(EMAIL);
    await shot(page, '02-email-filled');
    await page.getByRole('button', { name: 'Next' }).click();
  } else {
    console.log('No blank identifier field — checking account chooser');
    await existingAccountLink.first().click();
  }
  await shot(page, '03-after-identifier-step');

  // Password step
  const passwordInput = page.getByRole('textbox', { name: 'Enter your password' });
  const gotPasswordField = await passwordInput
    .waitFor({ timeout: 20000, state: 'visible' })
    .then(() => true)
    .catch(() => false);

  if (!gotPasswordField) {
    await shot(page, '03b-no-password-field');
    throw new Error(
      'Password field never appeared — Google likely showed a challenge/CAPTCHA/blocked page instead.'
    );
  }

  await passwordInput.fill(PASSWORD);
  await shot(page, '04-password-filled');
  await page.getByRole('button', { name: 'Next' }).click();
  await page.waitForTimeout(3000);
  await shot(page, '05-after-password-next');

  // TOTP step — has not actually fired against this account/browser in
  // testing (Google treated the device as already trusted even across
  // sign-outs), but wired up in case that changes.
  const totpInput = page.locator("input[type='tel'], input[name='totpPin']");
  const gotTotpField = await totpInput
    .waitFor({ timeout: 8000, state: 'visible' })
    .then(() => true)
    .catch(() => false);

  if (gotTotpField) {
    if (!TOTP_SECRET) {
      throw new Error('Google is asking for a TOTP code but GOOGLE_TOTP_SECRET is not set.');
    }
    const code = await generateTotp({ secret: TOTP_SECRET.toUpperCase() });
    console.log(`Generated TOTP code: ${code}`);
    await totpInput.fill(code);
    await shot(page, '06-totp-filled');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(4000);
    await shot(page, '07-after-totp-submit');
  }

  // Optional one-time speedbumps, safe to skip if absent.
  await dismissIfPresent(page, 'Not now'); // passkey enrollment offer
  await dismissIfPresent(page, 'Cancel'); // "add a recovery phone" nag
  await dismissIfPresent(page, 'Skip'); // "set a home address" nag

  await page.waitForURL(/myaccount\.google\.com/, { timeout: 15000 }).catch(() => {});
  console.log('Final URL:', page.url());
  console.log('Final title:', await page.title());
  await shot(page, '08-login-final-state');

  if (!page.url().includes('myaccount.google.com')) {
    throw new Error(
      `Did not land on myaccount.google.com — got ${page.url()} instead. Login likely failed or hit an unhandled step.`
    );
  }
  console.log('Google login confirmed.');
}

/**
 * MV3 extensions run as a service worker. Playwright surfaces it on the
 * context once the extension has initialized, which can take a beat right
 * after launch — poll briefly rather than assuming it's there instantly.
 */
async function verifyExtensionLoaded(context: BrowserContext): Promise<string | null> {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const worker = context.serviceWorkers().find((w) => w.url().startsWith('chrome-extension://'));
    if (worker) {
      const extId = new URL(worker.url()).host;
      console.log(`AIPRM extension loaded, id=${extId}`);
      return extId;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  console.warn('Could not confirm the extension service worker started — continuing anyway.');
  return null;
}

async function goToChatGPT(page: Page): Promise<void> {
  console.log('Navigating to chatgpt.com');
  await page.goto('https://chatgpt.com', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  await shot(page, '09-chatgpt-loaded');
  console.log('Final URL:', page.url());
  console.log('Final title:', await page.title());

  // TODO once AIPRM's on-page UI is confirmed: assert its panel/button is
  // visible here, e.g.
  //   await page.getByRole('button', { name: /AIPRM/i }).waitFor({ state: 'visible' });
  // content_scripts in manifest.json currently only statically matches
  // chat.openai.com — if nothing from AIPRM shows up on chatgpt.com, that's
  // the first place to check (see selectors-notes.md).
}

/**
 * Logs into chatgpt.com itself via "Continue with Google" — separate from
 * googleLogin() above, which only authenticates the Google account in the
 * browser. Having a Google session doesn't sign you into ChatGPT; you still
 * have to click through ChatGPT's own login UI.
 *
 * Selectors captured live against chatgpt.com on 2026-08-24, logged out of
 * ChatGPT but still signed into the Google test account. Clicking "Continue
 * with Google" completed the whole OAuth round-trip (chatgpt.com ->
 * accounts.google.com -> back) same-tab and silently — no account picker or
 * consent screen — since the browser already had an authorized Google
 * session for this OAuth client. The conditional branches below exist for
 * the case that isn't true yet (first-ever authorization, multiple Google
 * accounts, etc.).
 */
async function chatgptLoginViaGoogle(page: Page): Promise<void> {
  // Same persisted-profile problem as googleLogin() below: once this has
  // succeeded once, .chrome-profile stays signed into ChatGPT on every
  // later run, so there's no "Log in" button to find at all — skip the
  // whole step rather than timing out looking for one.
  //
  // These two checks used to run sequentially (wait up to 15s for the
  // profile menu, THEN wait up to 15s for "Log in") — confirmed live
  // 2026-08-27 that this fails hard on an account with a big AIPRM prompt
  // library / long chat history: the page was genuinely already logged in
  // (error-context.md showed `button "Jian Klein Free, open profile menu"`
  // in the final DOM), it just took longer than 15s to render, so the first
  // wait gave up and the second wait then failed for the correct reason (no
  // "Log in" button exists when you're logged in) but with a misleading
  // error. Racing both locators together instead means whichever one
  // actually appears — however long that takes, up to the shared timeout —
  // resolves immediately.
  // .first(): ChatGPT currently renders TWO elements matching this role/name
  // simultaneously (confirmed live 2026-08-27) — a small icon-only sidebar
  // button labeled plain "Open profile menu" and the full
  // "<Name> Free, open profile menu" one, both visible at once. Without
  // .first(), Playwright's strict mode throws immediately ("resolved to 2
  // elements") instead of waiting — either match is an equally valid
  // "logged in" signal, so .first() is safe here.
  const profileMenuButton = page.getByRole('button', { name: /open profile menu/i }).first();
  const loginButton = page.getByRole('button', { name: 'Log in' }).first();

  const chatgptState = await Promise.race([
    profileMenuButton.waitFor({ state: 'visible', timeout: 30_000 }).then(() => 'logged-in' as const),
    loginButton.waitFor({ state: 'visible', timeout: 30_000 }).then(() => 'logged-out' as const),
  ]).catch(() => 'timeout' as const);

  if (chatgptState === 'timeout') {
    throw new Error('Neither the logged-in profile menu nor a "Log in" button appeared on chatgpt.com within 30s.');
  }

  if (chatgptState === 'logged-in') {
    console.log('Already logged into ChatGPT — skipping login.');
    return;
  }

  console.log('Logging into ChatGPT via Google');

  await loginButton.click();
  await shot(page, '10-chatgpt-login-dialog');

  // Returning profile: ChatGPT sometimes shows a "Welcome back — choose an
  // account" dialog with the Google account already tiled, instead of the
  // full "Log in or sign up" options with "Continue with Google". Handle
  // both — a fresh profile (first run against a new .chrome-profile) gets
  // the full dialog; a profile that's logged into ChatGPT before may get
  // the shortcut.
  const rememberedAccount = page.getByRole('button', { name: new RegExp(EMAIL, 'i') });
  const continueWithGoogle = page.getByRole('link', { name: 'Continue with Google' });

  const gotRemembered = await rememberedAccount
    .waitFor({ state: 'visible', timeout: 4000 })
    .then(() => true)
    .catch(() => false);

  if (gotRemembered) {
    await rememberedAccount.click();
  } else {
    await continueWithGoogle.waitFor({ state: 'visible', timeout: 10000 });
    await continueWithGoogle.click();
  }
  await shot(page, '11-chatgpt-google-oauth-clicked');

  // If Google needs an explicit account pick or consent click instead of
  // resolving silently, handle that too.
  await page.waitForTimeout(1500);
  if (page.url().includes('accounts.google.com')) {
    const googleAccountTile = page.getByText(EMAIL, { exact: false }).first();
    if (await googleAccountTile.isVisible().catch(() => false)) {
      await googleAccountTile.click();
    }
    const continueButton = page.getByRole('button', { name: /continue|allow/i }).first();
    if (await continueButton.isVisible().catch(() => false)) {
      await continueButton.click();
    }
  }

  await page.waitForURL(/chatgpt\.com/, { timeout: 20000 });
  await shot(page, '12-chatgpt-logged-in');

  // Confirm we actually landed authenticated, not just back on the logged-
  // out landing page — the profile-menu button's accessible name always
  // ends in "open profile menu" when signed in. .first() again — see the
  // comment on profileMenuButton above.
  await page
    .getByRole('button', { name: /open profile menu/i })
    .first()
    .waitFor({ state: 'visible', timeout: 30000 })
    .catch(() => {
      throw new Error(
        'Landed back on chatgpt.com but no logged-in profile menu appeared — ChatGPT login via Google likely failed.'
      );
    });

  console.log('Logged into ChatGPT via Google.');
}

/**
 * Verifies AIPRM's injected UI actually renders on chatgpt.com, and that the
 * "Your AIPRM Account" modal shows the expected account info. This step also
 * doubles as the live test of the content_scripts gap flagged in
 * goToChatGPT()'s TODO (manifest.json only statically matches
 * chat.openai.com) — if AIPRM never injects on chatgpt.com, this is where
 * that would first surface as a failure rather than the earlier steps.
 *
 * Every selector below was derived by reading AIPRM's own inject.js source
 * (v1.4.7.23) rather than from a live chatgpt.com inspection — this run is
 * what actually confirms them:
 *  - the four list tabs, the four selects/export-button, and the "AppName"
 *    link all have stable `id` attributes set directly in the source, so
 *    plain id selectors are used.
 *  - "Your AIPRM Account" is a plain <a> — `getByRole('link', { name: ... })`
 *    is used instead of the given xpath, since it survives DOM reshuffling
 *    that would break an absolute xpath.
 *  - the two account-info rows inside #AIPRM__accountModal have NO unique
 *    ids of their own — only their <dt> label text distinguishes them — so
 *    each row is located by that label text, then its <dd> value is read.
 *  - source note: AIPRM's own markup labels the second row "ChatGPT
 *    Account", not "OpenAI account" as originally requested — using the
 *    label that actually renders so the selector matches.
 */
async function verifyAIPRMUI(page: Page): Promise<void> {
  console.log('Verifying AIPRM UI elements on chatgpt.com');

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

  for (const [id, label] of idsToCheck) {
    const visible = await page
      .locator(`#${id}`)
      .waitFor({ state: 'visible', timeout: 20000 })
      .then(() => true)
      .catch(() => false);
    if (!visible) {
      throw new Error(
        `${label} (#${id}) is not visible on chatgpt.com — AIPRM's UI may not have injected on this page.`
      );
    }
    console.log(`  OK: ${label} (#${id})`);
  }
  await shot(page, '14-aiprm-elements-visible');

  const accountLink = page.getByRole('link', { name: 'Your AIPRM Account' });
  const accountLinkVisible = await accountLink
    .waitFor({ state: 'visible', timeout: 20000 })
    .then(() => true)
    .catch(() => false);
  if (!accountLinkVisible) {
    throw new Error('"Your AIPRM Account" link is not visible on chatgpt.com.');
  }
  await shot(page, '15-before-account-modal-click');

  console.log('Clicking "Your AIPRM Account"');
  await accountLink.click();

  // #AIPRM__accountModal itself is never a valid visibility target: it's a
  // plain block div whose only child is `position: fixed` (Tailwind's
  // AIPRM__fixed AIPRM__inset-0), which takes that child out of normal flow
  // — so the wrapper's own computed height is permanently 0px even while
  // the dialog is fully shown on screen (confirmed live 2026-08-27:
  // display:block, visibility:visible, opacity:1, height:0px). Check the
  // actual heading inside it instead — but keep `accountModal` for the
  // descendant .locator() calls below, which are plain DOM queries and
  // don't care about the ancestor's box size.
  const accountModal = page.locator('#AIPRM__accountModal');
  const modalVisible = await accountModal
    .getByRole('heading', { name: 'Your AIPRM Account', level: 2 })
    .waitFor({ state: 'visible', timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  if (!modalVisible) {
    throw new Error(
      'AIPRM account modal (#AIPRM__accountModal) did not open after clicking "Your AIPRM Account".'
    );
  }
  await shot(page, '16-account-modal-open');

  // No unique ids on these rows — find the row by its <dt> label text, then
  // read the value out of its <dd>.
  const aiprmAccountRow = accountModal
    .locator('dl > div')
    .filter({ has: page.getByText('AIPRM Account', { exact: true }) });
  const chatgptAccountRow = accountModal
    .locator('dl > div')
    .filter({ has: page.getByText('ChatGPT Account', { exact: true }) });

  const aiprmAccountValue = aiprmAccountRow.locator('dd div').first();
  const chatgptAccountValue = chatgptAccountRow.locator('dd div').first();

  const aiprmValueVisible = await aiprmAccountValue
    .waitFor({ state: 'visible', timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  if (!aiprmValueVisible) {
    throw new Error('AIPRM Account value is not visible in the account modal.');
  }
  const aiprmValueText = (await aiprmAccountValue.textContent())?.trim() ?? '';
  console.log(`AIPRM Account value: ${aiprmValueText}`);
  if (!aiprmValueText.includes(EMAIL)) {
    throw new Error(`AIPRM Account value ("${aiprmValueText}") does not contain "${EMAIL}".`);
  }

  const chatgptValueVisible = await chatgptAccountValue
    .waitFor({ state: 'visible', timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  if (!chatgptValueVisible) {
    throw new Error('ChatGPT Account value is not visible in the account modal.');
  }
  const chatgptValueText = (await chatgptAccountValue.textContent())?.trim() ?? '';
  console.log(`ChatGPT Account value: ${chatgptValueText}`);

  await shot(page, '17-account-modal-values');
  console.log('AIPRM UI verification complete.');
}

async function main(): Promise<void> {
  if (!fs.existsSync(EXTENSION_PATH)) {
    throw new Error(
      `Extension path not found: ${EXTENSION_PATH}. Set AIPRM_EXTENSION_PATH in .env or place the unpacked (patched) extension at ./extension`
    );
  }

  console.log(`Loading extension from ${EXTENSION_PATH}`);
  console.log(`Using Chromium profile dir ${USER_DATA_DIR}`);

  // Extensions require a persistent context. Chrome 137+ (branded Google
  // Chrome) removed --load-extension / --disable-extensions-except entirely
  // — the flags are silently ignored (confirmed 2026-08-24: real Chrome with
  // Developer mode on still showed zero extensions loaded). Playwright's own
  // docs now say to use the bundled `chromium` channel instead, since
  // Chromium/Chrome-for-Testing builds still honor the flags. See
  // https://playwright.dev/docs/chrome-extensions. Run `npx playwright
  // install chromium` once if you haven't already.
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

  try {
    await verifyExtensionLoaded(context);

    // AIPRM's own background script can pop its own onboarding/welcome tab
    // shortly after the extension finishes installing — give that a moment
    // to happen, then close everything except the original tab so a stray
    // extra tab can't grab focus or otherwise interfere with the rest of the
    // run.
    await new Promise((r) => setTimeout(r, 1500));
    const pages = context.pages();
    const page = pages[0] ?? (await context.newPage());
    for (const extraTab of pages.slice(1)) {
      console.log(`Closing extra tab opened alongside the extension install: ${extraTab.url()}`);
      await extraTab.close().catch(() => {});
    }

    // Order matters: sign into Google first, then open ChatGPT, then log
    // into ChatGPT itself via that Google session, then refresh so the page
    // (and AIPRM's injected UI) reflects the now-authenticated state.
    await googleLogin(page);
    await goToChatGPT(page);
    await chatgptLoginViaGoogle(page);

    console.log('Refreshing chatgpt.com tab');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    await shot(page, '13-chatgpt-after-refresh');

    await verifyAIPRMUI(page);

    console.log('Done.');
  } catch (err) {
    console.error('Flow error:', (err as Error).message);
    const page = context.pages()[0];
    if (page) await shot(page, '99-error-state').catch(() => {});
    throw err;
  } finally {
    await context.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
