# Google login flow — selectors observed (3 live runs on winmax2, Aug 24 2026)

Base credentials come from `.env` in the uploaded `googlelogintest.zip`:
`GOOGLE_TEST_EMAIL`, `GOOGLE_TEST_PASSWORD`, `GOOGLE_TOTP_SECRET`.

## 1. Identifier page
URL: `https://accounts.google.com/signin/v2/identifier` (redirects to `.../v3/signin/identifier?flowName=GlifWebSignIn&flowEntry=ServiceLogin...`)

- Email field: `page.getByRole('textbox', { name: 'Email or phone' })`
- Next button: `page.getByRole('button', { name: 'Next' })`
- (Also present: `button "Forgot email?"`, `button "Create account"`)

## 2. Password challenge
URL pattern: `https://accounts.google.com/v3/signin/challenge/pwd?...`
Heading is "Welcome" or "Hi <FirstName>" depending on entry path.

- Password field: `page.getByRole('textbox', { name: 'Enter your password' })`
- Next button: `page.getByRole('button', { name: 'Next' })`
- Show password checkbox: `page.getByRole('checkbox', { name: 'Show password' })`
- Alt-method button: `page.getByRole('button', { name: 'Try another way' })`

## 3. TOTP step (defined in original run-login.ts, NOT triggered in any of the 3 live runs)
- Field guess: `input[type='tel'], input[name='totpPin']`
- Generate code: `otplib`'s `authenticator.generate(TOTP_SECRET)`
- Submit via Enter key press after fill
- NOTE: this account/browser pairing never actually hit this step live — Google treated
  the winmax2 browser as a trusted device even after explicit sign-out via
  `accounts.google.com/Logout`. If the script needs to exercise this path for real,
  a fresh incognito context / cleared cookies for `google.com` is likely required, not
  just a logout.

## 4. Passkey enrollment speedbump (appeared on first run only)
URL: `https://accounts.google.com/v3/signin/speedbump/passkeyenrollment?...`
Heading: "Sign in faster"

- Skip: `page.getByRole('button', { name: 'Not now' })`
- Accept: `page.getByRole('button', { name: 'Continue' })`

## 5. Recovery options nag (appeared on first run only)
URL: `https://gds.google.com/web/recoveryoptions?...`
Heading: "Make sure you can always sign in"

- Skip: `page.getByRole('button', { name: 'Cancel' })`
- Accept/save: `page.getByRole('button', { name: 'Save' })`
- Fields present: "Enter phone" textbox, calling-code combobox, "Enter recovery email" textbox

## 6. Home address nag (appeared on first run only)
URL: `https://gds.google.com/web/homeaddress?...`
Heading: "Set a home address"

- Skip: `page.getByRole('button', { name: 'Skip' })`
- Save button is disabled until a value is entered.

## 7. Sign-out / re-run path
- Logout URL: `https://accounts.google.com/Logout` — signs out the current browser-profile
  session (does NOT clear the "trusted device" signal that suppresses TOTP/2FA).
- After logout, navigating to the identifier URL lands on the account chooser instead:
  URL: `https://accounts.google.com/v3/signin/accountchooser?flowName=GlifWebSignIn...`
  - Existing account entry: `page.getByRole('link', { name: '<Name> <email> Signed out' })`
    — clicking it skips straight to the password challenge (step 2), no email re-entry.
  - `page.getByRole('link', { name: 'Use another account' })` — goes to a fresh identifier
    field if a truly new account is wanted.
  - `page.getByRole('link', { name: 'Remove an account' })`

## 8. Success state
Final URL: `https://myaccount.google.com/...` (title "Google Account").
Confirm via visible profile heading `Jian Klein` / `ian.klein41x@gmail.com`, or
`page.getByRole('heading')`/account avatar in top-right.

## Run-to-run notes
- Run 1 (fresh browser context, first ever login): identifier → password → passkey
  speedbump → recovery-options nag → home-address nag → myaccount.google.com.
