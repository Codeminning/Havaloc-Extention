# Haveloc Placement Monitor — Phase 1

A Chrome extension that watches your college's Haveloc placement portal and
fires a desktop notification the moment a **new, eligible, not-yet-applied**
job is posted — so you don't have to keep refreshing the page.

```
Haveloc posts a new job
        ↓
Extension notices it on its next check
        ↓
🔔 Desktop notification
        ↓
Click it → opens the job on Haveloc
```

This is **Phase 1 only**. No cloud server, no mobile app, no
Telegram/WhatsApp/email alerts, no monitoring while Chrome is fully closed.

---

## ⚠️ Before you install: one config value to confirm

We know the job data comes from an endpoint called `studentJobSubViews`, but
the exact URL depends on your college's Haveloc deployment. Confirm it
yourself:

1. Log into Haveloc in Chrome, open the jobs page.
2. `F12` → **Network** tab → filter **Fetch/XHR**.
3. Reload the page. Find the request named `studentJobSubViews...`.
4. Right-click it → **Copy** → **Copy URL**.
5. Open `config.js` in this folder and paste:
   - the **origin** (e.g. `https://placements.haveloc.com`) into `API_ORIGIN`
   - the **path** (everything between the host and the `?`) into
     `ENDPOINT_PATH`
6. While you're in DevTools, check that request's **Headers** tab. If it
   needs anything beyond the normal session cookie, add it to
   `EXTRA_HEADERS` in `config.js`. For most deployments you won't need to
   touch this.

`config.js` never needs a password, cookie, or token pasted into it — only
public URL structure.

---

## Installation

1. Confirm the config value above.
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked**.
5. Select the `haveloc-placement-monitor` folder.
6. The extension icon appears in your toolbar.

## How to log into Haveloc

Just log in normally in a regular Chrome tab, the way you always do. The
extension never asks for your password and never sees it — it relies on the
browser session you already have.

## How to enable monitoring

Monitoring is **on by default** after install. Click the extension icon to
open the popup; there's an ON/OFF toggle in the top right if you ever want
to pause it. While off, the extension does not poll or notify.

---

## Architecture

```
haveloc-placement-monitor/
├── manifest.json      Extension manifest (MV3)
├── background.js      Service worker: alarms, orchestration, notifications
├── content.js         Injected into open Haveloc tabs (fallback fetch path)
├── capture-header.js  Observes the page's own api-key header (main world)
├── api.js             Talks to the Haveloc jobs endpoint (direct + fallback)
├── jobs.js            Normalizes jobs, eligibility filter, new-job diffing
├── notifications.js   Builds/fires chrome.notifications
├── storage.js         chrome.storage.local read/write helpers
├── config.js          Editable config (API URL, poll interval, etc.)
├── mock-data.js        Dev-only test harness (no real network calls)
├── popup.html/css/js  Toolbar popup UI
├── icons/             Extension icons
└── README.md
```

## How Haveloc job detection works

Every `POLL_INTERVAL_MINUTES` (default 5), `chrome.alarms` wakes the
background service worker, which:

1. Fetches all pages of eligible jobs from Haveloc.
2. Filters to `isEligible === true` and `isEligibleNotApplied === true`
   (configurable in `config.js`).
3. Compares each job's unique ID against the ones already stored.
4. Fires one notification per genuinely new job.
5. Saves the current set as "seen" so they're never notified again.

**Unique ID rule:** `jobId` (fallback `uuid`) — **never** company name,
since one company can post multiple distinct roles (e.g. Google → Software
Engineer *and* Google → Data Analyst are two different jobs).

## How the API is accessed

**Discovery from inspection:** Haveloc's frontend sends a custom `api-key`
header on every `studentJobSubViews` request, in addition to your normal
session cookie. This extension **never hardcodes that key** — instead, a
tiny script running in the page's own JS context (`capture-header.js`)
passively observes the header value the page was already about to send on
its own request (the same thing DevTools' Network tab shows you manually),
and holds it in memory for the extension's own requests. It is never
written to `chrome.storage`, never logged, and never appears in any file.
Because it's only held in memory, it's lost whenever the service worker
sleeps or Chrome restarts — but it's re-captured automatically the next
time the Haveloc Jobs page makes its own request (e.g. when you open/reload
that tab), no action needed from you.

Two fetch strategies, tried in order:

1. **Direct fetch** — the background service worker calls the Haveloc API
   itself with `credentials: "include"` plus the captured `api-key` header,
   relying on `host_permissions` and your existing session cookie. This can
   still fail even with a valid key/cookie if the server also validates the
   request's `Origin` header strictly (an extension's requests carry a
   `chrome-extension://…` origin, not `https://placements.haveloc.com`).
2. **Tab fallback** — if direct fetch fails, the worker asks a content
   script running inside an **already-open Haveloc tab** to fetch the same
   URL, attaching the same captured `api-key`. Because this request runs
   inside the real tab, its `Origin` header is the genuine
   `https://placements.haveloc.com`, matching what the server already
   allows — making this the more reliable of the two paths for this
   deployment.

**Known limitation:** keep a Haveloc Jobs tab open somewhere (it can be
inactive/unfocused) both so the tab-fallback fetch has somewhere to run,
and so the api-key gets (re-)captured periodically. If you see "Login
required" in the popup, first try simply reloading that tab — that alone
re-triggers a fresh capture.

