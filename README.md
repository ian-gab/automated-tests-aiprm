# AIPRM Playwright Tests

## Install

```
npm install
npx playwright install chromium
```

Unzip the patched AIPRM extension into `./extension`, and copy `.env.example` to `.env` with the test Google account credentials.

## Run

```
npx playwright test
```

## List of tests

`login-and-chatgpt.spec.ts` - this logs a test Google account into Google, loads the AIPRM extension, and confirms login into ChatGPT via Google succeeds.

`verify-aiprm-elements.spec.ts` - this verifies AIPRM's core UI elements render on chatgpt.com and that the "Your AIPRM Account" modal shows the correct connected account info.

`verify-aiprm-composer-pages.spec.ts` - this verifies the AIPRM prompt composer and sidebar appear correctly across a configurable list of secondary ChatGPT pages (currently /images, /shopping, /scheduled).

`aiprm-connect-disconnect.spec.ts` - this exercises a full AIPRM account disconnect-then-reconnect cycle and confirms the account info matches afterward.
