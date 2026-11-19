// ============================================================================
// popup.js
// Reads state, renders deadline urgency badges, handles preference filters,
// and exports .ics calendar events.
// ============================================================================

import { CONFIG } from "./config.js";
import {
  sortJobsByDeadline,
  formatJobForDisplay,
  generateIcsCalendar,
} from "./jobs.js";
import {
  getFullPopupState,
  getUserPreferences,
  setUserPreferences,
} from "./storage.js";

const STATUS_LABELS = {
  connected: "\ud83d\udfe2 Connected",
  checking: "\ud83d\udfe1 Checking…",
  login_required: "\ud83d\udd34 Login required",
  unavailable: "\u26a0\ufe0f Haveloc unavailable",
  idle: "\u26aa Idle",
};

// Main elements
const dot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
const statusDetail = document.getElementById("statusDetail");
const lastCheckedEl = document.getElementById("lastChecked");
const trackedCountEl = document.getElementById("trackedCount");
const jobsListEl = document.getElementById("jobsList");
const monitoringToggle = document.getElementById("monitoringToggle");
const checkNowBtn = document.getElementById("checkNowBtn");
const openHavelocBtn = document.getElementById("openHavelocBtn");
const filterMatchingOnly = document.getElementById("filterMatchingOnly");

// Navigation elements
const togglePreferencesBtn = document.getElementById("togglePreferencesBtn");
const closePreferencesBtn = document.getElementById("closePreferencesBtn");
const jobsView = document.getElementById("jobsView");
const preferencesView = document.getElementById("preferencesView");

// Preference form elements
const preferencesForm = document.getElementById("preferencesForm");
const prefKeywords = document.getElementById("prefKeywords");
const prefLocations = document.getElementById("prefLocations");
const prefTypeIntern = document.getElementById("prefTypeIntern");
const prefTypeFull = document.getElementById("prefTypeFull");
const prefTypePart = document.getElementById("prefTypePart");
const prefMinSalary = document.getElementById("prefMinSalary");
const prefExcluded = document.getElementById("prefExcluded");
const prefNotifyOnlyMatching = document.getElementById("prefNotifyOnlyMatching");
const prefStatusMsg = document.getElementById("prefStatusMsg");

let currentState = null;