Pagination is handled conservatively: we only ever request the exact same
URL the real page requests (sort + size, no page number). If Haveloc's
response includes its own `_links.next.href`, we follow that URL exactly as
given, page after page, until it stops appearing. **We never invent our own
`&page=N` parameter** — an earlier version of this extension tried that and
Haveloc's server rejected it with HTTP 405, most likely because the
`api-key` header is cryptographically bound to the exact URL it was issued
for.

**Practical effect:** if Haveloc's API doesn't hand back a `_links.next`
pointer in its response, this extension only ever sees the first 20 jobs
(sorted by `jobApplyBy` descending — i.e. the ones with the furthest-away
deadlines). With 125 total jobs on a college's portal, a newly-posted job
with a near-term deadline could land outside that first page and be missed.
If you confirm (via DevTools) that the response has no `_links.next`, and
full coverage matters to you, the next step would be to find Haveloc's
*actual* pagination mechanism by clicking through to page 2 in the Jobs UI
yourself and inspecting that exact request — then that exact pattern (not
a guess) can be added.

## How notifications work

Title: `🆕 New Haveloc Placement`
Body: `Company — Job title`, plus location and deadline if available.

Clicking a notification opens the job's own Haveloc page
(`_links.self.href` from the API if present, otherwise a constructed URL).

## How duplicate prevention works

Every seen job's unique ID is written to `chrome.storage.local`, which
survives page refreshes, Chrome restarts, and extension reloads. A job is
only ever notified once — checked against this persisted set on every poll.

## First install behavior

On first-ever check, the extension does **not** notify you about every
existing job. It silently saves the current job list as a baseline and
shows a single one-time notification: *"Haveloc Monitor initialized.
Existing jobs saved. New jobs will trigger notifications."* Only jobs that
appear **after** that point trigger per-job notifications.

## Permissions explained

| Permission | Why |
|---|---|
| `storage` | Persist seen-job IDs, settings, and status locally. |
| `alarms` | Reliable periodic background checks (not `setInterval`, which Chrome can kill). |
| `notifications` | Show the desktop notifications that are the whole point of this tool. |
| `host_permissions` for `placements.haveloc.com` / `app.haveloc.com` | Allows fetching job data and matches the content script to Haveloc pages only — nothing else. |

Nothing is requested beyond this. No `<all_urls>`, no `tabs` beyond what's
implied by `host_permissions`, no `cookies` permission (fetch's
`credentials: "include"` handles the session without the extension ever
reading cookie values).

## Troubleshooting

- **"🔴 Login required"** — your Haveloc session expired. Open
  `placements.haveloc.com`, log in, and click **Check Now**.
- **"⚠️ Haveloc unavailable"** — either a network hiccup, or direct fetch
  failed and no Haveloc tab was open for the fallback. Open a Haveloc tab
  and retry.
- **No notifications ever appear** — check Chrome's own OS-level
  notification permission for Chrome isn't blocked, and that the
  monitoring toggle in the popup is ON.
- **Getting notified for jobs you already applied to** — Haveloc's
  `isApplied`/`isEligibleNotApplied` flags may lag briefly after you apply;
  this resolves on the next poll.

## Known limitations

- **Phase 1 requires Chrome to be running** for background monitoring. It
  does **not** monitor Haveloc while Chrome is completely closed.
- If direct (CORS-free) access isn't available on your Haveloc deployment,
  a Haveloc tab must stay open (can be inactive) for checks to succeed.
- **Pagination beyond the first 20 jobs depends on the server providing a
  `_links.next.href`.** We deliberately don't guess `&page=N` — doing so
  triggered an HTTP 405, most likely because the `api-key` header is bound
  to the exact request URL. If your Haveloc deployment doesn't expose a
  next-page link, only the first 20 (by nearest/furthest deadline,
  depending on sort) are monitored. See "How the API is accessed" above.
- No cross-device sync — job state lives only in this browser's local
  storage.

## How to test

A dev-only test harness (`mock-data.js`) exercises the diff/baseline logic
against fabricated data — no real Haveloc requests.

1. Reload the extension in `chrome://extensions`.
2. Click **"service worker"** under the extension to open its console.
3. Run:
   ```js
   import('./mock-data.js').then(m => m.runTestSuite())
   ```
4. It prints pass/fail for:
   - **TEST 1** — first install with 20 jobs → no notifications, baseline saved
   - **TEST 2** — one new job → one notification
   - **TEST 3** — three new jobs → three notifications
   - **TEST 4** — same job reappears → no notification
   - **TEST 5** — job order changes → no false notification
   - **TEST 6** — applied/ineligible jobs are excluded even if "new"
   - **TEST 7** — same company, two jobs → two distinct unique IDs
   - **TEST 8** — malformed job (missing ID) → skipped, no crash

For real-world network/auth/restart tests (network failure, session expiry,
Chrome restart), the extension's error handling and persisted storage were
built to cover them; verify by disabling wifi mid-check, logging out of
Haveloc, and restarting Chrome respectively, watching the popup status each
time.

## What remains for Phase 2

Out of scope here, per the spec: a cloud backend, mobile app, and
Telegram/WhatsApp/email delivery so you can get notified even when Chrome
itself is closed.
