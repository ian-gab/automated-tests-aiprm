import { chromium, type Page, type BrowserContext } from 'playwright';
import { generate as generateTotp } from 'otplib';
import * as dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

dotenv.config();

const EMAIL = process.env.GOOGLE_TEST_EMAIL ?? '';
const PASSWORD = process.env.GOOGLE_TEST_PASSWORD ?? '';
const TOTP_SECRET = process.env.GOOGLE_TOTP_SECRET ?? '';

const EXTENSION_PATH = process.env.AIPRM_EXTENSION_PATH ?? path.resolve(__dirname, 'extension');
const USER_DATA_DIR = process.env.CHROME_USER_DATA_DIR ?? path.resolve(__dirname, '.chrome-profile');

const SHOT_DIR = path.resolve(__dirname, 'screenshots');
if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });

async function shot(page: Page, name: string) {
  const file = path.join(SHOT_DIR, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`[screenshot] ${name} -> ${file}`);
}

/** Same helper as run-login-install-chatgpt.ts — duplicated here rather than
 * shared, matching this project's existing pattern of self-contained
 * script/spec pairs. */
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

async function googleLogin(page: Page): Promise<void> {
  console.log(`Starting Google login for ${EMAIL}`);

  await page.goto('https://accounts.google.com/signin/v2/identifier', {
    waitUntil: 'domcontentloaded',
  });
  await shot(page, '01-identifier-page');

  if (page.url().includes('myaccount.google.com')) {
    console.log('Already signed into Google — skipping login.');
    return;
  }

  const emailField = page.getByRole('textbox', { name: 'Email or phone' });
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

  await dismissIfPresent(page, 'Not now');
  await dismissIfPresent(page, 'Cancel');
  await dismissIfPresent(page, 'Skip');

  await page.waitForURL(/myaccount\.google\.com/, { timeout: 15000 }).catch(() => {});
  await shot(page, '08-login-final-state');

  if (!page.url().includes('myaccount.google.com')) {
    throw new Error(
      `Did not land on myaccount.google.com — got ${page.url()} instead. Login likely failed or hit an unhandled step.`
    );
  }
  console.log('Google login confirmed.');
}

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