function timeAgo(isoString) {
  if (!isoString) return "Never";
  const diffMs = Date.now() - new Date(isoString).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "Just now";
  if (mins === 1) return "1 minute ago";
  if (mins < 60) return `${mins} minutes ago`;
  const hrs = Math.round(mins / 60);
  if (hrs === 1) return "1 hour ago";
  if (hrs < 24) return `${hrs} hours ago`;
  const days = Math.round(hrs / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

function downloadCalendarEvent(job) {
  const ics = generateIcsCalendar(job);
  if (!ics) return;
  const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const safeName = (job.companyName || "job").toLowerCase().replace(/[^a-z0-9]/g, "-");
  const a = document.createElement("a");
  a.href = url;
  a.download = `apply-${safeName}.ics`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function render(state) {
  currentState = state;
  const status = state.status || "idle";
  dot.className = `dot ${status}`;
  statusText.textContent = STATUS_LABELS[status] || status;
  statusDetail.textContent = state.statusDetail || "";

  lastCheckedEl.textContent = timeAgo(state.lastSuccessfulCheck);
  trackedCountEl.textContent = String(state.trackedJobCount ?? 0);

  monitoringToggle.checked = Boolean(state.monitoringEnabled);

  const rawJobs = state.recentJobs || [];
  const preferences = state.userPreferences || {};

  // Sort jobs by nearest deadline first
  const sortedJobs = sortJobsByDeadline(rawJobs);

  // Format display jobs with deadline urgency and preference matching
  const displayJobs = sortedJobs.map((j) => formatJobForDisplay(j, preferences));

  // Count matching jobs
  const matchingCount = displayJobs.filter((j) => j.isMatch).length;

  // Filter if toggle is checked
  const showOnlyMatching = Boolean(filterMatchingOnly.checked);
  const visibleJobs = showOnlyMatching
    ? displayJobs.filter((j) => j.isMatch)
    : displayJobs;

  if (visibleJobs.length === 0) {
    if (showOnlyMatching && rawJobs.length > 0) {
      jobsListEl.innerHTML = '<div class="empty-state">No jobs match your current preferences.</div>';
    } else {
      jobsListEl.innerHTML = '<div class="empty-state">No jobs detected yet.</div>';
    }
    return;
  }

  jobsListEl.innerHTML = "";
  for (const job of visibleJobs.slice(0, 15)) {
    const card = document.createElement("div");
    card.className = "job-item";

    // Header row: Company name + Match badge
    const headerRow = document.createElement("div");
    headerRow.className = "job-header-row";

    const company = document.createElement("span");
    company.className = "job-company";
    company.textContent = job.companyName || "Unknown company";

    const matchBadge = document.createElement("span");
    matchBadge.className = `match-badge ${job.isMatch ? "matched" : "unmatched"}`;
    matchBadge.textContent = job.isMatch ? "★ Matches" : "No match";

    headerRow.appendChild(company);
    headerRow.appendChild(matchBadge);

    // Job Title
    const title = document.createElement("div");
    title.className = "job-title";
    title.textContent = job.jobTitle || "Untitled role";

    // Meta row: Location & Deadline Urgency badge
    const metaRow = document.createElement("div");
    metaRow.className = "job-meta-row";

    if (job.location) {
      const loc = document.createElement("span");
      loc.className = "job-location";
      loc.textContent = `📍 ${job.location}`;
      metaRow.appendChild(loc);
    }

    const urgencyBadge = document.createElement("span");
    urgencyBadge.className = `urgency-badge urgency-${job.urgency}`;
    let urgencyIcon = "⏳";
    if (job.urgency === "critical") urgencyIcon = "🚨";
    else if (job.urgency === "approaching") urgencyIcon = "⚠️";
    else if (job.urgency === "normal") urgencyIcon = "📅";
    else urgencyIcon = "⚪";

    urgencyBadge.textContent = `${urgencyIcon} ${job.remainingText}`;
    if (job.jobApplyBy) {
      urgencyBadge.title = `Deadline: ${job.jobApplyBy}`;
    }
    metaRow.appendChild(urgencyBadge);

    // Action row: Open Job link + Add to Calendar button
    const actionsRow = document.createElement("div");
    actionsRow.className = "job-actions-row";

    const openLink = document.createElement("a");
    openLink.className = "job-link-btn";
    openLink.href = job.url || CONFIG.JOBS_PAGE_URL;
    openLink.target = "_blank";
    openLink.rel = "noopener noreferrer";
    openLink.textContent = "Open Job ↗";

    const calBtn = document.createElement("button");
    calBtn.className = "btn-cal";
    calBtn.textContent = "📅 Add to Calendar";
    if (job.hasDeadline && !job.deadlineInfo.isExpired) {
      calBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        downloadCalendarEvent(job);
      });
    } else {
      calBtn.disabled = true;
      calBtn.title = job.deadlineInfo.isExpired ? "Deadline has passed" : "No deadline specified";
    }

    actionsRow.appendChild(openLink);
    actionsRow.appendChild(calBtn);

    card.appendChild(headerRow);
    card.appendChild(title);
    card.appendChild(metaRow);
    card.appendChild(actionsRow);

    jobsListEl.appendChild(card);
  }
}

function loadPreferencesIntoForm(prefs) {
  prefKeywords.value = (prefs.keywords || []).join(", ");
  prefLocations.value = (prefs.locations || []).join(", ");
  prefMinSalary.value = prefs.minSalary || "";
  prefExcluded.value = (prefs.excludedCompanies || []).join(", ");
  prefNotifyOnlyMatching.checked = Boolean(prefs.notifyOnlyMatching);

  const types = (prefs.jobTypes || []).map((t) => t.toLowerCase());
  prefTypeIntern.checked = types.some((t) => t.includes("intern"));
  prefTypeFull.checked = types.some((t) => t.includes("full"));
  prefTypePart.checked = types.some((t) => t.includes("part"));
}

async function refresh() {
  const state = await getFullPopupState();
  render(state);
}

// Toggle Views
togglePreferencesBtn.addEventListener("click", async () => {
  const prefs = (currentState && currentState.userPreferences) || (await getUserPreferences());
  loadPreferencesIntoForm(prefs);
  jobsView.classList.add("hidden");
  preferencesView.classList.remove("hidden");
  prefStatusMsg.textContent = "";
});

closePreferencesBtn.addEventListener("click", () => {
  preferencesView.classList.add("hidden");
  jobsView.classList.remove("hidden");
});

// Save Preferences Form
preferencesForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  const keywords = prefKeywords.value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const locations = prefLocations.value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const excludedCompanies = prefExcluded.value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const jobTypes = [];
  if (prefTypeIntern.checked) jobTypes.push("internship");
  if (prefTypeFull.checked) jobTypes.push("full-time");
  if (prefTypePart.checked) jobTypes.push("part-time");

  const minSalary = prefMinSalary.value.trim();
  const notifyOnlyMatching = Boolean(prefNotifyOnlyMatching.checked);

  await setUserPreferences({
    keywords,
    locations,
    jobTypes,
    minSalary,
    excludedCompanies,
    notifyOnlyMatching,
  });

  prefStatusMsg.textContent = "Preferences saved ✓";
  setTimeout(() => {
    prefStatusMsg.textContent = "";
    preferencesView.classList.add("hidden");
    jobsView.classList.remove("hidden");
    refresh();
  }, 600);
});

// Filter Toggle
filterMatchingOnly.addEventListener("change", () => {
  if (currentState) {
    render(currentState);
  }
});

monitoringToggle.addEventListener("change", () => {
  chrome.storage.local.set({ monitoringEnabled: monitoringToggle.checked }, () => {
    refresh();
  });
});

checkNowBtn.addEventListener("click", () => {
  checkNowBtn.disabled = true;
  checkNowBtn.textContent = "Checking…";
  chrome.runtime.sendMessage({ type: "CHECK_NOW" }, () => {
    checkNowBtn.disabled = false;
    checkNowBtn.textContent = "Check Now";
    refresh();
  });
});

openHavelocBtn.addEventListener("click", () => {
  chrome.tabs.create({
    url: CONFIG.JOBS_PAGE_URL || "https://app.haveloc.com",
  });
});

// Live-update if storage changes while popup is open
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local") refresh();
});

refresh();
