// ============================================================================
// notifications.js
// Wraps chrome.notifications. Every notification we create is recorded in
// storage as notificationId -> job URL, so background.js's
// chrome.notifications.onClicked handler knows where to send the user.
// ============================================================================

import { setNotificationJobUrl } from "./storage.js";
import { formatJobForDisplay } from "./jobs.js";

const ICON = "icons/icon128.png";

function create(notificationId, options) {
  return new Promise((resolve) => {
    chrome.notifications.create(notificationId, options, () => resolve());
  });
}

export async function notifyNewJob(job) {
  const display = formatJobForDisplay(job);
  const lines = [];
  if (display.location) lines.push(`\ud83d\udccd ${display.location}`);
  if (display.formattedDeadline) {
    lines.push(`\u23f0 Apply by: ${display.formattedDeadline}`);
  }

  const notificationId = `haveloc-job-${job.uniqueId}-${Date.now()}`;

  await create(notificationId, {
    type: "basic",
    iconUrl: ICON,
    title: "\ud83c\udd95 New Haveloc Placement",
    message: `${display.companyName} \u2014 ${display.jobTitle}`,
    contextMessage: lines.join("   "),
    priority: 2,
    requireInteraction: true,
  });

  await setNotificationJobUrl(notificationId, job.url);
  return notificationId;
}

export async function notifyBaselineInitialized(count) {
  const notificationId = `haveloc-init-${Date.now()}`;
  await create(notificationId, {
    type: "basic",
    iconUrl: ICON,
    title: "Haveloc Monitor initialized",
    message: `Existing jobs saved (${count}). New jobs will trigger notifications.`,
    priority: 0,
  });
  return notificationId;
}

export async function notifyDeadlineApproaching(job, remainingText = "within 24 hours") {
  const display = formatJobForDisplay(job);
  const notificationId = `haveloc-deadline-${job.uniqueId}-${Date.now()}`;

  await create(notificationId, {
    type: "basic",
    iconUrl: ICON,
    title: `⏳ 24h Deadline: ${display.companyName}`,
    message: `${display.jobTitle} closes soon (${remainingText})!`,
    contextMessage: display.location ? `\ud83d\udccd ${display.location}` : "Haveloc Placement",
    priority: 2,
    requireInteraction: true,
  });

  await setNotificationJobUrl(notificationId, job.url);
  return notificationId;
}

export async function notifySessionExpired() {
  const notificationId = `haveloc-auth-${Date.now()}`;
  await create(notificationId, {
    type: "basic",
    iconUrl: ICON,
    title: "Haveloc login required",
    message:
      "Your Haveloc session may have expired. Open Haveloc and log in again.",
    priority: 1,
  });
  return notificationId;
}
