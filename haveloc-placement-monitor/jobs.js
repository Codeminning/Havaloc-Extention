// ============================================================================
// jobs.js
// Turns raw Haveloc job objects into a normalized shape, filters by
// eligibility, and diffs against previously-seen jobs.
//
// Unique ID rule (see README section 4): jobId, falling back to uuid.
// NEVER companyName — a company can post multiple distinct jobs.
// ============================================================================

import { CONFIG } from "./config.js";

export function jobUniqueId(rawJob) {
  if (!rawJob) return null;
  if (rawJob.jobId !== undefined && rawJob.jobId !== null) {
    return `jobId:${rawJob.jobId}`;
  }
  if (rawJob.id !== undefined && rawJob.id !== null) {
    return `id:${rawJob.id}`;
  }
  if (rawJob.uuid) {
    return `uuid:${rawJob.uuid}`;
  }
  if (rawJob._links && rawJob._links.self && rawJob._links.self.href) {
    return `href:${rawJob._links.self.href}`;
  }
  return null;
}

export function jobUrl(rawJob) {
  const href = rawJob && rawJob._links && rawJob._links.self && rawJob._links.self.href;
  if (href) return href;
  const id = rawJob && (rawJob.jobId ?? rawJob.id);
  if (id !== undefined && id !== null) {
    return CONFIG.JOB_FALLBACK_URL_TEMPLATE.replace("{jobId}", id);
  }
  return CONFIG.JOBS_PAGE_URL;
}

/** Normalizes a raw Haveloc job into the shape the rest of the extension uses. */
export function normalizeJob(rawJob) {
  if (!rawJob) return null;
  const uniqueId = jobUniqueId(rawJob);
  if (!uniqueId) return null;
  return {
    uniqueId,
    jobId: rawJob.jobId ?? rawJob.id,
    uuid: rawJob.uuid,
    companyName: rawJob.companyName || rawJob.company || "Unknown company",
    jobTitle: rawJob.jobTitle || rawJob.title || rawJob.designation || "Untitled role",
    location: rawJob.location || "",
    jobApplyBy: rawJob.jobApplyBy || rawJob.jobApplyByTimestamp || rawJob.applyBy || "",
    jobStatus: rawJob.jobStatus || rawJob.status || "",
    isEligible: rawJob.isEligible !== undefined ? Boolean(rawJob.isEligible) : (rawJob.eligible !== undefined ? Boolean(rawJob.eligible) : true),
    isEligibleNotApplied: rawJob.isEligibleNotApplied !== undefined ? Boolean(rawJob.isEligibleNotApplied) : (rawJob.eligibleNotApplied !== undefined ? Boolean(rawJob.eligibleNotApplied) : true),
    isApplied: Boolean(rawJob.isApplied || rawJob.applied),
    url: jobUrl(rawJob),
  };
}

export function normalizeJobs(rawJobs) {
  const seenIds = new Set();
  const out = [];
  for (const raw of rawJobs) {
    const normalized = normalizeJob(raw);
    if (!normalized) continue;
    // De-dupe within a single fetch (pagination overlap, etc.)
    if (seenIds.has(normalized.uniqueId)) continue;
    seenIds.add(normalized.uniqueId);
    out.push(normalized);
  }
  return out;
}

/** Phase 1 eligibility rule — see README section 8, easy to relax later. */
export function filterEligible(jobs) {
  return jobs.filter((job) => {
    if (job.isApplied) return false;
    if (CONFIG.REQUIRE_ELIGIBLE && !job.isEligible) return false;
    if (CONFIG.REQUIRE_NOT_APPLIED && !job.isEligibleNotApplied) return false;
    return true;
  });
}

/** Returns the subset of `jobs` whose uniqueId is not in `seenIds`. */
export function diffNewJobs(jobs, seenIdSet) {
  return jobs.filter((job) => !seenIdSet.has(job.uniqueId));
}

/** Parses any raw deadline format into a structured deadline object. */
export function parseDeadline(raw, referenceDate = new Date()) {
  if (!raw) {
    return { date: null, hasTime: false, isExpired: false, diffMs: null, hoursLeft: null, daysLeft: null };
  }

  let d = null;
  let hasTime = false;

  if (typeof raw === "number") {
    const ms = raw < 1e11 ? raw * 1000 : raw;
    d = new Date(ms);
    hasTime = true;
  } else if (typeof raw === "string") {
    const s = raw.trim();
    if (/^\d{10,13}$/.test(s)) {
      const num = Number(s);
      const ms = num < 1e11 ? num * 1000 : num;
      d = new Date(ms);
      hasTime = true;
    } else {
      hasTime = /\d{1,2}:\d{2}/.test(s);
      const normalized = s.includes("T") ? s : s.replace(" ", "T");
      d = new Date(normalized);
      if (isNaN(d.getTime())) {
        d = new Date(s);
      }
    }
  } else if (raw instanceof Date) {
    d = raw;
    hasTime = true;
  }

  if (!d || isNaN(d.getTime())) {
    return { date: null, hasTime: false, isExpired: false, diffMs: null, hoursLeft: null, daysLeft: null };
  }

  const nowMs = referenceDate.getTime();
  const diffMs = d.getTime() - nowMs;
  const isExpired = diffMs <= 0;
  const hoursLeft = diffMs / (1000 * 60 * 60);
  const daysLeft = diffMs / (1000 * 60 * 60 * 24);

  return {
    date: d,
    hasTime,
    isExpired,
    diffMs,
    hoursLeft,
    daysLeft,
  };
}

