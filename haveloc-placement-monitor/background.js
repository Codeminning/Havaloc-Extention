// ============================================================================
// background.js
// The service worker: schedules checks via chrome.alarms, fetches jobs,
// diffs against storage, fires notifications, and handles notification
// clicks + popup messages. See README for the full flow.
// ============================================================================

import { CONFIG } from "./config.js";
import { fetchAllJobs, HavelocApiError, setCapturedApiKey } from "./api.js";
import {
  normalizeJobs,
  filterEligible,
  diffNewJobs,
  matchesPreferences,
  parseDeadline,
  getDeadlineUrgency,
  formatRemainingTime,
} from "./jobs.js";
import {
  notifyNewJob,
  notifyDeadlineApproaching,
  notifyBaselineInitialized,
  notifySessionExpired,
} from "./notifications.js";
import {
  getInitialized,
  setInitialized,
  getSeenJobs,
  markJobsSeen,
  replaceSeenJobs,
  getMonitoringEnabled,
  getLastSuccessfulCheck,
  setLastSuccessfulCheck,
  setLastCheckAttempt,
  setStatus,
  pushRecentJobs,
  getNotificationJobUrl,
  getUserPreferences,
  getNotifiedDeadlines,
  markDeadlineNotified,
} from "./storage.js";

const ALARM_NAME = "haveloc-poll";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM_NAME, {
    periodInMinutes: CONFIG.POLL_INTERVAL_MINUTES,
  });
  setStatus("idle", "Waiting for first check.");
  // Run an initial check shortly after install so the popup has data fast.
  setTimeout(() => runCheck().catch(() => {}), 1500);
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(ALARM_NAME, {
    periodInMinutes: CONFIG.POLL_INTERVAL_MINUTES,
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    runCheck().catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// Passive Network Observer (webRequest)
// Intercepts outgoing requests to Haveloc to capture API key / auth token
// ---------------------------------------------------------------------------
if (chrome.webRequest && chrome.webRequest.onBeforeSendHeaders) {
  chrome.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
      if (!details.requestHeaders) return;
      for (const header of details.requestHeaders) {
        if (!header || !header.name) continue;
        const name = header.name.toLowerCase();
        if (
          name === "api-key" ||
          name === "authorization" ||
          name === "x-api-key" ||
          name === "token" ||
          name === "x-auth-token" ||
          name === "authtoken"
        ) {
          if (header.value) {
            setCapturedApiKey(header.value);
          }
        }
      }
    },
    { urls: ["https://placements.haveloc.com/*", "https://app.haveloc.com/*", "*://*.haveloc.com/*"] },
    ["requestHeaders"]
  );
}

// ---------------------------------------------------------------------------
// Notification click -> open the job
// ---------------------------------------------------------------------------

chrome.notifications.onClicked.addListener(async (notificationId) => {
  const url = await getNotificationJobUrl(notificationId);
  chrome.tabs.create({ url: url || CONFIG.JOBS_PAGE_URL });
  chrome.notifications.clear(notificationId);
});

// ---------------------------------------------------------------------------
// Messages from the popup
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || sender.id !== chrome.runtime.id) return undefined;

  if (message.type === "HAVELOC_API_KEY_CAPTURED" && message.apiKey) {
    // In-memory only — never persisted, never logged. See api.js.
    setCapturedApiKey(message.apiKey);
    return undefined;
  }

  if (message.type === "HAVELOC_JOBS_DATA_CAPTURED" && message.json) {
    processJobs(message.json).catch(() => {});
    return undefined;
  }

  if (message.type === "CHECK_NOW") {
    runCheck()
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true; // keep the message channel open for the async response
  }

  if (message.type === "RUN_TEST_SUITE") {
    import("./mock-data.js")
      .then(({ runTestSuite }) => runTestSuite())
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true;
  }

  return undefined;
});

// ---------------------------------------------------------------------------
// The core check
// ---------------------------------------------------------------------------

