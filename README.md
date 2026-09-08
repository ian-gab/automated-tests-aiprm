## Run locally

```
npm install
npx tsx run-login.ts
```

Requires a locally installed Google Chrome (the script launches via
`channel: 'chrome'`). Credentials are read from `.env` in this folder.

## Login + install AIPRM extension + open ChatGPT (`run-login-install-chatgpt.ts`)

```
npm install
npx tsx run-login-install-chatgpt.ts
```

This one does five things in order:

1. Logs into the test Google account (same flow/selectors as `run-login.ts`,
   see `selectors-notes.md` for the full page-by-page breakdown).
2. Loads the AIPRM extension straight from disk via Chrome's
   `--load-extension` launch flag — **not** through the Chrome Web Store.
   The Web Store's "Add to Chrome" button triggers a native, OS-level
   confirmation dialog that sits outside the page DOM and cannot be
   automated (Chrome does this on purpose so a webpage can't silently
   install extensions on visitors). Loading unpacked at launch sidesteps
   the dialog entirely, since Chrome auto-grants everything an unpacked
   extension declares in `host_permissions`.
3. Navigates to `https://chatgpt.com`.
4. Logs into ChatGPT itself via "Continue with Google" — having a Google
   session in the browser doesn't sign you into ChatGPT, its own login UI
   still has to be clicked through. Handles both a fresh profile (full "Log
   in or sign up" dialog) and a returning one (a "Welcome back" shortcut
   with the account already tiled), plus a fallback for Google needing an
   explicit account pick/consent click instead of resolving silently.
5. Refreshes the chatgpt.com tab once logged in, then verifies AIPRM's UI
   actually rendered: the four list tabs (`#favoritePromptsTab`,
   `#AIPRMVerifiedPromptsTab`, `#publicPromptsTab`, `#ownPromptsTab`), the
   four form controls (`#languageSelect`, `#toneSelect`,
   `#writingStyleSelect`, `#includeMyProfileInfoSelect`), `#export-button`
   and the `#AppName` link are all visible; then clicks "Your AIPRM Account"
   and checks the resulting `#AIPRM__accountModal` shows the AIPRM account
   email (`ian.klein41x@gmail.com`) and a ChatGPT account value. All
   selectors were derived from AIPRM's own `inject.js` source rather than
   from a live chatgpt.com inspection, so this step doubles as the
   confirmation of the "Known gap" below — see that section.

### Setup

