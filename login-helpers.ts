import { expect, type Page } from '@playwright/test';
import { generate as generateTotp } from 'otplib';
import * as dotenv from 'dotenv';
import path from 'path';

dotenv.config();

export const EMAIL = process.env.GOOGLE_TEST_EMAIL ?? '';
export const PASSWORD = process.env.GOOGLE_TEST_PASSWORD ?? '';
export const TOTP_SECRET = process.env.GOOGLE_TOTP_SECRET ?? '';

// Shared by every spec file that imports this module — screenshots from
// login-and-chatgpt.spec.ts and verify-aiprm-elements.spec.ts land in the
// same ./screenshots directory regardless of which file took them.
const SHOT_DIR = path.resolve(__dirname, 'screenshots');

export async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) });
}

/**
 * Click a button by its accessible name if it shows up within `timeout`, and
 * do nothing if it never appears. Google's post-login speedbumps (passkey
 * enrollment offer, "add a recovery phone" nag, "set a home address" nag)
 * only appeared on the very first login against this test account — on
 * repeat logins none of them showed up. Optional, not required, per run.
 */
export async function dismissIfPresent(page: Page, name: string, timeout = 4000): Promise<boolean> {
  const btn = page.getByRole('button', { name });
  const visible = await btn
    .waitFor({ state: 'visible', timeout })
    .then(() => true)
    .catch(() => false);
  if (visible) {
    await btn.click();
    return true;
  }
  return false;
}

/**
 * Signs the persistent Chrome profile into GOOGLE_TEST_EMAIL on
 * accounts.google.com. A no-op if the profile already has a valid Google
 * session. Shared by login-and-chatgpt.spec.ts and
 * verify-aiprm-elements.spec.ts — both need a signed-in Google session
 * before they can drive chatgpt.com.
 */
export async function googleLogin(page: Page): Promise<void> {
  await page.goto('https://accounts.google.com/signin/v2/identifier', {
    waitUntil: 'domcontentloaded',
  });
  await shot(page, '01-identifier-page');

  // Case 1: profile already has a valid Google session.
  if (page.url().includes('myaccount.google.com')) {
    console.log('Already signed into Google — skipping login.');
    return;
  }

  const emailField = page.getByRole('textbox', { name: 'Email or phone' });
  // Case 2: signed-out-but-known account shows an account chooser instead of
  // a blank identifier field.
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
    await existingAccountLink.first().click();
  }
  await shot(page, '03-after-identifier-step');

  const passwordInput = page.getByRole('textbox', { name: 'Enter your password' });
  await expect(
    passwordInput,
    'Password field never appeared — Google likely showed a challenge/CAPTCHA/blocked page instead.'
  ).toBeVisible({ timeout: 20_000 });

  await passwordInput.fill(PASSWORD);
  await shot(page, '04-password-filled');
  await page.getByRole('button', { name: 'Next' }).click();
  await page.waitForTimeout(3000);
  await shot(page, '05-after-password-next');

  // TOTP step — has not actually fired against this account/browser in
  // testing, but wired up in case that changes.
  const totpInput = page.locator("input[type='tel'], input[name='totpPin']");
  const gotTotpField = await totpInput
    .waitFor({ timeout: 8000, state: 'visible' })
    .then(() => true)
    .catch(() => false);

  if (gotTotpField) {
    expect(TOTP_SECRET, 'Google is asking for a TOTP code but GOOGLE_TOTP_SECRET is not set.').toBeTruthy();
    const code = await generateTotp({ secret: TOTP_SECRET.toUpperCase() });
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

  await shot(page, '08-login-final-state');
  await expect(page).toHaveURL(/myaccount\.google\.com/, { timeout: 15_000 });
}

/**
 * Logs chatgpt.com itself into the already Google-authenticated browser via
 * "Continue with Google" — separate from googleLogin() above, which only
 * authenticates the Google account in the browser; having a Google session
 * doesn't sign you into ChatGPT on its own. A no-op if the page is already
 * logged into ChatGPT. Selectors captured live against chatgpt.com on
 * 2026-08-24: clicking "Continue with Google" completed the whole OAuth
 * round-trip (chatgpt.com -> accounts.google.com -> back) same-tab and
 * silently, since the browser already had an authorized Google session for
 * this OAuth client. The conditional branches below cover the case that
 * isn't true yet (first-ever authorization, multiple Google accounts, a
 * returning profile showing a "Welcome back" account-picker shortcut instead
 * of the full dialog).
 */
export async function chatgptLoginViaGoogle(page: Page): Promise<void> {
  // Same persisted-profile problem as googleLogin() above: once this has
  // succeeded once, .chrome-profile stays signed into ChatGPT on every later
  // run, so there's no "Log in" button to find at all — skip the whole step
  // rather than timing out looking for one.
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

  await loginButton.click();
  await shot(page, '10-chatgpt-login-dialog');

  const rememberedAccount = page.getByRole('button', { name: new RegExp(EMAIL, 'i') });
  const continueWithGoogle = page.getByRole('link', { name: 'Continue with Google' });

  const gotRemembered = await rememberedAccount
    .waitFor({ state: 'visible', timeout: 4000 })
    .then(() => true)
    .catch(() => false);

  if (gotRemembered) {
    await rememberedAccount.click();
  } else {
    await expect(continueWithGoogle).toBeVisible({ timeout: 10_000 });
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

  await expect(page).toHaveURL(/chatgpt\.com/, { timeout: 20_000 });
  await shot(page, '12-chatgpt-logged-in');

  // The profile-menu button's accessible name always ends in "open profile
  // menu" when actually signed in — confirms we're not just back on the
  // logged-out landing page. .first() again — see the comment on
  // profileMenuButton above.
  await expect(
    page.getByRole('button', { name: /open profile menu/i }).first(),
    'Landed back on chatgpt.com but no logged-in profile menu appeared — ChatGPT login via Google likely failed.'
  ).toBeVisible({ timeout: 30_000 });
}