export async function processJobs(rawJobs) {
  // rawJobs can be a bare array or a Spring Data REST / HAL paginated object
  let list = rawJobs;
  if (rawJobs && !Array.isArray(rawJobs)) {
    if (rawJobs._embedded) {
      for (const key of Object.keys(rawJobs._embedded)) {
        if (Array.isArray(rawJobs._embedded[key])) {
          list = rawJobs._embedded[key];
          break;
        }
      }
    } else if (Array.isArray(rawJobs.content)) {
      list = rawJobs.content;
    } else if (Array.isArray(rawJobs.jobs)) {
      list = rawJobs.jobs;
    } else if (rawJobs.data) {
      if (Array.isArray(rawJobs.data)) list = rawJobs.data;
      else if (Array.isArray(rawJobs.data.content)) list = rawJobs.data.content;
      else if (Array.isArray(rawJobs.data.jobs)) list = rawJobs.data.jobs;
      else if (rawJobs.data._embedded) {
        for (const key of Object.keys(rawJobs.data._embedded)) {
          if (Array.isArray(rawJobs.data._embedded[key])) {
            list = rawJobs.data._embedded[key];
            break;
          }
        }
      }
    } else if (Array.isArray(rawJobs.result)) {
      list = rawJobs.result;
    }
  }
  if (!Array.isArray(list)) list = [];

  const normalized = normalizeJobs(list);
  const eligible = filterEligible(normalized);

  const initialized = await getInitialized();
  const seenJobsMap = await getSeenJobs();
  const seenIdSet = new Set(Object.keys(seenJobsMap));

  const preferences = await getUserPreferences();
  const notifiedDeadlines = await getNotifiedDeadlines();

  if (!initialized || seenIdSet.size === 0) {
    // First run ever or empty baseline: save baseline and show initial jobs in popup
    await replaceSeenJobs(eligible);
    await setInitialized(true);
    if (!initialized) {
      await notifyBaselineInitialized(eligible.length);
    }
    if (eligible.length > 0) {
      await pushRecentJobs(
        eligible.map((j) => ({
          ...j,
          detectedAt: new Date().toISOString(),
        }))
      );
    }
    await setStatus("connected", "");
    await setLastSuccessfulCheck(new Date().toISOString());
    return { initializedNow: true, baselineCount: eligible.length };
  }

  const newJobs = diffNewJobs(eligible, seenIdSet);

  for (const job of newJobs) {
    if (preferences.notifyOnlyMatching && !matchesPreferences(job, preferences)) {
      continue; // Respect "Notify only for matching jobs"
    }
    await notifyNewJob(job);
  }

  // 24-Hour Deadline Notification: alert for unapplied jobs in the final 24 hours
  for (const job of eligible) {
    if (notifiedDeadlines[job.uniqueId]) continue; // prevent duplicate deadline alert
    const deadlineInfo = parseDeadline(job.jobApplyBy);
    const urgency = getDeadlineUrgency(deadlineInfo);
    if (urgency === "critical") {
      if (preferences.notifyOnlyMatching && !matchesPreferences(job, preferences)) {
        continue;
      }
      const remainingText = formatRemainingTime(deadlineInfo);
      await notifyDeadlineApproaching(job, remainingText);
      await markDeadlineNotified(job.uniqueId);
      notifiedDeadlines[job.uniqueId] = Date.now();
    }
  }

  await markJobsSeen(eligible);

  if (eligible.length > 0) {
    await pushRecentJobs(
      eligible.map((j) => ({
        ...j,
        detectedAt: new Date().toISOString(),
      }))
    );
  }

  await setStatus("connected", "");
  await setLastSuccessfulCheck(new Date().toISOString());

  return { newJobCount: newJobs.length, totalEligible: eligible.length };
}

export async function runCheck() {
  const monitoringEnabled = await getMonitoringEnabled();
  if (!monitoringEnabled) {
    await setStatus("idle", "Monitoring is turned off.");
    return { skipped: true, reason: "monitoring_disabled" };
  }

  await setStatus("checking", "");
  await setLastCheckAttempt(new Date().toISOString());

  let rawJobs;
  try {
    rawJobs = await fetchAllJobs();
  } catch (err) {
    return handleCheckError(err);
  }

  return processJobs(rawJobs);
}

async function handleCheckError(err) {
  if (err instanceof HavelocApiError && err.kind === "auth") {
    setCapturedApiKey(null); // force a fresh capture on next page load
    await setStatus(
      "login_required",
      "Reload the Haveloc Jobs tab (session or the security key may have expired)."
    );
    // Only push a notification if we'd previously connected successfully —
    // otherwise this fires every time the extension reloads during
    // development, before the Jobs tab has had a chance to reconnect and
    // supply a fresh key, which is expected and not worth interrupting you
    // for.
    const hadPriorSuccess = Boolean(await getLastSuccessfulCheck());
    if (hadPriorSuccess) {
      await notifySessionExpired();
    }
    return { error: "auth", message: err.message };
  }
  if (err instanceof HavelocApiError && err.kind === "no_tab") {
    await setStatus(
      "unavailable",
      "Open a Haveloc tab so the extension can read your session."
    );
    return { error: "no_tab", message: err.message };
  }
  // Any other failure (network, parse, timeout) — if we already had a successful check,
  // do NOT wipe out connected status for transient background poll glitches.
  const hadPriorSuccess = Boolean(await getLastSuccessfulCheck());
  if (hadPriorSuccess) {
    return { error: "transient", message: (err && err.message) || "Transient error" };
  }
  await setStatus("unavailable", (err && err.message) || "Unknown error.");
  return { error: "unavailable", message: err && err.message };
}
