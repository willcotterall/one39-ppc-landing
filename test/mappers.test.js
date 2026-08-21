/**
 * Regression tests for the webhook's pure functions.
 *
 * Run: node test/mappers.test.js
 *
 * These exist because the 2026-08-20 investigation found two silent
 * value-fabrication bugs and one ordering bug that unit tests would have caught
 * instantly, and because the webhook cannot be exercised end to end without
 * writing a junk row to a client's live board.
 *
 * The functions under test are pure and live inside a Vercel handler module, so
 * we extract them from source rather than restructuring the deployed file.
 */

const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "api", "ghl-webhook.js"), "utf8");

/** Slice a top-level `function name(...) { ... }` out of the source by brace matching. */
function fnSource(name) {
  const start = SRC.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`could not find function ${name}`);
  let depth = 0, i = SRC.indexOf("{", start);
  for (; i < SRC.length; i++) {
    if (SRC[i] === "{") depth++;
    else if (SRC[i] === "}") { depth--; if (depth === 0) break; }
  }
  return SRC.slice(start, i + 1);
}

/** Slice a `const NAME = ...;` declaration out of the source. */
function constSource(name) {
  const start = SRC.indexOf(`const ${name}`);
  if (start === -1) throw new Error(`could not find const ${name}`);
  const end = SRC.indexOf("]);", start);
  return SRC.slice(start, end + 3);
}

/** Build one sandbox from several source fragments and return the named export. */
function build(fragments, exported) {
  // eslint-disable-next-line no-new-func
  return new Function(`${fragments.join("\n")}\nreturn ${exported};`)();
}

const mapTimeline   = build([fnSource("mapTimeline")], "mapTimeline");
const mapAttendance = build([fnSource("mapAttendance")], "mapAttendance");
const pickField     = build([fnSource("pickField")], "pickField");
// deepFind closes over normKey and DEEP_SKIP_KEYS, so all three go in together.
const deepFind      = build(
  [fnSource("normKey"), constSource("DEEP_SKIP_KEYS"), fnSource("deepFind")],
  "deepFind",
);