- Run 2 (same profile, `browser_close` only — did NOT log out): navigating straight to
  myaccount.google.com without hitting the form at all (session cookie persisted).
- Run 2b (after explicit Logout): account chooser → password only → myaccount.google.com
  (no nags, no passkey prompt — those are apparently one-time/dismissed-state, not
  re-shown per session).
- Run 3 (repeat of the Logout path): identical to run 2b.
- Conclusion: the reliable script flow is Logout → account-chooser click → password →
  Next → verify `myaccount.google.com`. Nags/passkey speedbump should be coded as
  optional/conditional steps since they only appeared once.

## 9. AIPRM extension — live-confirmed selectors on chatgpt.com (winmax2, Aug 24 2026)

Extension loaded manually via `chrome://extensions` → Developer mode already on →
"Load unpacked" → `C:\Users\Ian\Documents\AIPRM\AIPRM_AUTO` (extension ID
`ojnbohmppadfgpejeebfnmnknjdlckgj`). Loading it opened two new tabs automatically:
a `chatgpt.com` tab and an `aiprm.com/success/install-chatgpt-...` "Installation
Success" landing page — worth knowing about since a real test run driven this way
will need to handle/close that extra tab too, not just the ChatGPT one.

- **Onboarding modal close (X) button**: `#AIPRM__onboardingCloseButton`
  — confirmed live via `page.locator('#AIPRM__onboardingCloseButton').click()` on the
  chatgpt.com tab right after the extension loaded. This modal appears once per fresh
  extension load (first-run onboarding), not on every page load — later runs against
  the same profile likely won't show it, so this should be treated as an optional/
  conditional step (`waitFor` with a short timeout, skip if absent) the same way the
  Google login speedbumps are handled.
  - **Required behavior when the script/spec is written**: do NOT hard-require this
    modal/button. If `#AIPRM__onboardingCloseButton` isn't visible within a short
    timeout (no onboarding popup this run), just continue — don't throw/fail the test.
    Same pattern as `dismissIfPresent()` for the Google speedbumps in
    `run-login-install-chatgpt.ts` / `login-and-chatgpt.spec.ts`.

## 10. AIPRM account modal + Disconnect flow — live-confirmed (winmax2, Aug 24 2026)

Sequence: clicked "Your AIPRM Account" (confirmed `page.getByRole('link', { name: 'Your AIPRM Account' })`
matches live, no unique id on the link itself) → modal opened → clicked "Disconnect" → handled the
resulting native `confirm()` dialog → account actually disconnected for real (this was done on
`ian.klein41x@gmail.com`, the shared test account — see note at the bottom).

- **Account modal container**: `#AIPRM__accountModal` per source (`inject.js`) — the earlier
  `#AIPRM__onboardingCloseButton` click already confirmed this extension's `AIPRM__`-prefixed id
  convention is real/live, so high confidence here too, but this exact id wasn't re-verified via
  `document.querySelector` in this run before the tab navigated away — worth a quick
  `page.locator('#AIPRM__accountModal')` sanity check next time the modal's open.
- **AIPRM Account row** (confirmed live via accessibility snapshot):
  - `<dt>AIPRM Account</dt>` — matches source.
  - `<dd>` contains: the email as plain text (`ian.klein41x@gmail.com`), a
    `page.getByRole('link', { name: 'View Account' })`, and a
    `page.getByRole('button', { name: 'Disconnect' })` — all three confirmed live/clickable.
- **ChatGPT Account row** (confirmed live): `<dt>ChatGPT Account</dt>` — matches source exactly,
  NOT "OpenAI account". Confirms the label discrepancy flagged earlier in this project.
- **Disconnect confirmation**: clicking "Disconnect" fires a native browser `confirm()` dialog
  ("Are you sure you want to disconnect your AIPRM account?") — this is NOT a DOM element/selector,
  it's outside the page entirely. In a real Playwright script/spec this needs a
  `page.on('dialog', d => d.accept())` (or `.dismiss()`) listener registered *before* the click,
  since Playwright auto-dismisses unhandled dialogs by default, which would silently no-op the
  disconnect and leave the test stuck waiting.
