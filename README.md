# Thuispoort scanner — Stage 1

A strictly **read-only, dry-run** TypeScript scanner. It reuses a manually authenticated Playwright session, opens the real Actueel aanbod page, captures its personalized search request, and reports homes for which both `isPassend` and `kanReageren` are `true`.

The offer search itself is a POST because that is Thuispoort's read-only search API. The scanner does not submit reactions, click reaction buttons, call mutation endpoints, schedule scans, or store housing results.

## Requirements

- Node.js 20 or newer
- A supported Chromium runtime installed by Playwright

## Setup

```bash
npm install
npx playwright install chromium
cp .env.example .env
```

`THUISPOORT_AANBOD_PAGE_URL` defaults to `https://www.thuispoort.nl/aanbod/te-huur`. It can be overridden in `.env` if the frontend page moves. This is a frontend page URL, not the `zig365.nl` API URL. The old `THUISPOORT_AANBOD_URL` API setting is no longer used.

Optionally set `THUISPOORT_SESSION_CHECK_URL` to an authenticated, read-only page or GET endpoint. This improves expiry detection; otherwise the public base URL is checked first and the offer API provides the authoritative second check.

## Authenticate manually

```bash
npm run login
```

Chromium opens in headed mode. Log in yourself, wait until your account page is visible, then return to the terminal and press Enter. Browser state is saved to `.auth/thuispoort.json`; that directory is ignored by Git. No credentials are entered or stored by the application.

## Scan (dry run)

```bash
npm run scan
```

The scanner loads the saved browser state and opens `THUISPOORT_AANBOD_PAGE_URL`. It captures the frontend-generated `actueel-aanbod` POST, consumes its response, and preserves its complete JSON body for remaining pages while changing only the `page` query parameter. Results are deduplicated by housing ID.

Authentication is accepted only when the API results contain `reactionData.loggedin === true`. The request body and full response are never logged because they can contain personal profile information. Eligibility still filters only on:

```ts
woning.isPassend === true && woning.kanReageren === true
```

Allocation model codes are displayed but never used to exclude a home. Every reported match says `DRY RUN → WOULD REACT`; the summary always says `0 reactions sent`.

If the state is missing or the actual offer API does not return an authenticated profile, the scan stops with `SESSION/API PROFILE NOT AUTHENTICATED` and asks you to run `npm run login`.

## Checks

```bash
npm run typecheck
npm run build
```

## Structure

- `src/auth`: manual login, storage-state persistence, session validation
- `src/api`: frontend request capture, authenticated-response validation, read-only search pagination
- `src/woningen`: raw/normalized types, normalization, eligibility filter
- `src/dry-run`: console-only result reporting
- `src/config`: environment validation
- `src/utils`: timestamped logging

## Safety boundary

Stage 1 has no mutation or reaction implementation. Its only POST requests repeat the captured read-only `actueel-aanbod` search payload for pagination. No request is made to a reaction or form-submission endpoint.
