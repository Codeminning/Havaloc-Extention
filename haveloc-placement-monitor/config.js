// ============================================================================
// config.js
//
// >>> EDIT THIS FILE BEFORE FIRST USE <<<
//
// We know the endpoint is called "studentJobSubViews" and that it lives on
// the Haveloc placements domain, but the exact origin + path prefix depends
// on your college's Haveloc deployment. Confirm it yourself:
//
//   1. Log into Haveloc in Chrome, open the jobs page.
//   2. Open DevTools (F12) -> Network tab -> filter "Fetch/XHR".
//   3. Reload the page, find the request named "studentJobSubViews...".
//   4. Right click it -> Copy -> Copy URL.
//   5. Paste the ORIGIN (protocol+host, e.g. "https://placements.haveloc.com")
//      into API_ORIGIN below, and the PATH (everything after the host, up to
//      but not including the "?") into ENDPOINT_PATH below.
//   6. Also check the "Headers" tab of that request for anything unusual —
//      if it needs a header beyond the normal cookie session, add it to
//      EXTRA_HEADERS.
//
// Nothing in this file should ever contain a password, cookie value, or
// bearer token. Only URLs and public, non-secret config.
// ============================================================================

export const CONFIG = {
  // Origin the jobs API is served from.
  API_ORIGIN: "https://placements.haveloc.com",

  // Path to the jobs endpoint (confirmed from DevTools).
  ENDPOINT_PATH: "/app/studentJobSubViews",

  // The page that should open when a notification is clicked, if a job
  // doesn't provide its own `_links.self.href`. {jobId} is replaced.
  JOB_FALLBACK_URL_TEMPLATE: "https://app.haveloc.com/app/jobViews/{jobId}",

  // The human page to open from the popup's "Open Haveloc" button.
  JOBS_PAGE_URL:
    "https://placements.haveloc.com/jobs?sort=jobApplyBy%2Cdesc&jobView=eligible",

  // Query params sent with every request.
  SORT_PARAM: "jobApplyBy,desc",
  PAGE_SIZE: 20,

  // How often chrome.alarms fires a background check.
  POLL_INTERVAL_MINUTES: 5,

  // Any extra headers this particular Haveloc deployment needs beyond the
  // normal same-origin cookie session. Usually empty.
  EXTRA_HEADERS: {},

  // Phase 1 eligibility rule (see README section 8). Keep both true for the
  // strictest, least-noisy behavior: only eligible AND not-yet-applied jobs.
  REQUIRE_ELIGIBLE: true,
  REQUIRE_NOT_APPLIED: true,

  // Internal — do not change.
  MAX_PAGES_SAFETY_LIMIT: 25,
};