- **Post-confirm redirect**: accepting the dialog navigates the *same tab* (not a new one) away
  from chatgpt.com to `https://app.aiprm.com/disconnect-success?type=chatgpt&success=<id>&lang=en`
  — a toast "Disconnecting your AIPRM account, please wait..." shows briefly first.
  - **Timing/wait guidance (per Ian)**: don't treat the click itself as the finish line — give the
    extension time to actually complete the disconnect. The redirect to
    `app.aiprm.com/disconnect-success` is the confirmation signal that the disconnect went through
    (`page.waitForURL(/app\.aiprm\.com\/disconnect-success/)` rather than a fixed sleep). Once on
    that page, don't click/interact with anything there — it's aiprm.com's own success page, not
    part of the extension — just wait for it to redirect back to chatgpt.com on its own
    (`page.waitForURL(/chatgpt\.com/)` afterward, no manual `page.goto` needed in between). This run
    I navigated back manually with `page.goto('https://chatgpt.com')` instead of waiting for an
    auto-redirect, so the auto-redirect-back behavior itself is Ian's guidance, not yet independently
    confirmed live — worth watching for on the next run through this flow.
- **Post-disconnect state on chatgpt.com** (confirmed live after navigating back): the
  "Your AIPRM Account" link is gone — replaced by a plain `page.getByRole('link', { name: 'Login' })`,
  matching the source's `IsLinked ? ... : Login/Connect` branch.

**Heads up**: this test actually disconnected the shared AIPRM test account
(`ian.klein41x@gmail.com`) from the extension for real — it's no longer linked. It'll need to be
reconnected (via that "Login" link, presumably another Google-style OAuth round trip through
aiprm.com) before any test that assumes a connected AIPRM account will pass again.

## 11. "Just one more step" reconnect nudge — live-confirmed (winmax2, Aug 24 2026)

After landing back on chatgpt.com post-disconnect, a dialog popped up nudging reconnection:

- Dialog: `page.getByRole('dialog')` containing heading `page.getByRole('heading', { name: 'Just one more step', level: 3 })`
  and body text "Login with your Google Account to benefit from many more features. It's not hard,
  we pinky swear."
- Buttons: `page.getByRole('button', { name: 'Cancel' })` and
  `page.getByRole('button', { name: 'Continue' })` — both plain buttons, no unique ids seen.
- Clicked **Continue** — confirmed live. Effect: opens a **new tab** (not same-tab navigation) at
  `https://app.aiprm.com/signup?redirect=%2Fapi%2Fext-connect` — this is the reconnect/login entry
  point (presumably the same kind of Google OAuth round trip used elsewhere in this project). A test
  driving this flow needs to watch for/handle that new tab rather than expecting the current page to
  navigate.
- Not yet done: actually completing the reconnect flow on that signup/ext-connect tab (Google login
  → link back to AIPRM) — next step if we want the shared test account connected again.

## 12. Reconnect flow on the signup/ext-connect tab — live-confirmed (winmax2, Aug 24 2026)

On the new tab from section 11 (`https://app.aiprm.com/signup?redirect=%2Fapi%2Fext-connect`,
page title "Signup - AIPRM for ChatGPT"), page has two numbered sections: "1. Accept Terms" and
"2. Connect Google Account".

