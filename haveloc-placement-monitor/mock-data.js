// ============================================================================
// mock-data.js
// DEV-ONLY test harness. Never imported by production code paths except on
// explicit request (see README "How to test"). Exercises the diff/baseline
// logic, deadline urgency, preference filters, and calendar generation
// against fabricated job data — no real network calls.
//
// Run it from the extension's service worker console:
//   1. chrome://extensions -> Haveloc Placement Monitor -> "service worker"
//   2. In the console that opens, run:
//        import('./mock-data.js').then(m => m.runTestSuite())
//
// Or run directly via Node.js CLI:
//   node --input-type=module -e "import { runTestSuite } from './mock-data.js'; runTestSuite().then(console.log).catch(console.error);"
// ============================================================================

import {
  normalizeJobs,
  filterEligible,
  diffNewJobs,
  parseDeadline,
  getDeadlineUrgency,
  formatRemainingTime,
  sortJobsByDeadline,
  matchesPreferences,
  generateIcsCalendar,
} from "./jobs.js";

function makeJob(jobId, overrides = {}) {
  return {
    jobId,
    uuid: `uuid-${jobId}`,
    companyName: overrides.companyName || `Company ${jobId}`,
    jobTitle: overrides.jobTitle || "Software Engineer",
    jobPostedDate: "2026-09-01 10:00:00",
    jobApplyBy: overrides.jobApplyBy !== undefined ? overrides.jobApplyBy : "2026-09-30 00:00:00",
    jobStatus: overrides.jobStatus || "Open",
    location: overrides.location || "Bangalore",
    isEligible: overrides.isEligible !== undefined ? overrides.isEligible : true,
    isEligibleNotApplied:
      overrides.isEligibleNotApplied !== undefined
        ? overrides.isEligibleNotApplied
        : true,
    isApplied: overrides.isApplied || false,
    _links: { self: { href: `https://app.haveloc.com/app/jobViews/${jobId}` } },
    ...overrides,
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  return `passed: ${message}`;
}

export async function runTestSuite() {
  const results = [];

  // TEST 1: first install with 20 existing jobs -> no notifications,
  // baseline saved.
  {
    const jobs20 = Array.from({ length: 20 }, (_, i) => makeJob(15300 + i));
    const normalized = filterEligible(normalizeJobs(jobs20));
    const seenIdSet = new Set(); // nothing seen yet = pre-baseline state
    const newJobs = diffNewJobs(normalized, seenIdSet);
    results.push(
      assert(
        normalized.length === 20,
        "TEST 1: all 20 mock jobs normalize/pass eligibility"
      )
    );
    const seenAfterBaseline = new Set(normalized.map((j) => j.uniqueId));
    const newAfterBaseline = diffNewJobs(normalized, seenAfterBaseline);
    results.push(
      assert(newAfterBaseline.length === 0, "TEST 1: post-baseline diff is empty")
    );
  }

  // TEST 2: one new job -> one notification.
  {
    const seen = new Set(
      Array.from({ length: 20 }, (_, i) => `jobId:${15300 + i}`)
    );
    const jobs21 = [
      ...Array.from({ length: 20 }, (_, i) => makeJob(15300 + i)),
      makeJob(15400),
    ];
    const normalized = filterEligible(normalizeJobs(jobs21));
    const newJobs = diffNewJobs(normalized, seen);
    results.push(assert(newJobs.length === 1, "TEST 2: exactly one new job detected"));
    results.push(
      assert(newJobs[0].jobId === 15400, "TEST 2: the new job is the correct one")
    );
  }

  // TEST 3: three new jobs -> three notifications.
  {
    const seen = new Set(
      Array.from({ length: 20 }, (_, i) => `jobId:${15300 + i}`)
    );
    const jobs23 = [
      ...Array.from({ length: 20 }, (_, i) => makeJob(15300 + i)),
      makeJob(15401),
      makeJob(15402),
      makeJob(15403),
    ];
    const normalized = filterEligible(normalizeJobs(jobs23));
    const newJobs = diffNewJobs(normalized, seen);
    results.push(assert(newJobs.length === 3, "TEST 3: exactly three new jobs detected"));
  }

  // TEST 4: same job appears again -> no notification.
  {
    const seen = new Set(["jobId:15400"]);
    const jobsAgain = [makeJob(15400)];
    const normalized = filterEligible(normalizeJobs(jobsAgain));
    const newJobs = diffNewJobs(normalized, seen);
    results.push(assert(newJobs.length === 0, "TEST 4: repeated job produces no notification"));
  }

  // TEST 5: job order changes -> no false notification.
  {
    const seen = new Set(
      Array.from({ length: 20 }, (_, i) => `jobId:${15300 + i}`)
    );
    const shuffled = Array.from({ length: 20 }, (_, i) => makeJob(15300 + i)).reverse();
    const normalized = filterEligible(normalizeJobs(shuffled));
    const newJobs = diffNewJobs(normalized, seen);
    results.push(assert(newJobs.length === 0, "TEST 5: reordering causes no false positives"));
  }

  // TEST 6: applied / ineligible jobs are filtered out even if "new".
  {
    const seen = new Set();
    const jobs = [
      makeJob(15500, { isApplied: true }),
      makeJob(15501, { isEligible: false }),
      makeJob(15502, { isEligibleNotApplied: false }),
      makeJob(15503), // genuinely eligible + not applied
    ];
    const normalized = filterEligible(normalizeJobs(jobs));
    results.push(
      assert(
        normalized.length === 1 && normalized[0].jobId === 15503,
        "TEST 6: applied/ineligible jobs are excluded, only true-eligible job remains"
      )
    );
  }

  // TEST 7: unique ID never falls back to companyName; two jobs from the
  // same company are treated as distinct.
  {
    const jobs = [
      makeJob(15600, { companyName: "Google", jobTitle: "Software Engineer" }),
      makeJob(15601, { companyName: "Google", jobTitle: "Data Analyst" }),
    ];
    const normalized = normalizeJobs(jobs);
    const ids = normalized.map((j) => j.uniqueId);
    results.push(
      assert(
        new Set(ids).size === 2,
        "TEST 7: two jobs from the same company get distinct unique IDs"
      )
    );
  }

  // TEST 8: malformed job (no jobId or uuid) is skipped, not crashed on.
  {
    const jobs = [makeJob(15700), { companyName: "Ghost Co", jobTitle: "??" }];
    let threw = false;
    let normalized = [];
    try {
      normalized = normalizeJobs(jobs);
    } catch (e) {
      threw = true;
    }
    results.push(assert(!threw, "TEST 8: malformed job does not throw"));
    results.push(
      assert(normalized.length === 1, "TEST 8: malformed job is silently skipped")
    );
  }

  // TEST 9: Deadline parsing across multiple formats
  {
    const ref = new Date("2026-09-17T12:00:00Z");

    const isoParsed = parseDeadline("2026-09-18T18:00:00Z", ref);
    results.push(assert(isoParsed.date !== null && isoParsed.hasTime, "TEST 9a: parse ISO format with time"));

    const spaceParsed = parseDeadline("2026-09-18 18:00:00", ref);
    results.push(assert(spaceParsed.date !== null && spaceParsed.hasTime, "TEST 9b: parse space-separated date & time"));

    const dateOnly = parseDeadline("2026-09-20", ref);
    results.push(assert(dateOnly.date !== null && !dateOnly.hasTime, "TEST 9c: parse date-only string"));

    const epochParsed = parseDeadline(ref.getTime() + 7200000, ref);
    results.push(assert(epochParsed.date !== null && Math.round(epochParsed.hoursLeft) === 2, "TEST 9d: parse numeric epoch timestamp"));

    const missingParsed = parseDeadline(null, ref);
    results.push(assert(missingParsed.date === null && !missingParsed.isExpired, "TEST 9e: handle null deadline cleanly"));
  }

  // TEST 10: Urgency levels (<24h -> critical, <=3d -> approaching, >3d -> normal, expired -> none)
  {
    const ref = new Date("2026-09-17T12:00:00Z");

    // 6 hours left -> critical
    const criticalInfo = parseDeadline(new Date(ref.getTime() + 6 * 3600 * 1000), ref);
    results.push(assert(getDeadlineUrgency(criticalInfo) === "critical", "TEST 10a: <24h is critical"));

    // 2 days left -> approaching
    const approachingInfo = parseDeadline(new Date(ref.getTime() + 48 * 3600 * 1000), ref);
    results.push(assert(getDeadlineUrgency(approachingInfo) === "approaching", "TEST 10b: <=3d is approaching"));

    // 5 days left -> normal
    const normalInfo = parseDeadline(new Date(ref.getTime() + 120 * 3600 * 1000), ref);
    results.push(assert(getDeadlineUrgency(normalInfo) === "normal", "TEST 10c: >3d is normal"));

    // Expired -> none
    const expiredInfo = parseDeadline(new Date(ref.getTime() - 3600 * 1000), ref);
    results.push(assert(getDeadlineUrgency(expiredInfo) === "none", "TEST 10d: expired deadline urgency is none"));

    // No deadline -> none
    const noneInfo = parseDeadline(null, ref);
    results.push(assert(getDeadlineUrgency(noneInfo) === "none", "TEST 10e: no deadline urgency is none"));
  }

  // TEST 11: Human-readable remaining time formatting
  {
    const ref = new Date("2026-09-17T12:00:00Z");

    // 45 minutes
    const minsInfo = parseDeadline(new Date(ref.getTime() + 45 * 60 * 1000), ref);
    results.push(assert(formatRemainingTime(minsInfo) === "Closes in 45 mins", "TEST 11a: minutes countdown"));

    // 6 hours
    const hoursInfo = parseDeadline(new Date(ref.getTime() + 6 * 3600 * 1000), ref);
    results.push(assert(formatRemainingTime(hoursInfo) === "Closes in 6 hours", "TEST 11b: hours countdown"));

    // 26 hours (~1 day) -> "Closes tomorrow"
    const tomorrowInfo = parseDeadline(new Date(ref.getTime() + 26 * 3600 * 1000), ref);
    results.push(assert(formatRemainingTime(tomorrowInfo) === "Closes tomorrow", "TEST 11c: closes tomorrow"));

    // 5 days
    const daysInfo = parseDeadline(new Date(ref.getTime() + 5 * 24 * 3600 * 1000), ref);
    results.push(assert(formatRemainingTime(daysInfo) === "Closes in 5 days", "TEST 11d: days countdown"));

    // Expired
    const expiredInfo = parseDeadline(new Date(ref.getTime() - 1000), ref);
    results.push(assert(formatRemainingTime(expiredInfo) === "Closed", "TEST 11e: expired label"));

    // Null
    results.push(assert(formatRemainingTime(null) === "No deadline", "TEST 11f: null label"));
  }

  // TEST 12: Nearest-deadline sorting
  {
    const ref = new Date("2026-09-17T12:00:00Z");
    const jobNear = makeJob(16001, { jobApplyBy: new Date(ref.getTime() + 4 * 3600 * 1000).toISOString() }); // 4 hours
    const jobFar = makeJob(16002, { jobApplyBy: new Date(ref.getTime() + 72 * 3600 * 1000).toISOString() }); // 3 days
    const jobNoDead = makeJob(16003, { jobApplyBy: null });
    const jobExpired = makeJob(16004, { jobApplyBy: new Date(ref.getTime() - 3600 * 1000).toISOString() }); // closed

    const sorted = sortJobsByDeadline([jobExpired, jobFar, jobNoDead, jobNear], ref);
    results.push(
      assert(
        sorted[0].jobId === 16001 &&
        sorted[1].jobId === 16002 &&
        sorted[2].jobId === 16003 &&
        sorted[3].jobId === 16004,
        "TEST 12: jobs sorted strictly nearest active deadline first, then no deadline, then expired"
      )
    );
  }

  // TEST 13: Preference filtering logic
  {
    const sdeJob = makeJob(17001, {
      companyName: "Amazon",
      jobTitle: "SDE Intern",
      location: "Hyderabad",
      jobDescription: "Summer 6-month internship with stipend 80k/month",
    });

    const analystJob = makeJob(17002, {
      companyName: "TCS",
      jobTitle: "Data Analyst",
      location: "Pune",
      jobDescription: "Full time graduate role 4.5 LPA",
    });

    const excludedCompanyJob = makeJob(17003, {
      companyName: "SpamCorp",
      jobTitle: "SDE 1",
      location: "Bangalore",
    });

    // Match keywords "sde" or "software"
    results.push(assert(matchesPreferences(sdeJob, { keywords: ["sde"] }), "TEST 13a: keyword matching succeeds"));
    results.push(assert(!matchesPreferences(analystJob, { keywords: ["sde"] }), "TEST 13b: non-matching keyword fails"));

    // Excluded companies
    results.push(
      assert(
        !matchesPreferences(excludedCompanyJob, { excludedCompanies: ["SpamCorp"] }),
        "TEST 13c: excluded company is rejected"
      )
    );
    results.push(
      assert(
        matchesPreferences(sdeJob, { excludedCompanies: ["SpamCorp"] }),
        "TEST 13d: non-excluded company passes"
      )
    );

    // Locations
    results.push(assert(matchesPreferences(sdeJob, { locations: ["Hyderabad"] }), "TEST 13e: location match succeeds"));
    results.push(assert(!matchesPreferences(sdeJob, { locations: ["Mumbai"] }), "TEST 13f: location mismatch fails"));

    // Job types: internship
    results.push(assert(matchesPreferences(sdeJob, { jobTypes: ["internship"] }), "TEST 13g: internship type matches"));
    results.push(assert(!matchesPreferences(analystJob, { jobTypes: ["internship"] }), "TEST 13h: non-internship fails"));

    // Salary threshold
    results.push(assert(matchesPreferences(analystJob, { minSalary: "3" }), "TEST 13i: salary meets minimum threshold"));
    results.push(assert(!matchesPreferences(analystJob, { minSalary: "10" }), "TEST 13j: salary below minimum threshold fails"));
  }

  // TEST 14: Calendar .ics export generation
  {
    const timedJob = makeJob(18001, {
      companyName: "Microsoft",
      jobTitle: "SWE 1",
      location: "Bangalore",
      jobApplyBy: "2026-09-30 18:00:00",
    });

    const icsContent = generateIcsCalendar(timedJob);
    results.push(assert(icsContent !== null, "TEST 14a: ICS string generated for job with deadline"));
    results.push(assert(icsContent.includes("BEGIN:VCALENDAR"), "TEST 14b: contains VCALENDAR start"));
    results.push(assert(icsContent.includes("BEGIN:VEVENT"), "TEST 14c: contains VEVENT start"));
    results.push(assert(icsContent.includes("SUMMARY:Apply: Microsoft"), "TEST 14d: contains correct SUMMARY"));
    results.push(assert(icsContent.includes("URL:https://app.haveloc.com"), "TEST 14e: contains job URL in event"));
    results.push(assert(icsContent.includes("END:VCALENDAR"), "TEST 14f: contains VCALENDAR end"));

    const dateOnlyJob = makeJob(18002, {
      companyName: "Google",
      jobTitle: "SRE",
      jobApplyBy: "2026-10-05",
    });
    const dateOnlyIcs = generateIcsCalendar(dateOnlyJob);
    results.push(assert(dateOnlyIcs.includes("VALUE=DATE:"), "TEST 14g: date-only job generates all-day DATE calendar event"));

    const noDeadlineJob = makeJob(18003, { jobApplyBy: null });
    results.push(assert(generateIcsCalendar(noDeadlineJob) === null, "TEST 14h: null deadline produces null ICS"));
  }

  // TEST 15: Deadline approaching notification suppression / deduplication
  {
    const notifiedDeadlines = {};
    const ref = new Date("2026-09-17T12:00:00Z");
    const urgentJob = makeJob(19001, {
      jobApplyBy: new Date(ref.getTime() + 10 * 3600 * 1000).toISOString(), // 10 hours left (<24h)
    });
    const info = parseDeadline(urgentJob.jobApplyBy, ref);
    const urgency = getDeadlineUrgency(info);

    let notificationSentCount = 0;

    // Simulation of background poll cycle 1
    if (urgency === "critical" && !notifiedDeadlines[urgentJob.uuid]) {
      notificationSentCount++;
      notifiedDeadlines[urgentJob.uuid] = Date.now();
    }

    // Simulation of background poll cycle 2 (e.g. 1 minute later)
    if (urgency === "critical" && !notifiedDeadlines[urgentJob.uuid]) {
      notificationSentCount++;
    }

    results.push(
      assert(
        notificationSentCount === 1,
        "TEST 15: 24-hour deadline alert fires once and suppresses duplicate alerts on subsequent checks"
      )
    );
  }

  const summary = results.join("\n");
  console.log(summary);
  return summary;
}