/** Urgency level: "critical" (<24h), "approaching" (<3d), "normal" (>3d), "none" (expired/no deadline). */
export function getDeadlineUrgency(deadlineInfo) {
  if (!deadlineInfo || !deadlineInfo.date || deadlineInfo.isExpired) {
    return "none";
  }
  if (deadlineInfo.hoursLeft <= 24) {
    return "critical";
  }
  if (deadlineInfo.daysLeft <= 3) {
    return "approaching";
  }
  return "normal";
}

/** Human-friendly countdown or status. */
export function formatRemainingTime(deadlineInfo) {
  if (!deadlineInfo || !deadlineInfo.date) {
    return "No deadline";
  }
  if (deadlineInfo.isExpired) {
    return "Closed";
  }

  const totalMinutes = Math.round(deadlineInfo.diffMs / 60000);
  if (totalMinutes < 60) {
    const mins = Math.max(1, totalMinutes);
    return `Closes in ${mins} ${mins === 1 ? "min" : "mins"}`;
  }

  const hours = Math.round(deadlineInfo.hoursLeft);
  if (hours < 24) {
    return `Closes in ${hours} ${hours === 1 ? "hour" : "hours"}`;
  }

  const days = Math.round(deadlineInfo.daysLeft);
  if (days === 1) {
    return "Closes tomorrow";
  }
  return `Closes in ${days} days`;
}

/** Sorts jobs so active nearest deadlines appear first. */
export function sortJobsByDeadline(jobs, referenceDate = new Date()) {
  return [...jobs].sort((a, b) => {
    const deadA = parseDeadline(a.jobApplyBy, referenceDate);
    const deadB = parseDeadline(b.jobApplyBy, referenceDate);

    const aActive = deadA.date && !deadA.isExpired;
    const bActive = deadB.date && !deadB.isExpired;

    if (aActive && bActive) {
      return deadA.diffMs - deadB.diffMs;
    }
    if (aActive) return -1;
    if (bActive) return 1;

    const aHasNoDeadline = !deadA.date;
    const bHasNoDeadline = !deadB.date;
    if (aHasNoDeadline && !bHasNoDeadline) return -1;
    if (!aHasNoDeadline && bHasNoDeadline) return 1;

    return 0;
  });
}

/** Preference filter matching across title, company, location, type, and salary. */
export function matchesPreferences(job, preferences) {
  if (!preferences || typeof preferences !== "object") return true;

  const {
    keywords = [],
    locations = [],
    jobTypes = [],
    minSalary = "",
    excludedCompanies = [],
  } = preferences;

  const title = (job.jobTitle || "").toLowerCase();
  const company = (job.companyName || "").toLowerCase();
  const location = (job.location || "").toLowerCase();
  const status = (job.jobStatus || "").toLowerCase();
  const desc = (job.jobDescription || job.description || "").toLowerCase();
  const salaryText = (job.salary || job.stipend || job.ctc || "").toLowerCase();

  const fullSearchText = `${title} ${company} ${location} ${status} ${desc} ${salaryText}`;

  // 1. Excluded companies
  if (Array.isArray(excludedCompanies) && excludedCompanies.length > 0) {
    for (const raw of excludedCompanies) {
      const excluded = String(raw).trim().toLowerCase();
      if (excluded && (company.includes(excluded) || title.includes(excluded))) {
        return false;
      }
    }
  }

  // 2. Preferred roles / keywords
  if (Array.isArray(keywords) && keywords.length > 0) {
    const validKeywords = keywords.map((k) => String(k).trim().toLowerCase()).filter(Boolean);
    if (validKeywords.length > 0) {
      const hasMatch = validKeywords.some((kw) => fullSearchText.includes(kw));
      if (!hasMatch) return false;
    }
  }

  // 3. Preferred locations
  if (Array.isArray(locations) && locations.length > 0) {
    const validLocations = locations.map((l) => String(l).trim().toLowerCase()).filter(Boolean);
    if (validLocations.length > 0) {
      const hasMatch = validLocations.some((l) => location.includes(l) || fullSearchText.includes(l));
      if (!hasMatch) return false;
    }
  }

  // 4. Job types
  if (Array.isArray(jobTypes) && jobTypes.length > 0) {
    const validTypes = jobTypes.map((t) => String(t).trim().toLowerCase()).filter(Boolean);
    if (validTypes.length > 0) {
      const hasMatch = validTypes.some((type) => {
        if (type.includes("intern")) {
          return fullSearchText.includes("intern") || fullSearchText.includes("stipend");
        }
        if (type.includes("full")) {
          return fullSearchText.includes("full time") || fullSearchText.includes("full-time") || fullSearchText.includes("permanent") || fullSearchText.includes("fte");
        }
        if (type.includes("part")) {
          return fullSearchText.includes("part time") || fullSearchText.includes("part-time");
        }
        return fullSearchText.includes(type);
      });
      if (!hasMatch) return false;
    }
  }

  // 5. Minimum salary / stipend
  if (minSalary && String(minSalary).trim()) {
    const minVal = parseFloat(String(minSalary).replace(/[^0-9.]/g, ""));
    if (!isNaN(minVal) && minVal > 0) {
      const numMatches = fullSearchText.match(/(\d+(\.\d+)?)\s*(l|lpa|k|pm|\/month)?/gi);
      if (numMatches && numMatches.length > 0) {
        let maxFound = 0;
        for (const m of numMatches) {
          const num = parseFloat(m.replace(/[^0-9.]/g, ""));
          const lower = m.toLowerCase();
          let parsedVal = num;
          if (lower.includes("l")) parsedVal = num * 100000;
          else if (lower.includes("k")) parsedVal = num * 1000;
          if (parsedVal > maxFound) maxFound = parsedVal;
        }
        const normalizedMin = minVal < 100 ? minVal * 100000 : minVal;
        if (maxFound > 0 && maxFound < normalizedMin) {
          return false;
        }
      }
    }
  }

  return true;
}

