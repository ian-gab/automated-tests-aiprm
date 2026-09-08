import { chromium } from 'playwright';
// otplib v13 dropped the old `authenticator` namespace entirely — `generate()`
// is the current async, functional-API replacement.
import { generate as generateTotp } from 'otplib';
import * as dotenv from 'dotenv';
import path from 'path';

dotenv.config();

const EMAIL = process.env.GOOGLE_TEST_EMAIL ?? '';
const PASSWORD = process.env.GOOGLE_TEST_PASSWORD ?? '';
const TOTP_SECRET = process.env.GOOGLE_TOTP_SECRET ?? '';

const SHOT_DIR = path.resolve(__dirname, 'screenshots');

async function shot(page: any, name: string) {
  const file = path.join(SHOT_DIR, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`[screenshot] ${name} -> ${file}`);
}

async function main() {
  console.log(`Starting login attempt for ${EMAIL}`);

  // `executablePath: '/opt/pw-browsers/chromium'` was only valid inside
  // Claude's cloud sandbox container — pointless here since this whole
  // script only runs locally anyway (see README). `channel: 'chrome'` uses
  // your real installed Chrome instead of bundled Chromium.
  const browser = await chromium.launch({
    headless: false,
    channel: 'chrome',
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();

  try {
    await page.goto('https://accounts.google.com/signin/v2/identifier', {
      waitUntil: 'domcontentloaded',
    });
    await shot(page, '01-identifier-page');

    await page.fill("input[type='email']", EMAIL);
    await shot(page, '02-email-filled');
    await page.click('#identifierNext');

    await page.waitForTimeout(2000);
    await shot(page, '03-after-identifier-next');

    // Password step
    const passwordInput = page.locator("input[type='password']");
    await passwordInput.waitFor({ timeout: 20000, state: 'visible' }).catch(async () => {
      await shot(page, '03b-no-password-field');
      throw new Error('Password field never appeared — Google likely showed a challenge/CAPTCHA/blocked page instead.');
    });
    await passwordInput.fill(PASSWORD);
    await shot(page, '04-password-filled');
    await page.click('#passwordNext');

    await page.waitForTimeout(3000);
    await shot(page, '05-after-password-next');

    // TOTP step
    const totpInput = page.locator("input[type='tel'], input[name='totpPin']");
    const gotTotpField = await totpInput
      .waitFor({ timeout: 20000, state: 'visible' })
      .then(() => true)
      .catch(() => false);

    if (!gotTotpField) {
      await shot(page, '05b-no-totp-field');
      console.log('No TOTP field appeared. Current URL:', page.url());
      console.log('Page title:', await page.title());
    } else {
      const code = await generateTotp({ secret: TOTP_SECRET.toUpperCase() });
      console.log(`Generated TOTP code: ${code}`);
      await totpInput.fill(code);
      await shot(page, '06-totp-filled');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(4000);
      await shot(page, '07-after-totp-submit');
    }

    console.log('Final URL:', page.url());
    console.log('Final title:', await page.title());
    await shot(page, '08-final-state');
  } catch (err) {
    console.error('Login flow error:', (err as Error).message);
    await shot(page, '99-error-state').catch(() => {});
  } finally {
    await browser.close();
  }
}

main();