- **Terms checkbox**: real `id` is dynamically generated per page load (this run:
  `id="ccs-0.0ybqqqmhyqh"`, `name="acceptTermsConditions"`) — **don't hardcode the id**, it won't be
  stable run-to-run. Use `page.getByRole('checkbox', { name: 'I have read and agree to the terms of
  use and privacy policy' })` instead, matched live.
  - **Gotcha**: this is a Carbon Design System checkbox — the real `<input type="checkbox">` is
    visually covered by a sibling `<label>`, so clicking the checkbox locator directly times out
    ("`<label>` intercepts pointer events"). Click the **label** instead (or use
    `checkbox.check({ force: true })` if you specifically want to interact with the input). Role-based
    `page.getByRole('checkbox', { name: '...' })` resolves to the same input either way — the click
    target is what matters, so route the actual `.click()` through the label /
    `page.getByText('I have read and agree to the')` / the checkbox's accessible-name click (Playwright's
    role locator + `.click()` should also just work if it clicks via label association — worth
    confirming — but a direct `label[for="<id>"]` click is what succeeded live this run).
- **Connect button starts disabled**: `page.getByRole('link', { name: 'Connect with Google account' })`
  — before the checkbox is checked it renders as a `button [disabled]`; after checking it becomes an
  actual `<a>` link (`getByRole('link', ...)` matches it, not `getByRole('button', ...)`), pointing to
  `/api/auth/google?redirect=%2Fapi%2Fext-connect&acceptTermsConditions=yes`. So: check the checkbox
  first, THEN look for the role to flip from button→link before clicking, or just poll for the
  accessible name to become enabled/visible as a link.
- **Alt path present but not used**: `page.getByRole('link', { name: 'I have no Google account' })` →
  `/register?redirect=%2Fapi%2Fext-connect#signup-email`.
- **Result of clicking "Connect with Google account"**: resolved silently — no account picker or
  consent screen shown (same as the ChatGPT-login-via-Google flow elsewhere in this project; the
  browser already had an authorized Google session for this OAuth client). The signup/ext-connect tab
  closed itself afterward, leaving focus on whatever tab was next in the tab strip (the
  aiprm.com "Installation Success" tab, in this run — that's just tab-order incidental, not a
  redirect target).
- **Confirmed end state**: reloading the chatgpt.com tab afterward shows "Your AIPRM Account" again
  (and "Hello, Jian Klein" greeting) — the shared test account (`ian.klein41x@gmail.com`) is
  reconnected. The earlier "Heads up" note about it being disconnected no longer applies.

## 13. Post-reconnect "new account" terms popup — live-confirmed (winmax2, Aug 24 2026)

Right after reconnecting (section 12), a second, different terms popup appeared on the chatgpt.com
tab — distinct from the checkbox on the signup page (section 12) and from the "Just one more step"
nudge (section 11). Per Ian: **this one only appears for new/first-time-linked accounts** — treat it
as optional/conditional (same `waitFor`-short-timeout-then-skip-if-absent pattern as the onboarding
modal in section 9 and the Google speedbumps), not a required step.

- Dialog body text: "...To continue, please read and agree to our Terms of Use and Privacy Policy.
  Then you must connect your Google Account to continue." with links
  `page.getByRole('link', { name: 'Terms of Use' })` and `page.getByRole('link', { name: 'Privacy Policy.' })`.
- Checkbox: `page.getByRole('checkbox', { name: 'I have read and agree to these terms & conditions' })`
  — unlike the section 12 checkbox, this one clicked directly with no label-intercept issue.
- Confirm button: `page.getByRole('button', { name: 'Confirm' })`.
- Both clicked live, popup dismissed cleanly, no further action required.

## 14. Post-reconnect account verification — live-confirmed (winmax2, Aug 24 2026)

After dismissing the section 13 popup, clicked `page.getByRole('link', { name: 'Your AIPRM Account' })`
again and re-checked the modal:

- **ChatGPT Account** row (`<dt>ChatGPT Account</dt>` → `<dd>`) value: `ian.klein41x@gmail.com` —
  confirmed still correct after the full disconnect → reconnect round trip. Matches the value
  expected in the original request (the field the user called "OpenAI account" — see section 10's
  label-discrepancy note, still applies).
- AIPRM Account row's "Disconnect" button (`page.getByRole('button', { name: 'Disconnect' })`) is
  present again too, confirming the row is back in its "connected" state (View Account + Disconnect,
  not the disconnected Login/Connect state).