async function chatgptLoginViaGoogle(page: Page): Promise<void> {
  // These two checks race rather than run sequentially — confirmed live
  // 2026-08-27 that a fixed 15s wait for the profile menu, THEN a separate
  // 15s wait for "Log in", fails hard on an account with a big AIPRM prompt
  // library / long chat history: the page was genuinely already logged in,
  // it just took longer than 15s to render, so the first wait gave up and
  // the second wait then failed for the correct reason (no "Log in" button
  // when logged in) but with a misleading error. Whichever locator actually
  // appears — however long that takes, up to the shared timeout — resolves
  // immediately this way.
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

  // .first() again — see the comment on profileMenuButton above.
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

async function dismissOnboardingIfPresent(page: Page): Promise<void> {
  const closeButton = page.locator('#AIPRM__onboardingCloseButton');
  const shown = await closeButton
    .waitFor({ state: 'visible', timeout: 6000 })
    .then(() => true)
    .catch(() => false);
  if (shown) {
    console.log('AIPRM onboarding modal appeared — closing it');
    await closeButton.click();
  } else {
    console.log('No onboarding modal this run — skipping.');
  }
}

/**
 * AIPRM's connect/reconnect modal (`connect-modal.js`, id="connectModal")
 * shows a primary button id="connectModalConnect" whose *visible text* is
 * randomized per AIPRM's server-side `ConnectVariants` config ("Continue",
 * "Confirm", etc — confirmed two different variants live on 2026-08-24: a
 * "Just one more step" / "Continue" reconnect nudge, and a "please agree to
 * our terms" / "Confirm" new-account variant). Match this one by id, never
 * by its button text.
 */
async function acceptConnectModalIfPresent(page: Page, timeout = 8000): Promise<boolean> {
  const connectButton = page.locator('#connectModalConnect');
  const shown = await connectButton
    .waitFor({ state: 'visible', timeout })
    .then(() => true)
    .catch(() => false);
  if (!shown) return false;

  const checkbox = page.getByRole('checkbox', { name: /I have read and agree/i });
  if (await checkbox.isVisible().catch(() => false)) {
    await checkbox.check({ force: true }).catch(() => checkbox.click());
  }

  console.log('Connect modal (#connectModal) appeared — accepting it');
  await connectButton.click();
  return true;
}

/**
 * Connects (or reconnects) the AIPRM account via its "Login" link. Handles
 * both code paths AIPRM's own source can take from that link
 * (`AIPRM.oauth2Login()` vs `AIPRM.connectAccount()` — which one fires
 * depends on server-side config we don't control) by watching for whichever
 * actually happens: an in-page connect modal, and/or a new browser tab for
 * the account-linking page.
 */
type ConnectOutcome = { kind: 'tab'; tab: Page } | { kind: 'silent' } | { kind: 'none' };

/**
 * Waits for whichever of the two valid "connect succeeded" signals happens
 * first — a real new tab (`newTabPromise`), or the account simply
 * reconnecting in place with no tab at all — and only reports failure once
 * BOTH have failed to show up within `timeout`. A plain `Promise.race`
 * would risk resolving to the wrong (failing) side if that branch happens
 * to settle a moment before the other branch's real success.
 */
function raceForConnectOutcome(
  newTabPromise: Promise<Page>,
  page: Page,
  timeout: number
): Promise<ConnectOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    let failures = 0;
    const finish = (outcome: ConnectOutcome) => {
      if (!settled) {
        settled = true;
        resolve(outcome);
      }
    };
    const noteFailure = () => {
      failures += 1;
      if (failures >= 2) finish({ kind: 'none' });
    };

    newTabPromise.then((tab) => finish({ kind: 'tab', tab })).catch(noteFailure);
    page
      .getByRole('link', { name: 'Your AIPRM Account' })
      .waitFor({ state: 'visible', timeout })
      .then(() => finish({ kind: 'silent' }))
      .catch(noteFailure);
  });
}

// How long to wait for a connect/reconnect to actually finish — either via
// the legacy full-tab flow or the silent one below. Bumped from 25s per
// Ian's observation 2026-08-27: the account genuinely does reconnect, the
// background OAuth2 token exchange itself finishes in ~1-2s, but a fresh
// frame snapshot taken right at a 25s timeout showed #connectModal still
// showing its "Connecting your ChatGPT account to AIPRM, please wait..."
// spinner — the same modal AIPRM swaps in place after accepting it, rather
// than closing right away. Whatever AIPRM is doing server-side after the
// token exchange (verifying/linking the account) can apparently take much
// longer than the exchange itself, mirroring the multi-minute delay already
// seen on disconnect.
const CONNECT_FLOW_TIMEOUT = 3 * 60000;

