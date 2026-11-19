// ============================================================================
// api.js
// Everything related to talking to the Haveloc jobs endpoint.
//
// Two access strategies, tried in order (see README "How the API is
// accessed"):
//   1. DIRECT  - background service worker calls fetch() itself, relying on
//                host_permissions + the browser's existing cookie jar for
//                the Haveloc API domain. Works if the server allows it.
//   2. VIA_TAB - if DIRECT fails, we message a content script running
//                inside an already-open Haveloc tab. That script's fetch()
//                call carries the tab's real origin, so it matches what the
//                server already allows for the page itself.
//
// PAGINATION: we deliberately never construct a guessed "&page=N" query
// param ourselves. The captured api-key header appears to be bound to the
// exact URL it was issued for (changing the query string caused the server
// to reject the request with HTTP 405). Instead, we only ever request the
// single default URL (sort + size, matching exactly what the real page
// requests) and, if the response is HAL-style and includes its own
// `_links.next.href`, we follow that URL verbatim — never rebuilding it
// ourselves. If no such link is present, pagination stops there; see
// README "Known limitations".
//
// Nothing here logs or stores cookies, tokens, or headers — fetch() sends
// the session cookie automatically via `credentials: "include"`; we never
// read or touch its value.
// ============================================================================

import { CONFIG } from "./config.js";

let cachedApiKey = null;

// Preload cached key from local storage on service worker start
if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
  chrome.storage.local.get(["capturedApiKey"], (res) => {
    if (res && res.capturedApiKey) {
      cachedApiKey = res.capturedApiKey;
    }
  });
}

export function setCapturedApiKey(key) {
  cachedApiKey = key || null;
  if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
    if (key) {
      chrome.storage.local.set({ capturedApiKey: key });
    } else {
      chrome.storage.local.remove(["capturedApiKey"]);
    }
  }
}

export class HavelocApiError extends Error {
  constructor(message, kind) {
    super(message);
    this.kind = kind; // "network" | "auth" | "cors" | "parse" | "no_tab" | "timeout"
  }
}

function buildFirstUrl() {
  const params = new URLSearchParams({
    sort: CONFIG.SORT_PARAM,
    size: String(CONFIG.PAGE_SIZE),
  });
  return `${CONFIG.API_ORIGIN}${CONFIG.ENDPOINT_PATH}?${params.toString()}`;
}

function resolveNextUrl(href) {
  if (!href) return null;
  try {
    // Resolves relative hrefs (e.g. "/app/studentJobSubViews?...") against
    // the API origin; leaves absolute hrefs untouched.
    return new URL(href, CONFIG.API_ORIGIN).toString();
  } catch (e) {
    return null;
  }
}

/**
 * Normalizes a raw API response into { jobs, nextUrl }. nextUrl is only
 * ever a URL the SERVER itself supplied (HAL-style `_links.next.href`) —
 * never one we constructed. Handles a bare array, a HAL/Spring-Data-style
 * paginated object ({ content, _links }), or a { jobs: [...] } shape.
 */
function parsePage(json) {
  if (!json) return { jobs: [], nextUrl: null };
  if (Array.isArray(json)) {
    return { jobs: json, nextUrl: null };
  }
  const nextHref = json._links && json._links.next && json._links.next.href;
  const nextUrl = resolveNextUrl(nextHref);

  // Check Spring Data REST _embedded
  if (json._embedded) {
    for (const key of Object.keys(json._embedded)) {
      if (Array.isArray(json._embedded[key])) {
        return { jobs: json._embedded[key], nextUrl };
      }
    }
  }
  if (Array.isArray(json.content)) {
    return { jobs: json.content, nextUrl };
  }
  if (Array.isArray(json.jobs)) {
    return { jobs: json.jobs, nextUrl };
  }
  if (json.data) {
    if (Array.isArray(json.data)) return { jobs: json.data, nextUrl };
    if (Array.isArray(json.data.content)) return { jobs: json.data.content, nextUrl };
    if (Array.isArray(json.data.jobs)) return { jobs: json.data.jobs, nextUrl };
    if (json.data._embedded) {
      for (const key of Object.keys(json.data._embedded)) {
        if (Array.isArray(json.data._embedded[key])) {
          return { jobs: json.data._embedded[key], nextUrl };
        }
      }
    }
  }
  if (Array.isArray(json.result)) {
    return { jobs: json.result, nextUrl };
  }
  return { jobs: [], nextUrl: null };
}

