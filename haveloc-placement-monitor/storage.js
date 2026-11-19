// ============================================================================
// storage.js
// Thin wrapper around chrome.storage.local. Never store credentials here —
// only job metadata, timestamps, and settings (see README section 9).
// ============================================================================

const KEYS = {
  INITIALIZED: "initialized",
  SEEN_JOBS: "seenJobs", // { [jobUniqueId]: { companyName, jobTitle, seenAt } }
  RECENT_JOBS: "recentJobs", // array, most-recent-first, for popup display
  MONITORING_ENABLED: "monitoringEnabled",
  LAST_SUCCESSFUL_CHECK: "lastSuccessfulCheck",
  LAST_CHECK_ATTEMPT: "lastCheckAttempt",
  STATUS: "status", // "connected" | "checking" | "login_required" | "unavailable" | "idle"
  STATUS_DETAIL: "statusDetail",
  NOTIFICATION_JOB_MAP: "notificationJobMap", // { [notificationId]: jobUrl }
  USER_PREFERENCES: "userPreferences",
  NOTIFIED_DEADLINES: "notifiedDeadlines", // { [jobUniqueId]: timestamp }
};

function get(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (result) => resolve(result));
  });
}

function set(obj) {
  return new Promise((resolve) => {
    chrome.storage.local.set(obj, () => resolve());
  });
}

export async function getInitialized() {
  const r = await get(KEYS.INITIALIZED);
  return Boolean(r[KEYS.INITIALIZED]);
}

export async function setInitialized(value) {
  await set({ [KEYS.INITIALIZED]: value });
}

export async function getSeenJobs() {
  const r = await get(KEYS.SEEN_JOBS);
  return r[KEYS.SEEN_JOBS] || {};
}

export async function markJobsSeen(jobs) {
  const seen = await getSeenJobs();
  const now = new Date().toISOString();
  for (const job of jobs) {
    seen[job.uniqueId] = {
      companyName: job.companyName,
      jobTitle: job.jobTitle,
      seenAt: now,
    };
  }
  await set({ [KEYS.SEEN_JOBS]: seen });
}

export async function replaceSeenJobs(jobs) {
  const seen = {};
  const now = new Date().toISOString();
  for (const job of jobs) {
    seen[job.uniqueId] = {
      companyName: job.companyName,
      jobTitle: job.jobTitle,
      seenAt: now,
    };
  }
  await set({ [KEYS.SEEN_JOBS]: seen });
}

export async function getSeenJobCount() {
  const seen = await getSeenJobs();
  return Object.keys(seen).length;
}

export async function getRecentJobs() {
  const r = await get(KEYS.RECENT_JOBS);
  return r[KEYS.RECENT_JOBS] || [];
}

export async function pushRecentJobs(newJobs) {
  const existing = await getRecentJobs();
  const seenIds = new Set();
  const merged = [];
  for (const job of [...newJobs, ...existing]) {
    const id = job.uniqueId || `${job.companyName}-${job.jobTitle}`;
    if (!seenIds.has(id)) {
      seenIds.add(id);
      merged.push(job);
    }
  }
  await set({ [KEYS.RECENT_JOBS]: merged.slice(0, 30) });
}

export const DEFAULT_PREFERENCES = {
  keywords: [],
  locations: [],
  jobTypes: [],
  minSalary: "",
  excludedCompanies: [],
  notifyOnlyMatching: false,
  filterViewOnlyMatching: false,
};

export async function getUserPreferences() {
  const r = await get(KEYS.USER_PREFERENCES);
  return { ...DEFAULT_PREFERENCES, ...(r[KEYS.USER_PREFERENCES] || {}) };
}

export async function setUserPreferences(prefs) {
  const current = await getUserPreferences();
  const updated = { ...current, ...prefs };
  await set({ [KEYS.USER_PREFERENCES]: updated });
  return updated;
}

export async function getNotifiedDeadlines() {
  const r = await get(KEYS.NOTIFIED_DEADLINES);
  return r[KEYS.NOTIFIED_DEADLINES] || {};
}

export async function markDeadlineNotified(jobUniqueId) {
  const map = await getNotifiedDeadlines();
  map[jobUniqueId] = Date.now();
  await set({ [KEYS.NOTIFIED_DEADLINES]: map });
}

export async function getMonitoringEnabled() {
  const r = await get(KEYS.MONITORING_ENABLED);
  // default ON
  return r[KEYS.MONITORING_ENABLED] === undefined
    ? true
    : Boolean(r[KEYS.MONITORING_ENABLED]);
}

export async function setMonitoringEnabled(value) {
  await set({ [KEYS.MONITORING_ENABLED]: value });
}

export async function getLastSuccessfulCheck() {
  const r = await get(KEYS.LAST_SUCCESSFUL_CHECK);
  return r[KEYS.LAST_SUCCESSFUL_CHECK] || null;
}

export async function setLastSuccessfulCheck(iso) {
  await set({ [KEYS.LAST_SUCCESSFUL_CHECK]: iso });
}

export async function setLastCheckAttempt(iso) {
  await set({ [KEYS.LAST_CHECK_ATTEMPT]: iso });
}

export async function getLastCheckAttempt() {
  const r = await get(KEYS.LAST_CHECK_ATTEMPT);
  return r[KEYS.LAST_CHECK_ATTEMPT] || null;
}

export async function setStatus(status, detail = "") {
  await set({ [KEYS.STATUS]: status, [KEYS.STATUS_DETAIL]: detail });
}

export async function getStatus() {
  const r = await get([KEYS.STATUS, KEYS.STATUS_DETAIL]);
  return {
    status: r[KEYS.STATUS] || "idle",
    detail: r[KEYS.STATUS_DETAIL] || "",
  };
}

export async function setNotificationJobUrl(notificationId, url) {
  const r = await get(KEYS.NOTIFICATION_JOB_MAP);
  const map = r[KEYS.NOTIFICATION_JOB_MAP] || {};
  map[notificationId] = url;
  // keep the map bounded
  const entries = Object.entries(map);
  const trimmed =
    entries.length > 200 ? Object.fromEntries(entries.slice(-200)) : map;
  await set({ [KEYS.NOTIFICATION_JOB_MAP]: trimmed });
}

export async function getNotificationJobUrl(notificationId) {
  const r = await get(KEYS.NOTIFICATION_JOB_MAP);
  const map = r[KEYS.NOTIFICATION_JOB_MAP] || {};
  return map[notificationId] || null;
}

export async function getFullPopupState() {
  const [
    initialized,
    seenCount,
    recentJobs,
    monitoringEnabled,
    lastSuccessfulCheck,
    lastCheckAttempt,
    statusObj,
    userPreferences,
  ] = await Promise.all([
    getInitialized(),
    getSeenJobCount(),
    getRecentJobs(),
    getMonitoringEnabled(),
    getLastSuccessfulCheck(),
    getLastCheckAttempt(),
    getStatus(),
    getUserPreferences(),
  ]);
  return {
    initialized,
    trackedJobCount: seenCount,
    recentJobs,
    monitoringEnabled,
    lastSuccessfulCheck,
    lastCheckAttempt,
    status: statusObj.status,
    statusDetail: statusObj.detail,
    userPreferences,
  };
}

// Wipes all monitor data (jobs, state) but leaves nothing credential-related
// behind since nothing credential-related is ever stored.
export async function resetAll() {
  await new Promise((resolve) => chrome.storage.local.clear(resolve));
}