async function connectAIPRMAccount(page: Page, context: BrowserContext): Promise<void> {
  console.log('Connecting AIPRM account');

  // Register the new-tab listener before ANY click below — the OLD connect
  // flow (a brand-new account that has never linked on this browser/
  // profile) still opens a real app.aiprm.com tab with a "Connect with
  // Google account" checkbox.
  const newTabPromise = context.waitForEvent('page', { timeout: CONNECT_FLOW_TIMEOUT });

  // AIPRM can auto-pop this SAME #connectModal reconnect nudge on page
  // load — before we ever click anything — once it detects a disconnected
  // account. Confirmed live 2026-08-27: its full-screen overlay
  // (AIPRM__fixed AIPRM__inset-0) intercepts pointer events, so a "Login"
  // click attempted while it's already up just retries forever with no
  // timeout of its own, eventually blowing the whole run's budget. Handle
  // an already-open modal FIRST, before ever attempting to click "Login".
  const modalAlreadyOpen = await acceptConnectModalIfPresent(page, 3000);
  await shot(page, '19-connect-modal-precheck');

  if (!modalAlreadyOpen) {
    const loginLink = page.getByRole('link', { name: 'Login' }).first();
    const loginVisible = await loginLink
      .waitFor({ state: 'visible', timeout: 15000 })
      .then(() => true)
      .catch(() => false);
    if (!loginVisible) {
      throw new Error('"Login" link not visible — cannot start the connect flow.');
    }

    await loginLink.click();
    await shot(page, '20-clicked-login');

    // In case clicking "Login" itself triggered the modal (the
    // oauth2Login() code path) rather than opening the tab directly (the
    // connectAccount() code path).
    await acceptConnectModalIfPresent(page);
    await shot(page, '21-after-connect-modal');
  }

  // As of 2026-08-27, AIPRM has rolled out (confirmed live in console logs:
  // "[AIPRM OAuth2 rollout] rolloutName: LinkingKnownOperator /
  // ConnectRequiredKnownOperator, rolloutPercent: 100") a SILENT, tab-less
  // OAuth2 reconnect for any account that has linked on this browser/
  // profile before: accepting #connectModal (or clicking "Login") now fires
  // `AIPRM.oauth2Login()`, which runs through the extension's background
  // script via `chrome.identity.launchWebAuthFlow()` and, with an already-
  // trusted Google/AIPRM session, exchanges its token in about a second with
  // NO new tab ever opening. Only a genuinely brand-new account still gets
  // the old full-tab flow. So a new tab is no longer a reliable success
  // signal on its own; treat the account link reappearing as an equally
  // valid one — see CONNECT_FLOW_TIMEOUT above for why this window is a few
  // minutes rather than seconds.
  const outcome = await raceForConnectOutcome(newTabPromise, page, CONNECT_FLOW_TIMEOUT);

  if (outcome.kind === 'none') {
    throw new Error(
      'Clicking "Login" (or accepting the reconnect modal) neither opened the AIPRM account-connect tab nor ' +
        `reconnected the account silently within ${CONNECT_FLOW_TIMEOUT / 1000}s.`
    );
  }

  if (outcome.kind === 'tab') {
    const connectTab = outcome.tab;
    await connectTab.waitForLoadState('domcontentloaded');
    console.log(`AIPRM connect tab opened: ${connectTab.url()}`);

    // Terms checkbox — id is randomly generated per page load (confirmed
    // live: e.g. id="ccs-0.0ybqqqmhyqh"), so match by accessible name, not
    // id. Carbon Design System checkbox: the real <input> is visually
    // covered by its <label>, so a plain .click() times out ("<label>
    // intercepts pointer events"); use { force: true } instead.
    const termsCheckbox = connectTab.getByRole('checkbox', {
      name: /I have read and agree to the terms of use and privacy policy/i,
    });
    const hasTerms = await termsCheckbox
      .waitFor({ state: 'visible', timeout: 8000 })
      .then(() => true)
      .catch(() => false);
    if (hasTerms) {
      await termsCheckbox.check({ force: true });
    }

    // "Connect with Google account" starts as a disabled button and only
    // becomes an enabled <a> link once the checkbox above is checked.
    const connectLink = connectTab.getByRole('link', { name: 'Connect with Google account' });
    const connectButton = connectTab.getByRole('button', { name: 'Connect with Google account' });
    const gotLink = await connectLink
      .waitFor({ state: 'visible', timeout: 8000 })
      .then(() => true)
      .catch(() => false);
    if (gotLink) {
      await connectLink.click();
    } else {
      const gotButton = await connectButton
        .waitFor({ state: 'visible', timeout: 5000 })
        .then(() => true)
        .catch(() => false);
      if (!gotButton) {
        throw new Error('Neither the "Connect with Google account" link nor button appeared on the connect tab.');
      }
      await connectButton.click();
    }

    await connectTab.waitForEvent('close', { timeout: 30000 }).catch(() => {
      console.warn('AIPRM connect tab did not close on its own within 30s — continuing anyway.');
    });

    await page.bringToFront();
    await acceptConnectModalIfPresent(page);
    await shot(page, '22-after-reconnect');
  } else {
    console.log('AIPRM account reconnected silently (known-operator OAuth2 flow) — no connect tab opened.');

    // #connectModal updates its own content in place (button -> "please
    // wait" spinner -> presumably a final state) rather than being removed
    // outright, and its full-screen overlay would block a later click on
    // "Your AIPRM Account" even though that link already reports itself as
    // visible underneath it. Make sure it's actually gone (accepting a
    // trailing confirmation if one appears) before moving on.
    await acceptConnectModalIfPresent(page, 5000);
    await page
      .locator('#connectModal')
      .waitFor({ state: 'hidden', timeout: 15000 })
      .catch(() => {
        console.warn('#connectModal did not disappear after the silent reconnect — continuing anyway.');
      });
  }

  const reconnected = await page
    .getByRole('link', { name: 'Your AIPRM Account' })
    .waitFor({ state: 'visible', timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  if (!reconnected) {
    throw new Error(
      'AIPRM account still not connected after the connect flow — "Your AIPRM Account" link never appeared.'
    );
  }

  console.log('AIPRM account connected.');
}

/**
 * Disconnects the AIPRM account via the "Your AIPRM Account" modal, reading
 * the ChatGPT Account email out of the modal first. Returns that email.
 */
async function disconnectAIPRMAccount(page: Page): Promise<string | null> {
  console.log('Disconnecting AIPRM account');

  const accountLink = page.getByRole('link', { name: 'Your AIPRM Account' });
  const accountLinkVisible = await accountLink
    .waitFor({ state: 'visible', timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  if (!accountLinkVisible) {
    throw new Error('"Your AIPRM Account" link not visible on chatgpt.com.');
  }
  await accountLink.click();

  // #AIPRM__accountModal itself is never a valid visibility target: it's a
  // plain block div whose only child is `position: fixed` (Tailwind's
  // AIPRM__fixed AIPRM__inset-0), which takes that child out of normal flow
  // — so the wrapper's own computed height is permanently 0px even while
  // the dialog is fully shown on screen (confirmed live 2026-08-27:
  // display:block, visibility:visible, opacity:1, height:0px). Playwright's
  // visibility check correctly reports a zero-area element as hidden, so
  // check the actual heading inside it instead. `accountModal` stays valid
  // as a scope for the descendant .locator() calls below — those are plain
  // DOM queries and don't care about the ancestor's box size.
  const accountModal = page.locator('#AIPRM__accountModal');
  const modalVisible = await accountModal
    .getByRole('heading', { name: 'Your AIPRM Account', level: 2 })
    .waitFor({ state: 'visible', timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  if (!modalVisible) {
    throw new Error('AIPRM account modal did not open.');
  }

  const chatgptAccountValue = accountModal
    .locator('dl > div')
    .filter({ has: page.getByText('ChatGPT Account', { exact: true }) })
    .locator('dd div')
    .first();
  const chatgptEmail = (await chatgptAccountValue.textContent().catch(() => null))?.trim() ?? null;
  console.log(`ChatGPT Account value before disconnect: ${chatgptEmail ?? '(not found)'}`);
  await shot(page, '23-account-modal-before-disconnect');

  // Register the native confirm() handler BEFORE clicking Disconnect —
  // Playwright auto-dismisses unhandled dialogs by default, which would
  // silently no-op the disconnect and hang the script.
  page.once('dialog', (dialog) => {
    console.log(`Dialog: "${dialog.message()}" — accepting`);
    dialog.accept().catch(() => {});
  });

  await page.getByRole('button', { name: 'Disconnect' }).click();

  // Confirmation signal that the disconnect actually went through — the
  // redirect to disconnect-success, not a fixed sleep. Per Ian: this
  // redirect can legitimately take a few minutes on AIPRM's side after
  // accepting the native "Disconnect" confirm dialog above, so this timeout
  // is deliberately much longer than the other redirects in this flow.
  await page.waitForURL(/app\.aiprm\.com\/disconnect-success/, { timeout: 5 * 60000 });
  console.log('Landed on disconnect-success — waiting for it to redirect back to chatgpt.com on its own');
  await shot(page, '24-disconnect-success');

  // Per Ian: don't interact with this page — just wait for it to redirect
  // back to chatgpt.com by itself. Fall back to a manual navigation only if
  // that doesn't happen within a generous window.
  await page.waitForURL(/chatgpt\.com/, { timeout: 60000 }).catch(async () => {
    console.warn('No automatic redirect back to chatgpt.com within 60s — navigating there manually.');
    await page.goto('https://chatgpt.com', { waitUntil: 'domcontentloaded' });
  });

  const loginShown = await page
    .getByRole('link', { name: 'Login' })
    .waitFor({ state: 'visible', timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  if (!loginShown) {
    throw new Error('Still shows "Your AIPRM Account" after disconnecting — disconnect may not have taken effect.');
  }
  await shot(page, '25-after-disconnect');

  console.log('AIPRM account disconnected.');
  return chatgptEmail;
}

async function main(): Promise<void> {
  if (!fs.existsSync(EXTENSION_PATH)) {
    throw new Error(
      `Extension path not found: ${EXTENSION_PATH}. Set AIPRM_EXTENSION_PATH in .env or place the unpacked (patched) extension at ./extension`
    );
  }

  console.log(`Loading extension from ${EXTENSION_PATH}`);
  console.log(`Using Chromium profile dir ${USER_DATA_DIR}`);

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
    // extra tab can't grab focus, get mistaken for a `waitForEvent('page')`
    // result later (e.g. the AIPRM connect-tab handling), or otherwise
    // interfere with the rest of the run.
    await new Promise((r) => setTimeout(r, 1500));
    const pages = context.pages();
    const page = pages[0] ?? (await context.newPage());
    for (const extraTab of pages.slice(1)) {
      console.log(`Closing extra tab opened alongside the extension install: ${extraTab.url()}`);
      await extraTab.close().catch(() => {});
    }

    await googleLogin(page);

    console.log('Navigating to chatgpt.com');
    await page.goto('https://chatgpt.com', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    await shot(page, '09-chatgpt-loaded');

    await chatgptLoginViaGoogle(page);
    await dismissOnboardingIfPresent(page);

    // "Your AIPRM Account" means connected; "Login" means it isn't. If the
    // account is already disconnected going in, connect it first so the
    // disconnect step below has something real to disconnect.
    const alreadyConnected = await page
      .getByRole('link', { name: 'Your AIPRM Account' })
      .isVisible()
      .catch(() => false);

    if (alreadyConnected) {
      console.log('AIPRM account already connected.');
    } else {
      console.log('AIPRM account not connected ("Login" shown) — connecting before running the test.');
      await connectAIPRMAccount(page, context);
    }

    await disconnectAIPRMAccount(page);
    await connectAIPRMAccount(page, context);

    console.log('Verifying account info after reconnect');
    await page.getByRole('link', { name: 'Your AIPRM Account' }).click();
    // See the comment on the same check in disconnectAIPRMAccount() above —
    // #AIPRM__accountModal's own box is always zero-height, so check the
    // heading inside it instead.
    const accountModal = page.locator('#AIPRM__accountModal');
    await accountModal
      .getByRole('heading', { name: 'Your AIPRM Account', level: 2 })
      .waitFor({ state: 'visible', timeout: 10000 });

    const aiprmAccountValue = accountModal
      .locator('dl > div')
      .filter({ has: page.getByText('AIPRM Account', { exact: true }) })
      .locator('dd div')
      .first();
    const chatgptAccountValue = accountModal
      .locator('dl > div')
      .filter({ has: page.getByText('ChatGPT Account', { exact: true }) })
      .locator('dd div')
      .first();

    const aiprmText = (await aiprmAccountValue.textContent())?.trim() ?? '';
    const chatgptText = (await chatgptAccountValue.textContent())?.trim() ?? '';
    console.log(`AIPRM Account value after reconnect: ${aiprmText}`);
    console.log(`ChatGPT Account value after reconnect: ${chatgptText}`);

    if (!aiprmText.includes(EMAIL)) {
      throw new Error(`AIPRM Account value ("${aiprmText}") does not contain "${EMAIL}" after reconnecting.`);
    }
    if (!chatgptText.includes(EMAIL)) {
      throw new Error(`ChatGPT Account value ("${chatgptText}") does not contain "${EMAIL}" after reconnecting.`);
    }

    await shot(page, '26-final-account-info');
    console.log('Done — AIPRM account disconnected and reconnected successfully.');
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