let failed = 0;
function eq(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { failed++; console.log(`  FAIL ${label}\n       expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
  else console.log(`  ok   ${label}`);
}

// ── The five values GHL's picklist can actually produce ─────────────────────
// Source: the landing page <select>, cross-checked against 388 real contacts.
console.log("\n1. Every real GHL timeline value maps");
eq(mapTimeline("ASAP"), "ASAP", '"ASAP"');
eq(mapTimeline("1 - 3 Months"), "1 - 3 months", '"1 - 3 Months"');
eq(mapTimeline("3 - 6 Months"), "3 - 6 months", '"3 - 6 Months"');
eq(mapTimeline("6+ Months"), "6 - 12 months", '"6+ Months"  <- the Shands lead');
eq(mapTimeline("Just Exploring"), "Someday", '"Just Exploring"');

console.log("\n2. Ordering bugs the review caught in the proposed rewrite");
eq(mapTimeline("Within 3 months"), "1 - 3 months", '"Within 3 months" is not 3-6');
eq(mapTimeline("next month"), "1 - 3 months", '"next month"');
eq(mapTimeline("a few weeks"), "1 - 3 months", '"a few weeks"');
eq(mapTimeline("next quarter"), "3 - 6 months", '"next quarter"');
eq(mapTimeline("next year"), "6 - 12 months", '"next year"');
eq(mapTimeline("just exploring, 6 months maybe"), "Someday", "qualitative beats numeric");

console.log("\n3. mapTimeline never fabricates from a non-duration");
eq(mapTimeline("Q1 2027"), "Unknown", '"Q1 2027" is not a timeline');
eq(mapTimeline(""), "Unknown", "empty");
eq(mapTimeline(null), "Unknown", "null");
eq(mapTimeline(undefined), "Unknown", "undefined");
eq(mapTimeline("2026-08-20T23:33:13.230Z"), "Unknown", "timestamp");

console.log("\n4. Form-encoding mangling still resolves");
eq(mapTimeline("1+-+3+Months"), "1 - 3 months", '"1+-+3+Months"');
eq(mapTimeline("3+-+6+Months"), "3 - 6 months", '"3+-+6+Months" is not 6-12');
eq(mapTimeline("6%2B Months"), "6 - 12 months", '"6%2B Months"');

// ── Attendance ──────────────────────────────────────────────────────────────
console.log("\n5. Every real GHL attendance value maps");
eq(mapAttendance("Under 200"), "< 200", '"Under 200"');
eq(mapAttendance("200 - 499"), "200 - 499", '"200 - 499"  <- the Kervens lead');
eq(mapAttendance("500 - 999"), "500 - 999", '"500 - 999"');
eq(mapAttendance("1,000 - 2,499"), "1,000 - 2,499", '"1,000 - 2,499"  <- the Shands lead');
eq(mapAttendance("2,500 - 4,999"), "2,500+", '"2,500 - 4,999"');
eq(mapAttendance("5,000+"), "2,500+", '"5,000+"');
eq(mapAttendance("Under 500"), "200 - 499", '"Under 500" legacy, never 500-999');

console.log("\n6. mapAttendance never fabricates a congregation size");
eq(mapAttendance("2026-08-20T23:33:13.230Z"), "Unknown", "ISO timestamp was -> 1,000 - 2,499");
eq(mapAttendance("2026"), "Unknown", "bare year was -> 1,000 - 2,499");
eq(mapAttendance("5551234567"), "Unknown", "phone was -> 2,500+");
eq(mapAttendance("will@tentmakerscreative.co"), "Unknown", "email address");
eq(mapAttendance("https://example.com/1200"), "Unknown", "url");
eq(mapAttendance(""), "Unknown", "empty");
eq(mapAttendance(null), "Unknown", "null");

// ── pickField: the dot bug ──────────────────────────────────────────────────
console.log("\n7. pickField reads GHL's dotted field keys as FLAT keys");
eq(pickField({ "contact.ideal_timeline": "6+ Months" }, "timeline", "contact.ideal_timeline"),
   "6+ Months", "flat dotted key (this is the bug that broke timeline)");
eq(pickField({ contact: { ideal_timeline: "6+ Months" } }, "contact.ideal_timeline"),
   "6+ Months", "nested path still works");
eq(pickField({ attendance: "200 - 499" }, "attendance"), "200 - 499", "plain flat key");
eq(pickField({ a: 1200 }, "a"), "1200", "numbers coerce");
eq(pickField({}, "nope"), "", "missing -> empty string");
eq(pickField({ x: "  " }, "x"), "", "whitespace-only -> empty string");

console.log("\n8. pickField alias precedence is unchanged");
eq(pickField({ position: "First", role: "Second" }, "position", "role"), "First", "first alias wins");
eq(pickField({ role: "Second" }, "position", "role"), "Second", "falls through");

// ── deepFind scoping ────────────────────────────────────────────────────────
console.log("\n9. deepFind finds hand-authored key spellings");
eq(deepFind({ "Weekly Attendance": "200 - 499" }, ["weekly_attendance"]), "200 - 499", "Title Case with space");
eq(deepFind({ weeklyAttendance: "200 - 499" }, ["weekly_attendance"]), "200 - 499", "camelCase");
eq(deepFind({ contact: { "weekly-attendance": "200 - 499" } }, ["weekly_attendance"]), "200 - 499", "nested, hyphenated");

console.log("\n10. deepFind refuses to read someone else's record");
eq(deepFind({ location: { church_name: "Tentmakers HQ" } }, ["church_name"]), "",
   "skips location subtree (would become the church)");
eq(deepFind({ user: { position: "Staffing Manager" } }, ["position"]), "",
   "skips user subtree (would become the role)");
eq(deepFind({ assignedTo: { church: "Wrong Church" } }, ["church"]), "", "skips assignedTo");
eq(deepFind({ contact: { church_name: "Real Church" }, location: { church_name: "Wrong" } }, ["church_name"]),
   "Real Church", "prefers the contact subtree");

console.log("\n" + "=".repeat(58));
if (failed) { console.log(`${failed} FAILED`); process.exit(1); }
console.log("all mapper + reader tests passed");