async function fetchOnePageDirect(url) {
  if (!cachedApiKey && typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
    try {
      const res = await new Promise((r) => chrome.storage.local.get(["capturedApiKey"], r));
      if (res && res.capturedApiKey) cachedApiKey = res.capturedApiKey;
    } catch (e) {}
  }

  let response;
  try {
    response = await fetch(url, {
      method: "GET",
      credentials: "include",
      headers: {
        Accept: "application/json, text/plain, */*",
        "X-Requested-With": "XMLHttpRequest",
        ...(cachedApiKey ? { "api-key": cachedApiKey } : {}),
        ...CONFIG.EXTRA_HEADERS,
      },
    });
  } catch (err) {
    // A CORS rejection or network failure both surface as a generic
    // "Failed to fetch" TypeError — we can't distinguish them, so we treat
    // both as "try the tab fallback next."
    throw new HavelocApiError(
      "Direct fetch failed (network or CORS).",
      "network"
    );
  }

  if (response.status === 401 || response.status === 403) {
    cachedApiKey = null; // stale key — force a fresh capture next load
    throw new HavelocApiError("Not authenticated with Haveloc.", "auth");
  }
  if (!response.ok) {
    throw new HavelocApiError(
      `Haveloc responded with HTTP ${response.status}.`,
      "network"
    );
  }

  let json;
  try {
    json = await response.json();
  } catch (err) {
    throw new HavelocApiError("Could not parse Haveloc response.", "parse");
  }
  return parsePage(json);
}

/** Fetches every page directly from the background worker. */
export async function fetchAllJobsDirect() {
  const allJobs = [];
  let url = buildFirstUrl();
  let iterations = 0;
  while (url && iterations < CONFIG.MAX_PAGES_SAFETY_LIMIT) {
    const { jobs, nextUrl } = await fetchOnePageDirect(url);
    allJobs.push(...jobs);
    url = nextUrl;
    iterations += 1;
  }
  return allJobs;
}

/** Finds an open Haveloc tab, or null if none is open. */
function findHavelocTab() {
  return new Promise((resolve) => {
    chrome.tabs.query(
      {
        url: [
          "https://placements.haveloc.com/*",
          "https://app.haveloc.com/*",
          "*://*.haveloc.com/*",
        ],
      },
      (tabs) => {
        resolve(tabs && tabs.length > 0 ? tabs[0] : null);
      }
    );
  });
}

function messageTab(tabId, message, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new HavelocApiError("Content script did not respond in time.", "timeout"));
    }, timeoutMs);

    chrome.tabs.sendMessage(tabId, message, (response) => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) {
        reject(
          new HavelocApiError(
            `Could not reach Haveloc tab: ${chrome.runtime.lastError.message}`,
            "no_tab"
          )
        );
        return;
      }
      resolve(response);
    });
  });
}

/** Fetches every page by asking a content script in an open Haveloc tab. */
export async function fetchAllJobsViaTab() {
  const tab = await findHavelocTab();
  if (!tab) {
    throw new HavelocApiError(
      "No open Haveloc tab found for fallback fetch.",
      "no_tab"
    );
  }

  const allJobs = [];
  let url = buildFirstUrl();
  let iterations = 0;
  while (url && iterations < CONFIG.MAX_PAGES_SAFETY_LIMIT) {
    const response = await messageTab(tab.id, {
      type: "HAVELOC_FETCH_JOBS_PAGE",
      url,
      apiKey: cachedApiKey,
    });

    if (!response || response.ok !== true) {
      const kind = response && response.kind ? response.kind : "network";
      throw new HavelocApiError(
        (response && response.error) || "Tab fetch failed.",
        kind
      );
    }

    const { jobs, nextUrl } = parsePage(response.json);
    allJobs.push(...jobs);
    url = nextUrl;
    iterations += 1;
  }
  return allJobs;
}

/**
 * Tries DIRECT first, falls back to VIA_TAB. Throws HavelocApiError if both
 * fail, with the most accurate error preferred.
 */
export async function fetchAllJobs() {
  try {
    return await fetchAllJobsDirect();
  } catch (directErr) {
    try {
      return await fetchAllJobsViaTab();
    } catch (tabErr) {
      // If no tab is open, explicitly report no_tab so the user knows to open a Haveloc tab
      if (tabErr.kind === "no_tab") {
        throw new HavelocApiError(
          "No active Haveloc tab open. Please open your college's Haveloc portal (https://app.haveloc.com) in a browser tab.",
          "no_tab"
        );
      }
      // If tab fetch encountered an auth error, session is truly expired
      if (tabErr.kind === "auth" || (directErr.kind === "auth" && tabErr.kind !== "network")) {
        throw new HavelocApiError(
          "Your Haveloc session may have expired. Please refresh your Haveloc tab.",
          "auth"
        );
      }
      throw tabErr;
    }
  }
}
