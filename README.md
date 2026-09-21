# Thuispoort scanner — Stage 3.2

A strictly **read-only, dry-run** adaptive polling scanner. It reuses a manually authenticated Playwright session, captures the personalized Actueel aanbod request, and reports only listings not observed during an earlier scan.

The offer search itself is a POST because that is Thuispoort's read-only search API. The scanner stores only known housing IDs; it does not submit reactions, click reaction buttons, call mutation endpoints, or schedule scans.

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

`npm run scan` remains running and schedules sequential scans in `Europe/Amsterdam`: NORMAL (300s), PRE_WINDOW 11:50–12:00 (60s), HOT 12:00–12:20 (20s), and POST_WINDOW 12:20–12:40 (60s). Each interval is configurable through `.env`; values below 10 seconds are rejected. Sleep is capped at the next mode boundary, scans never overlap, and Ctrl+C stops an active wait immediately.

Authentication is accepted only when the API results contain `reactionData.loggedin === true`. The request body and full response are never logged because they can contain personal profile information. Eligibility still filters only on:

```ts
woning.isPassend === true && woning.kanReageren === true
```

On the first scan, all current IDs are saved to `data/known-woningen.json` as a baseline and none are reported as new. Later scans report only IDs absent from that state. Each new result includes its first detection time in `Europe/Amsterdam`. Eligible new listings say `DRY RUN → WOULD REACT`; ineligible new listings say `SKIP`. Both are persisted as known before they are reported. The summary always says `0 reactions sent`.

Missing state creates a baseline. Corrupted or unreadable state fails closed without classifying listings as new. If the offer API does not return an authenticated profile, the scan stops with `SESSION/API PROFILE NOT AUTHENTICATED` and asks you to run `npm run login`.

## Checks

```bash
npm run typecheck
npm run build
npm test
```

## Stage 5.5 live safety

Automatic submission remains off by default. `MAX_LIVE_SUBMITS_PER_RUN` defaults to 10 and may
not exceed 20; `MIN_LIVE_SUBMIT_INTERVAL_MS` defaults to 2000. Different dwellings are serialized
under the global lock, while each attempt ID can cross the submit boundary once. A durable
post-submit `UNKNOWN` or unresolved `SUBMITTING` record reconstructs an open circuit after restart.
The circuit never closes on a timer or successful scan.

Inspect the persisted safety state without making portal requests:

```bash
npm run reaction-safety -- status
```

Keep `AUTO_SUBMIT=false` for dry runs. Production activation is an explicit operator action:

```bash
AUTO_SUBMIT=true npm run scan
```

## Structure

- `src/auth`: manual login, storage-state persistence, session validation
- `src/api`: frontend request capture, authenticated-response validation, read-only search pagination
- `src/woningen`: raw/normalized types, normalization, eligibility filter
- `src/dry-run`: console-only result reporting
- `src/scanner`: duplicate-safe new-listing detection
- `src/poller`: sequential adaptive polling and graceful wait cancellation
- `src/scheduler`: pure Amsterdam-time mode, boundary, and delay calculations
- `src/state`: validated loading and atomic saving of known IDs
- `src/config`: environment validation
- `src/utils`: timestamped logging

## Safety boundary

Stage 3.2 has no mutation or reaction implementation. Its only POST requests repeat the captured read-only `actueel-aanbod` search payload for pagination. No request is made to a reaction or form-submission endpoint.