- Unzip the **patched** extension (`AIPRMforChatGPT-1.4.7.23-patched.zip` —
  `chatgpt.com` moved from `optional_host_permissions` to `host_permissions`
  so the runtime permission dialog doesn't fire either) into `./extension`
  in this folder, or point `AIPRM_EXTENSION_PATH` in `.env` at wherever you
  keep it.
- Because extensions require a persistent browser context, this script
  reuses a Chrome profile directory (`./.chrome-profile` by default,
  override with `CHROME_USER_DATA_DIR`) across runs — delete that folder for
  a genuinely from-scratch browser/profile.
- Add to `.env` if you're overriding the defaults:
  ```
  AIPRM_EXTENSION_PATH=C:\path\to\extension
  CHROME_USER_DATA_DIR=C:\path\to\profile-dir
  ```

### Known gap

`manifest.json`'s `content_scripts` block still only statically matches
`chat.openai.com`, not `chatgpt.com` — AIPRM appears to inject into the
newer domain dynamically via the `scripting` permission at runtime rather
than a static content script. The now-granted `chatgpt.com` host permission
should be enough for that dynamic injection to work. Step 5 above
(`verifyAIPRMUI` in the script, the "verify AIPRM UI elements" /
"open ... modal" steps in the spec) is the actual live test of this — all of
its selectors came from reading AIPRM's `inject.js` source, not from
inspecting a live chatgpt.com page, so a real run against your machine is
what confirms (or disproves) that the dynamic injection works. If that step
fails with "AIPRM's UI may not have injected on this page", that's the gap
showing up for real, and the fix would be adding `https://chatgpt.com/*` (or
just `chatgpt.com`) to the static `matches` array in `content_scripts`.

One label heads-up: the modal's second account row is rendered as
"**ChatGPT Account**" in AIPRM's source, not "OpenAI account" — the tests
check for that literal label.

## Same flow as an @playwright/test spec (`login-and-chatgpt.spec.ts`)

`run-login-install-chatgpt.ts` is a standalone script (`npx tsx ...`) — it
doesn't use the `@playwright/test` framework, so `npx playwright test` finds
nothing to run against it ("no tests found" is expected there). This repo
also has an equivalent `@playwright/test` version, for `npx playwright test`,
`npm test`, and VS Code's Testing sidebar / Playwright extension:

```
npm install
npx playwright test          # headed, one test, HTML report on failure
npm run test:report          # open the last HTML report
```

Same setup as above (`./extension` folder, `.env` vars) applies. A few
things are different from the plain script because extensions need a
**persistent** browser context, which the default `@playwright/test`
`browser`/`page` fixtures don't provide:

- `fixtures.ts` defines a custom `test`/`expect` (Playwright's own documented
  pattern for testing extensions) that overrides the `context` fixture to
  call `chromium.launchPersistentContext()` with the `--load-extension`
  flags directly, and derives `page` from the context's already-open tab.
  `login-and-chatgpt.spec.ts` imports `test`/`expect` from `./fixtures`,
  not from `@playwright/test` directly.
- `playwright.config.ts` pins `workers: 1` — this test drives one Chrome
  profile directory, and Chrome refuses a second instance against the same
  `--user-data-dir`, so parallel workers would collide.
- The login flow itself (selectors, optional speedbumps, TOTP handling) is
  the same logic as `run-login-install-chatgpt.ts`, just wrapped in
  `test.step()` blocks and `expect()` assertions instead of manual
  `if/throw` checks, so failures show up per-step in the HTML report/trace.

## AIPRM account connect/disconnect test (`run-aiprm-connect-disconnect.ts` / `aiprm-connect-disconnect.spec.ts`)

```
npm install
npx tsx run-aiprm-connect-disconnect.ts   # plain script
# or
npx playwright test aiprm-connect-disconnect.spec.ts   # @playwright/test version
```

Exercises AIPRM's own account link (separate from the Google/ChatGPT logins above — this is the
"Your AIPRM Account" / "Login" toggle inside AIPRM's panel). Full flow:

1. Same setup as the other two flows: Google login → open chatgpt.com → log into ChatGPT via
   Google → dismiss the AIPRM onboarding modal if present.
2. **Checks whether the AIPRM account is already connected** — "Your AIPRM Account" visible means
   yes, "Login" visible means no. If it's not connected yet, connects it first (see step 4) before
   doing anything else, so the disconnect step always has something real to disconnect.
3. Disconnects the AIPRM account (clicks "Your AIPRM Account" → reads the ChatGPT Account email out
   of the modal → clicks "Disconnect" → accepts the native browser confirm dialog → waits for the
   redirect to `app.aiprm.com/disconnect-success` as the actual confirmation signal, not a fixed
   sleep, then waits for it to redirect back to chatgpt.com on its own → confirms "Login" is now
   shown).
4. Reconnects the AIPRM account (clicks "Login" → handles whichever of AIPRM's two connect code
   paths fires — an in-page `#connectModal` and/or a new browser tab — accepts the terms checkbox
   and clicks "Connect with Google account" on that tab → waits for the tab to close → handles a
   second, new-account-only terms-confirmation popup if it shows up → confirms "Your AIPRM Account"
   is visible again).
5. Verifies both account rows in the modal (AIPRM Account and ChatGPT Account) contain
   `GOOGLE_TEST_EMAIL` after reconnecting.

Selector/behavior notes worth knowing if this breaks:
- The reconnect modal's button text ("Continue" vs "Confirm") is **randomized per AIPRM's
  server-side config** — it's matched by id (`#connectModalConnect`) here, never by visible text.
- The terms checkbox on the `app.aiprm.com` connect tab has a **dynamically generated id** per page
  load — matched by accessible name instead. It's also a Carbon Design System checkbox where the
  real `<input>` is covered by its `<label>`, so it's checked with `{ force: true }` rather than a
  plain click.
- "Disconnect" fires a native `confirm()` dialog, which needs a `page.on('dialog', ...)` handler
  registered *before* the click — Playwright auto-dismisses unhandled dialogs by default.
- See `selectors-notes.md` sections 9–14 for the full live-testing trail this was built from.

**Heads up**: this test disconnects and reconnects the real shared AIPRM test account
(`ian.klein41x@gmail.com`) each time it runs — that's the point of the test, but worth knowing if
you're running it against a shared environment.

## Why this didn't run from the cloud sandbox

Claude's cloud workspace routes all outbound traffic through an egress
proxy allowlisted to package registries and Anthropic's own services
(npm, PyPI, GitHub, api.anthropic.com, etc.). `accounts.google.com` isn't
on that allowlist, so the browser got `ERR_TUNNEL_CONNECTION_FAILED` /
`403` at the proxy before ever reaching Google — this is a sandbox network
restriction, not Google blocking the request. Running the same script from
your own machine (or CI runner) with normal internet access should reach
the real sign-in flow.
