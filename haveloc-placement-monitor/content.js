// ============================================================================
// content.js
// Runs inside an authenticated Haveloc tab (isolated world).
// ============================================================================

let cachedApiKey = null;
let cachedEndpointUrl = null;
let cachedHeaders = {};
let latestCapturedJobs = null;
let lastCapturedTime = 0;

window.addEventListener("__haveloc_monitor_capture", (event) => {
  const apiKey = event && event.detail && event.detail.apiKey;
  if (!apiKey) return;
  cachedApiKey = apiKey;
  try {
    chrome.runtime.sendMessage(
      { type: "HAVELOC_API_KEY_CAPTURED", apiKey },
      () => void chrome.runtime.lastError
    );
  } catch (e) {
    /* ignore */
  }
});

window.addEventListener("__haveloc_monitor_endpoint", (event) => {
  if (event && event.detail) {
    if (event.detail.url) cachedEndpointUrl = event.detail.url;
    if (event.detail.headers) cachedHeaders = { ...cachedHeaders, ...event.detail.headers };
  }
});

window.addEventListener("__haveloc_monitor_data", (event) => {
  if (event && event.detail && event.detail.data) {
    latestCapturedJobs = event.detail.data;
    lastCapturedTime = Date.now();
    try {
      chrome.runtime.sendMessage(
        { type: "HAVELOC_JOBS_DATA_CAPTURED", json: event.detail.data },
        () => void chrome.runtime.lastError
      );
    } catch (e) {
      /* ignore */
    }
  }
});

async function fetchCandidate(url, requestHeaders) {
  try {
    const response = await fetch(url, {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      headers: requestHeaders,
    });

    if (response.status === 401 || response.status === 403) {
      return { ok: false, kind: "auth", error: "Not authenticated with Haveloc." };
    }
    if (!response.ok) {
      return { ok: false, kind: "network", error: `HTTP ${response.status}` };
    }

    const text = await response.text();
    const trimmed = text.trim();

    // If response begins with '<', it is an HTML page (e.g. index.html SPA fallback), not JSON
    if (trimmed.startsWith("<")) {
      return { ok: false, kind: "html", error: "Returned HTML page" };
    }

    try {
      const json = JSON.parse(trimmed);
      return { ok: true, json };
    } catch (err) {
      return { ok: false, kind: "parse", error: "JSON parse failed" };
    }
  } catch (err) {
    return { ok: false, kind: "network", error: err.message || "Fetch failed" };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "HAVELOC_FETCH_JOBS_PAGE") {
    return undefined;
  }

  (async () => {
    // If we have very fresh captured data from the page (< 60s), use it directly
    if (latestCapturedJobs && Date.now() - lastCapturedTime < 60000) {
      sendResponse({ ok: true, json: latestCapturedJobs });
      return;
    }

    try {
      const apiKeyToUse = message.apiKey || cachedApiKey;
      const headers = {
        Accept: "application/json, text/plain, */*",
        "X-Requested-With": "XMLHttpRequest",
        ...cachedHeaders,
      };
      if (apiKeyToUse) headers["api-key"] = apiKeyToUse;

      const candidates = [];

      // 1. Captured exact URL from the real page XHR
      if (cachedEndpointUrl) {
        try {
          const parsed = new URL(cachedEndpointUrl, window.location.href);
          candidates.push(parsed.href);
        } catch (e) {
          candidates.push(cachedEndpointUrl);
        }
      }

      // 2. Candidate variations
      try {
        const parsed = new URL(message.url, window.location.origin);
        candidates.push(window.location.origin + parsed.pathname + parsed.search);

        if (parsed.pathname.includes("/app/studentJobSubViews")) {
          candidates.push(window.location.origin + parsed.pathname.replace("/app/studentJobSubViews", "/studentJobSubViews") + parsed.search);
        } else if (parsed.pathname.includes("/studentJobSubViews")) {
          candidates.push(window.location.origin + parsed.pathname.replace("/studentJobSubViews", "/app/studentJobSubViews") + parsed.search);
        }
      } catch (e) {
        candidates.push(message.url);
      }

      // Also try relative to current page
      candidates.push(window.location.origin + "/studentJobSubViews?sort=jobApplyBy%2Cdesc&size=20");
      candidates.push("https://app.haveloc.com/app/studentJobSubViews?sort=jobApplyBy%2Cdesc&size=20");

      const uniqueCandidates = [...new Set(candidates.filter(Boolean))];
      let lastResult = null;

      for (const targetUrl of uniqueCandidates) {
        const result = await fetchCandidate(targetUrl, headers);
        if (result.ok) {
          latestCapturedJobs = result.json;
          lastCapturedTime = Date.now();
          sendResponse({ ok: true, json: result.json });
          return;
        }
        lastResult = result;
        if (result.kind === "auth") {
          cachedApiKey = null;
          sendResponse({ ok: false, kind: "auth", error: "Not authenticated with Haveloc." });
          return;
        }
      }

      // Fallback: If network fetch returned HTML but we have previously captured jobs, keep them!
      if (latestCapturedJobs) {
        sendResponse({ ok: true, json: latestCapturedJobs });
        return;
      }

      sendResponse({
        ok: false,
        kind: lastResult ? lastResult.kind : "parse",
        error: lastResult && lastResult.error ? lastResult.error : "Could not parse Haveloc response as JSON.",
      });
    } catch (err) {
      if (latestCapturedJobs) {
        sendResponse({ ok: true, json: latestCapturedJobs });
        return;
      }
      sendResponse({
        ok: false,
        kind: "network",
        error: "Fetch failed inside Haveloc tab.",
      });
    }
  })();

  return true; // async sendResponse
});