function pad(num) {
  return String(num).padStart(2, "0");
}

function formatUtcDate(date) {
  return (
    date.getUTCFullYear() +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    "T" +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    "Z"
  );
}

function formatDateOnly(date) {
  return (
    date.getFullYear() +
    pad(date.getMonth() + 1) +
    pad(date.getDate())
  );
}

function escapeIcsText(str) {
  if (!str) return "";
  return String(str)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/** Generates a standards-compliant .ics (iCalendar) calendar file string. */
export function generateIcsCalendar(job) {
  const deadlineInfo = parseDeadline(job.jobApplyBy);
  if (!deadlineInfo.date) {
    return null;
  }

  const now = new Date();
  const dtStamp = formatUtcDate(now);
  const rawId = (job.uniqueId || Date.now()).toString();
  const uid = `${rawId.replace(/[^a-zA-Z0-9_-]/g, "")}@haveloc-monitor`;
  const summary = escapeIcsText(`Apply: ${job.companyName || "Company"} — ${job.jobTitle || "Job Role"}`);
  const location = escapeIcsText(job.location || "");
  const url = job.url || jobUrl(job) || CONFIG.JOBS_PAGE_URL;

  const descLines = [
    `Company: ${job.companyName || "N/A"}`,
    `Role: ${job.jobTitle || "N/A"}`,
    job.location ? `Location: ${job.location}` : null,
    job.jobApplyBy ? `Apply By: ${job.jobApplyBy}` : null,
    `Application Link: ${url}`,
    job.jobDescription ? `\nDetails: ${job.jobDescription}` : null,
  ].filter(Boolean);

  const description = escapeIcsText(descLines.join("\n"));

  let dateLines = "";
  if (deadlineInfo.hasTime) {
    const end = deadlineInfo.date;
    const start = new Date(end.getTime() - 60 * 60 * 1000);
    dateLines = [
      `DTSTART:${formatUtcDate(start)}`,
      `DTEND:${formatUtcDate(end)}`,
    ].join("\r\n");
  } else {
    const dateStr = formatDateOnly(deadlineInfo.date);
    const nextDay = new Date(deadlineInfo.date.getTime() + 24 * 60 * 60 * 1000);
    const nextDayStr = formatDateOnly(nextDay);
    dateLines = [
      `DTSTART;VALUE=DATE:${dateStr}`,
      `DTEND;VALUE=DATE:${nextDayStr}`,
    ].join("\r\n");
  }

  const icsLines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Haveloc Placement Monitor//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${dtStamp}`,
    dateLines,
    `SUMMARY:${summary}`,
    location ? `LOCATION:${location}` : null,
    `DESCRIPTION:${description}`,
    `URL:${url}`,
    "STATUS:CONFIRMED",
    "TRANSP:OPAQUE",
    "END:VEVENT",
    "END:VCALENDAR",
  ].filter(Boolean);

  return icsLines.join("\r\n");
}

export function formatJobForDisplay(job, preferences = null) {
  const deadlineInfo = parseDeadline(job.jobApplyBy);
  const urgency = getDeadlineUrgency(deadlineInfo);
  const remainingText = formatRemainingTime(deadlineInfo);
  const isMatch = matchesPreferences(job, preferences);

  return {
    ...job,
    deadlineInfo,
    urgency,
    remainingText,
    isMatch,
    hasDeadline: Boolean(deadlineInfo.date),
  };
}
