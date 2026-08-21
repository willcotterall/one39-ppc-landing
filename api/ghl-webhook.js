/**
 * GHL webhook receiver — creates Monday.com rows from GHL contact events.
 *
 * Deployed at: https://hire.one39.co/api/ghl-webhook
 *
 * Usage: configure a GHL Automation with a Custom Webhook action pointing to:
 *   https://hire.one39.co/api/ghl-webhook?secret=<WEBHOOK_SECRET>
 *
 * Typical trigger: "Contact Tag Added" with tag matching PPC (e.g. `ppc-ads`)
 * or "Contact Source Changed" filtered to PPC sources. GHL POSTs the contact
 * merge object; we dual-write to Client Contacts + Leads boards.
 *
 * 2026-08-05: FLIPPED from OLD boards to NEW two-board architecture.
 *   OLD Leads/Deals (3503945052)   → NEW Leads (18424840901)
 *   OLD Client Contacts (3503945069) → NEW Client Contacts (18424840911)
 * Columns remapped; no owner or Client Manager set on either write, so no
 * "assigned to me" notifications fire. New leads land in Fresh group ("topics")
 * for SM triage.
 *
 * No dependencies — pure Node.js serverless function (fetch is native ≥ Node 18).
 */

const MONDAY_API = "https://api.monday.com/v2";
const GHL_API = "https://services.leadconnectorhq.com";
const GHL_API_VERSION = "2021-07-28";

// GHL custom field IDs (verified via /locations/customFields query 2026-08-10).
// The webhook payload from GHL's Custom Webhook action sometimes omits customFields
// or sends them in a shape we can't parse. Fetching /contacts/{id} directly
// returns the full record with customFields as [{id, value}]. This guarantees
// role/church/attendance/timeline land on every Monday item.
const GHL_CF_POSITION   = "GEUd0b8wdH15F3Lx1URs";
const GHL_CF_CHURCH     = "w0sm9wpx7ODNrmJfqq9Q";
const GHL_CF_ATTENDANCE = "p4pYMUi5AsSoy6sGlH0w";
const GHL_CF_TIMELINE   = "H2R6Qkt2dDGICqv0SLRl";
const GHL_CF_LOCATION   = "YqPGLHhoyynXXf3bPfVs";

// A SECOND funnel writes to a parallel set of fields. Measured 2026-08-21 over
// 700 contacts: 20 have their church in "Name of organization" while Church
// Name is empty, 20 have the role in "what position do you want to hire?" with
// Position Hiring For empty, and 77 carry a Notes value the board never saw.
// Reading only the primary four silently threw all of that away.
const GHL_CF_ORG_NAME   = "MI2gVKP3HtCFzE0PPztw";  // "Name of organization"
const GHL_CF_ORG_TYPE   = "MSpojZudzGhuuIDyPFRo";  // "Type of organization"
const GHL_CF_WANT_HIRE  = "Or55TMbK7iXHtEXrDY50";  // "what position do you want to hire?"
const GHL_CF_JOB_TITLE  = "UroWlloe7OceSzfAu1SK";  // the SUBMITTER's own title — NOT the opening
const GHL_CF_NOTES      = "46Tu8iCoq2CKEgE3JrQE";  // "Notes"
const GHL_CF_ANYTHING   = "LSOie3i4OABlA7G9BlZB";  // "Anything else we should know before the call?"
const GHL_LOCATION_ID   = process.env.GHL_LOCATION_ID || "l9GVEA91SsaZzg0pNW61";

// RETRACTED 2026-08-20 evening. This block previously claimed the root cause was
// "Node's fetch sends no User-Agent, so Cloudflare 1010s every GHL call".
// BOTH halves are false, measured: Node's fetch always sends `user-agent: node`,
// and GHL returns 200 even with no UA at all. The only string observed to trigger
// 1010 is `Python-urllib/*` — which was the diagnostic script used that morning,
// never this function. Commit 20ef379 was therefore a no-op, which is exactly why
// the very next lead failed identically six hours later.
// Keep an honest, attributable UA so a future 1010 can actually be traced to us.
const GHL_UA = "One39-PPC-Webhook/1.0 (+https://hire.one39.co)";

function ghlHeaders(token) {
  return {
    "Authorization": `Bearer ${token}`,
    "Version": GHL_API_VERSION,
    "Accept": "application/json",
    "User-Agent": GHL_UA,
  };
}

/**
 * GET against GHL, retried with backoff.
 *
 * `isUsable` matters as much as the status code: a 200 carrying an empty
 * customFields array is indistinguishable from success to the old code, which
 * accepted it and never retried. That is the exact shape a read-after-write lag
 * takes, and the webhook fires seconds after the contact is created.
 *
 * `trace` is passed in per request, never module scope — this runs on Fluid
 * compute, where several leads share one Node process, so shared mutable state
 * would splice one lead's diagnostics into another lead's board row.
 */
async function ghlGet(url, token, label, isUsable = () => true, trace = []) {
  const delays = [400, 1200];
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, { headers: ghlHeaders(token) });
      if (r.ok) {
        const json = await r.json();
        if (isUsable(json)) { trace.push(`${label}:200:ok:a${attempt}`); return json; }
        trace.push(`${label}:200:NO_CF:a${attempt}`);
      } else {
        const snip = (await r.text().catch(() => "")).slice(0, 100);
        trace.push(`${label}:${r.status}:a${attempt}`);
        console.warn(`[ghl] ${label} HTTP ${r.status} ${snip}`);
      }
    } catch (e) {
      trace.push(`${label}:THREW:a${attempt}`);
      console.warn(`[ghl] ${label} threw: ${e.message}`);
    }
    if (attempt < 2) await new Promise(r => setTimeout(r, delays[attempt]));
  }
  return null;
}

/** True if a GHL response actually carries at least one custom field. */
function respHasCF(b) {
  const rec = b?.contact || (b?.contacts || [])[0] || b;
  return Array.isArray(rec?.customFields) && rec.customFields.length > 0;
}

/**
 * Fetch the full GHL contact record by ID. Guarantees customFields presence.
 * Requires GHL_TOKEN env var (Bearer). Returns null on failure.
 */
async function ghlFetchContact(contactId, trace = []) {
  if (!contactId) { trace.push("byId:SKIPPED_NO_ID"); return null; }
  const token = process.env.GHL_TOKEN;
  if (!token) { trace.push("byId:NO_TOKEN"); console.warn("[ghl] GHL_TOKEN env var not set — cannot enrich contact"); return null; }
  const body = await ghlGet(`${GHL_API}/contacts/${contactId}`, token, "byId", respHasCF, trace);
  if (!body) return null;
  return body.contact || body || null;
}

/** Read a specific customField value by id from a GHL contact record. */
function ghlGetCF(contact, cfId) {
  if (!contact || !Array.isArray(contact.customFields)) return null;
  const match = contact.customFields.find(f => f.id === cfId);
  const v = match?.value;
  if (v === undefined || v === null) return null;
  // Trim here rather than at each call site. Measured 2026-08-21: the second
  // funnel's values carry trailing spaces ("Elizabeth Baptist Church  "), which
  // were landing in the monday columns verbatim.
  if (typeof v === "string") { const t = v.trim(); return t === "" ? null : t; }
  return v;
}

/**
 * FALLBACK LOOKUP (added 2026-08-19). The contact-by-id fetch silently returns
 * a record without customFields in some cases (verified live: leads 8/17-8/19
 * all landed with church empty even though GHL held the value). Searching by
 * email hits a different endpoint that reliably returns customFields.
 * Returns the first matching contact or null.
 */
/**
 * LAST-RESORT LOOKUP by phone. Phone is required on both forms, so if the
 * payload's contact id and email are both unreadable — which is exactly what
 * broke this pipeline for weeks — this still finds the record. GHL's search
 * endpoint was measured working from Vercel 2026-08-21 (200, customFields
 * present, ~155ms).
 */
async function ghlFindContactByPhone(phone, trace = []) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.length < 10) { trace.push("byPhone:SKIPPED_NO_PHONE"); return null; }
  const token = process.env.GHL_TOKEN;
  if (!token) { trace.push("byPhone:NO_TOKEN"); return null; }
  const url = `${GHL_API}/contacts/?locationId=${GHL_LOCATION_ID}&query=${encodeURIComponent(digits.slice(-10))}`;
  const body = await ghlGet(url, token, "byPhone", respHasCF, trace);
  if (!body) return null;
  // Match on the last 10 digits so formatting differences cannot cause a
  // wrong-contact match. Never match on name.
  const hit = (body.contacts || []).find(c =>
    String(c.phone || "").replace(/\D/g, "").endsWith(digits.slice(-10))) || null;
  if (hit) console.log(`[ghl] phone fallback matched ${hit.id}`);
  return hit;
}

async function ghlFindContactByEmail(email, trace = []) {
  if (!email) { trace.push("byEmail:SKIPPED_NO_EMAIL"); return null; }
  const token = process.env.GHL_TOKEN;
  if (!token) { trace.push("byEmail:NO_TOKEN"); return null; }
  const url = `${GHL_API}/contacts/?locationId=${GHL_LOCATION_ID}&query=${encodeURIComponent(email)}`;
  const body = await ghlGet(url, token, "byEmail", respHasCF, trace);
  if (!body) return null;
  // GHL's `query=` is a SUBSTRING search, not an email filter — query="gmail.com"
  // returns everyone. Taking [0] could graft a stranger's church, role and
  // free-text notes onto this lead. Verify exactly, the way the phone twin does.
  const want = String(email).trim().toLowerCase();
  const hit = (body.contacts || []).find(
    c => String(c.email || "").trim().toLowerCase() === want) || null;
  if (hit) console.log(`[ghl] email-search fallback matched ${hit.id} (customFields: ${(hit.customFields || []).length})`);
  return hit;
}

/**
 * Detect obviously suspicious / low-quality leads via heuristics on the lead's
 * name and email. Returns a warning string if suspicious, else null.
 * Signals: inappropriate email prefixes, gibberish names, test strings, etc.
 */
function detectSuspicious(first, last, email, church) {
  const flags = [];
  const emailLower = (email || "").toLowerCase();
  const nameLower = `${first || ""} ${last || ""}`.toLowerCase().trim();
  const churchLower = (church || "").toLowerCase();

  // Inappropriate email tokens
  const badTokens = ["ballbusting", "porn", "sex", "fuck", "shit", "asshole", "cunt", "nigger", "test", "asdf", "qwerty", "spam", "trash", "garbage"];
  for (const t of badTokens) {
    if (emailLower.includes(t)) flags.push(`email contains "${t}"`);
    if (nameLower.includes(t)) flags.push(`name contains "${t}"`);
  }
  // Numeric-heavy email prefix (e.g., "user123456789@gmail.com")
  const emailPrefix = emailLower.split("@")[0] || "";
  if (/^\d{4,}$/.test(emailPrefix) || (/\d{6,}/.test(emailPrefix) && emailPrefix.length < 15)) {
    flags.push("email prefix is mostly digits");
  }
  // Gibberish name detection (consonant clusters, no vowels)
  if (nameLower && !/[aeiouy]/i.test(nameLower.replace(/\s/g, ""))) {
    flags.push("name has no vowels");
  }
  // Very short single-letter names
  if (first && first.length === 1 && last && last.length <= 2) {
    flags.push("name is suspiciously short");
  }
  // Church name looks like a test/placeholder
  if (churchLower.match(/^(test|asdf|xxx|zzz|abc|123)/i)) {
    flags.push(`church name looks like a placeholder: "${church}"`);
  }
  return flags.length ? flags : null;
}

/**
 * Use Anthropic + web_search to produce a REAL demographic writeup for a church.
 * Returns {demographic: string, city: string|null, state: string|null} or null on failure.
 * Requires ANTHROPIC_API_KEY env var. Budget: ~15-30s.
 *
 * This replaces the old "metadata dump" demographic. Now the Demographic column
 * describes the CHURCH itself — denomination, size, pastor tenure, culture, etc.
 */
async function anthropicEnrichChurch(church, city, state, role) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { console.warn("[anthropic] ANTHROPIC_API_KEY not set — skipping enrichment"); return null; }
  if (!church) return null;

  const locHint = [city, state].filter(Boolean).join(", ");
  const userPrompt = `Research this church and return a short demographic profile suitable for a pastoral search firm's CRM.

Church: ${church}${locHint ? ` (${locHint})` : ""}${role ? `\nOpen role: ${role}` : ""}

Use web_search to verify. Return valid JSON only, no prose wrapper:
{
  "demographic": "2-4 sentence description of the church: denomination, size, pastor + tenure, notable programs, culture. Ends with a source-verification note.",
  "city": "city name (empty string if unknown)",
  "state": "2-letter state code (empty string if unknown)"
}

Rules:
- Only fill city/state if you have 99% confidence from web search
- Demographic should be factual and specific, not generic
- If church cannot be verified online at all, return demographic="Unable to verify church online — SM should confirm during discovery call." and city/state empty
- No fabrication`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 1024,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
        messages: [{ role: "user", content: userPrompt }],
      }),
    });
    if (!res.ok) {
      console.warn(`[anthropic] HTTP ${res.status} — enrichment skipped`);
      return null;
    }
    const body = await res.json();
    // Extract text from the last text block
    const textBlocks = (body.content || []).filter(b => b.type === "text");
    const text = textBlocks.map(b => b.text).join("\n").trim();
    // Parse JSON (may be wrapped in ```json)
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) { console.warn("[anthropic] no JSON in response"); return null; }
    const parsed = JSON.parse(match[0]);
    return {
      demographic: parsed.demographic || null,
      city: parsed.city || null,
      state: parsed.state || null,
    };
  } catch (e) {
    console.warn("[anthropic] enrichment failed:", e.message);
    return null;
  }
}

// ---- NEW-BOARD IDS (post-2026-08-03 migration) --------------------------
const CLIENT_CONTACTS_BOARD = 18424840911;   // "Client Contacts [NEW]"
const LEADS_BOARD           = 18424840901;   // "Leads [NEW]"
const LEADS_FRESH_GROUP     = "topics";      // 🌱 Fresh (needs qualification)

// NEW Client Contacts board column IDs
const CC_EMAIL  = "email_mm5q7xmc";
const CC_PHONE  = "phone_mm5qpj0z";
const CC_TITLE  = "text_mm5qcw25";
const CC_CHURCH = "text_mm5q4dt5";
const CC_REL    = "color_mm5qw872";   // Relationship (Cold Reach Out etc.)
const CC_DATE   = "date_mm5qpsjf";
// Note: NEW Contacts board has no comments/notes column and no Owner column.
// The comment blob that used to live on OLD contacts is now written to the
// NEW Leads item's Demographic field. Sub-200 nurture ownership (previously
// auto-assigned to Desmond on OLD contacts) is not set here — SMs pick up
// nurture leads from the Contacts board manually. Flag this to Will if
// nurture routing needs to be re-automated.

// NEW Leads board column IDs
const LD_STAGE         = "color_mm5hdya4";
const LD_SOURCE        = "color_mm5hjwrs";
const LD_DATE          = "date_mm5hc955";
const LD_LAST_ACTIVITY = "date_mm5hz4qb";
const LD_FIT           = "color_mm5h71sj";
const LD_INTERESTED    = "color_mm5hv1k0";
const LD_TIMELINE      = "color_mm5hjjxz";
const LD_ATTENDANCE    = "color_mm5he334";
const LD_ROLE          = "text_mm5hcd2d";
const LD_CHURCH        = "text_mm5h11je";
const LD_CITY          = "text_mm5hke00";
const LD_STATE         = "text_mm5h5vzx";
const LD_DEMOGRAPHIC   = "long_text_mm5hrgzb";
const LD_CONTACT_LINK  = "board_relation_mm5wpr99";
// (2026-08-17: const re-declared — an 8/10 refactor deleted the declaration but
// kept the usage below, a latent ReferenceError that the enrichment timeout had
// been masking. Older stale note said this column was "intentionally NOT written";
// that predates the 8/10 API-Version 2025-04 bump which made the write work.)
// Monday-side config bug: this column silently rejects all API writes across
// every tested payload shape (item_ids, linkedPulseIds, etc). Ops (Kylie) must
// fix the Monday column config in the UI. Until then we skip the write and
// log a note; SMs can link contacts manually.

// (GHL custom-field IDs declared above with the ghlFetchContact helper.)

// Sub-200 attendance strings that used to route to Owen/Desmond nurture on
// the OLD system. Kept as a flag so we can prefix the Demographic field to
// help SMs spot small-church leads quickly. See "nurture ownership" note above.
function isSubTwoHundred(attendance) {
  if (!attendance) return false;
  const s = String(attendance).toLowerCase();
  return s.includes("under 200") || s.includes("<200") || s.includes("< 200");
}

// Map a free-text attendance string to a NEW board Attendance status label.
// Mirrors mapAttendance() in migrate-to-new-boards.mjs.
// Bug fixed 2026-08-10: STRING patterns are checked BEFORE numeric extraction.
// Previously "under 200" would match the "200" digit and return "200-499".
function mapAttendance(sizeText) {
  if (!sizeText) return "Unknown";
  const s = String(sizeText).trim().toLowerCase().replace(/,/g, "");
  // Check qualitative string patterns FIRST (before numeric extraction)
  if (s.includes("under 200") || s.includes("less than 200") || s.includes("< 200") || s.includes("<200")) return "< 200";
  // "Under 500" is a legacy GHL form option with no exact board bucket. Numeric
  // extraction below would read the 500 and wrongly return "500 - 999", which is
  // the one answer it definitely is not. 200 - 499 is the widest bucket fully
  // contained under 500.
  if (s.includes("under 500") || s.includes("less than 500")) return "200 - 499";
  if (s.includes("2500+") || s.includes("2500 +") || s.includes("2,500+") || s.includes("over 2500") || s.includes("more than 2500")) return "2,500+";
  // Guard the numeric fallback. Anything that is obviously not a congregation
  // size — a timestamp, a URL, an email, a phone number, a bare year — would
  // otherwise be bucketed as a plausible-looking attendance and mask a total
  // enrichment failure. Measured: "2026-08-20T23:33:13Z" mapped to
  // "1,000 - 2,499", which is indistinguishable from a real answer.
  const raw = String(sizeText);
  if (/\d{4}-\d{2}-\d{2}|t\d{2}:\d{2}|@|https?:/i.test(raw)) return "Unknown";
  if (/^\s*(19|20)\d{2}\s*$/.test(raw)) return "Unknown";          // bare year
  if (/^\D*\d{10,}\D*$/.test(raw)) return "Unknown";                 // phone-shaped: a real 10+ digit run

  // Then try numeric extraction
  const m = s.match(/(\d+)/);
  if (!m) return "Unknown";
  const n = Number(m[1]);
  if (n < 200)   return "< 200";
  if (n < 500)   return "200 - 499";
  if (n < 1000)  return "500 - 999";
  if (n < 2500)  return "1,000 - 2,499";
  return "2,500+";
}

// Map a free-text timeline string to a NEW board Timeline status label.
// String patterns are checked in specificity order. Blank / unmapped → "Unknown".
function mapTimeline(text) {
  // Qualitative phrases are tested BEFORE any numeric extraction. Ordering is
  // the whole game here: "Within 3 months" contains a 3, so a numeric-first
  // version silently answers "3 - 6 months". Likewise "6+ Months" must not be
  // matched by a loose rule that also swallows "3 - 6 Months".
  const s = String(text || "").trim().toLowerCase()
    .replace(/%2b/g, "+")      // form-encoded plus that never got decoded
    .replace(/\s+/g, " ");
  if (!s) return "Unknown";

  if (/(asap|immediately|urgent|right away|\bnow\b)/.test(s)) return "ASAP";
  if (/(someday|no rush|not soon|later|just exploring|exploring)/.test(s)) return "Someday";
  if (/(within 3|next month|few weeks)/.test(s)) return "1 - 3 months";
  if (/(quarter|few months)/.test(s)) return "3 - 6 months";
  if (/next year/.test(s)) return "6 - 12 months";

  // Only trust digits when the string actually reads like a duration, so a
  // stray id or year can never be bucketed as a hiring timeline.
  if (/\d+\s*(-|–|to|\+)/.test(s) || /\d+\s*months?/.test(s)) {
    const lo = Number((s.match(/\d+/g) || [])[0]);
    if (lo === 1) return "1 - 3 months";
    if (lo === 3) return "3 - 6 months";
    if (lo === 6) return "6 - 12 months";
  }
  return "Unknown";
}

function todayISO() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function sanitizePhoneDigits(raw) {
  return String(raw || "").replace(/\D/g, "");
}

/**
 * GHL Custom Webhooks are user-configured, so field names vary. Accept the
 * common shapes: flat {first_name, ...}, camelCase {firstName, ...}, and
 * nested {contact: {first_name, ...}}.
 */
function pickField(body, ...names) {
  for (const n of names) {
    // LITERAL flat key first. GHL's own field keys ARE dotted strings
    // ("contact.ideal_timeline"), and the old dot-split-only version walked
    // them as a nested path, so a flat key with that exact name was
    // unreadable. That is why timeline and position could never resolve from
    // the payload while undotted "attendance" could. Found 2026-08-20.
    const flat = body && typeof body === "object" ? body[n] : undefined;
    if (typeof flat === "string" && flat.trim()) return flat.trim();
    if (typeof flat === "number") return String(flat);

    // Then the same alias as a nested path — preserves the old behaviour.
    let cur = body;
    for (const p of n.split(".")) {
      cur = cur && typeof cur === "object" ? cur[p] : undefined;
    }
    if (typeof cur === "string" && cur.trim()) return cur.trim();
    if (typeof cur === "number") return String(cur);
  }
  return "";
}

const US_STATES = {
  alabama:"AL", alaska:"AK", arizona:"AZ", arkansas:"AR", california:"CA", colorado:"CO",
  connecticut:"CT", delaware:"DE", "district of columbia":"DC", florida:"FL", georgia:"GA",
  hawaii:"HI", idaho:"ID", illinois:"IL", indiana:"IN", iowa:"IA", kansas:"KS", kentucky:"KY",
  louisiana:"LA", maine:"ME", maryland:"MD", massachusetts:"MA", michigan:"MI", minnesota:"MN",
  mississippi:"MS", missouri:"MO", montana:"MT", nebraska:"NE", nevada:"NV",
  "new hampshire":"NH", "new jersey":"NJ", "new mexico":"NM", "new york":"NY",
  "north carolina":"NC", "north dakota":"ND", ohio:"OH", oklahoma:"OK", oregon:"OR",
  pennsylvania:"PA", "rhode island":"RI", "south carolina":"SC", "south dakota":"SD",
  tennessee:"TN", texas:"TX", utah:"UT", vermont:"VT", virginia:"VA", washington:"WA",
  "west virginia":"WV", wisconsin:"WI", wyoming:"WY", "puerto rico":"PR",
};
const STATE_CODES = new Set(Object.values(US_STATES));
// Tokens that mean "this is a street", so the words before them are not a city.
const STREET_WORDS = new Set([
  "st","street","rd","road","ave","avenue","blvd","boulevard","dr","drive","ln","lane",
  "hwy","highway","ih","pkwy","parkway","ct","court","cir","circle","way","ste","suite","apt","unit",
]);
// A bare compass direction is the tail of a street address, never a city —
// "5513 IH 35 South" would otherwise yield a city of "South".
const DIRECTIONALS = new Set(["n","s","e","w","ne","nw","se","sw","north","south","east","west"]);

/**
 * Pull a city and state out of GHL's free-text "Location" field.
 *
 * Written against every value that actually exists in the CRM (18 of them),
 * which range from "Atlanta" to "3605 E ZALESKY RD - Cottonwood, AZ 86326".
 * Returns {city, state}, either of which may be "" — a wrong city is worse
 * than a blank one, so anything unrecognised yields nothing.
 */
/**
 * "TX" / "tx" / "Texas" -> "TX". Anything unrecognised returns "".
 * The previous normalizer was .toUpperCase().slice(0,2), which silently turned
 * Texas into TE, Arizona into AR and Maine into MA.
 */
function normalizeState(v) {
  const t = String(v || "").trim();
  if (!t) return "";
  if (/^[A-Za-z]{2}$/.test(t) && STATE_CODES.has(t.toUpperCase())) return t.toUpperCase();
  const code = US_STATES[t.toLowerCase()];
  return code || "";
}

function parseLocation(raw) {
  let t = String(raw || "").trim().replace(/\s+/g, " ");
  if (!t) return { city: "", state: "" };

  t = t.replace(/\s*\d{5}(?:-\d{4})?\s*$/, "").trim();   // drop a trailing ZIP
  t = t.replace(/[,\s-]+$/, "");

  let state = "";
  // Trailing full state name ("Statesboro, Georgia", "largo florida")
  for (const [name, code] of Object.entries(US_STATES)) {
    const re = new RegExp(`[,\\s]${name}$`, "i");
    if (re.test(t)) { state = code; t = t.replace(re, ""); break; }
  }
  // Trailing 2-letter code ("Bethlehem PA", "durham, nc")
  if (!state) {
    const m = t.match(/[,\s]([A-Za-z]{2})$/);
    if (m && STATE_CODES.has(m[1].toUpperCase())) {
      state = m[1].toUpperCase();
      t = t.slice(0, m.index);
    }
  }
  t = t.replace(/[,\s-]+$/, "").trim();

  // Take the last comma- or dash-separated chunk: the city sits at the end.
  const chunk = t.split(/\s*[,]\s*|\s+-\s+/).pop().trim();

  // Drop street-address noise: leading numeric tokens, and everything up to and
  // including the last street word ("1199 Clay Street Winter Park" -> "Winter Park").
  let words = chunk.split(" ").filter(Boolean);
  const norm = (w) => w.toLowerCase().replace(/\./g, "");
  let lastStreet = -1;
  words.forEach((w, i) => { if (STREET_WORDS.has(norm(w))) lastStreet = i; });
  if (lastStreet >= 0) words = words.slice(lastStreet + 1);
  while (words.length && /\d/.test(words[0])) words.shift();

  if (words.length && words.every(w => DIRECTIONALS.has(norm(w)))) return { city: "", state };

  let cityRaw = words.join(" ").trim();
  // A city is letters, spaces and light punctuation — never digits — and is at
  // most three words ("Salt Lake City"). The word cap is what separates a place
  // name from free prose like "somewhere out past the ridge". Verified against
  // every real value: the longest is two words.
  if (!cityRaw ||
      /\d/.test(cityRaw) ||
      !/^[A-Za-z][A-Za-z .'-]*$/.test(cityRaw) ||
      words.length > 3 ||
      cityRaw.length > 40) {
    return { city: "", state };
  }
  const city = cityRaw.split(" ")
    .map(w => w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w)
    .join(" ");
  return { city, state };
}

function normKey(k) {
  return String(k).toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Last-resort reader. The GHL Custom Webhook body is hand-authored in the GHL
 * UI, so key naming is not under our control — "Weekly Attendance",
 * "weeklyAttendance", "contact.weekly_attendance" and "weekly-attendance" all
 * normalize to the same thing here.
 *
 * TWO DELIBERATE LIMITS, both learned the hard way:
 *
 * 1. Identity fields never come through here. GHL payloads carry `user`,
 *    `assignedTo` and `location` objects that each have their own `email`.
 *    Deep-scanning for an identity field would pick up a staffing manager's
 *    address, and since contact dedupe matches on email within 48h, every
 *    later lead would collapse into one Client Contacts row. Only descriptive
 *    fields (role, church, attendance, timeline) use this.
 * 2. Those same sibling objects are skipped outright. A GHL `location` has its
 *    own `name`/`companyName`, which would otherwise be read as the church.
 */
const DEEP_SKIP_KEYS = new Set([
  "user", "assignedto", "assigneduser", "location", "workflow", "account",
  "calendar", "appointment", "opportunity", "company",
]);

function deepFind(body, aliases, depth = 5) {
  const want = new Set(aliases.map(normKey));
  const seen = new Set();
  const walk = (o, d) => {
    if (!o || typeof o !== "object" || d > depth || seen.has(o)) return "";
    seen.add(o);
    // Direct hits at this level first.
    for (const [k, v] of Object.entries(o)) {
      if (!want.has(normKey(k))) continue;
      if (typeof v === "string" && v.trim()) return v.trim();
      if (typeof v === "number") return String(v);
    }
    // Then descend, skipping containers that describe someone other than the lead.
    for (const [k, v] of Object.entries(o)) {
      if (!v || typeof v !== "object") continue;
      if (DEEP_SKIP_KEYS.has(normKey(k))) continue;
      const hit = walk(v, d + 1);
      if (hit) return hit;
    }
    return "";
  };
  return walk(body, 0);
}

/**
 * Read a GHL custom field by its field-ID. GHL sends custom fields in several
 * possible shapes depending on webhook config:
 *   1) Array of {id, value} objects   — canonical shape from GHL v2 API
 *   2) Object keyed by field-ID       — flat map, seen in some payloads
 *   3) Top-level customField[<id>]    — legacy shape
 * We try all shapes and return the first non-empty match.
 */
function pickCustomField(body, fieldId) {
  const containers = [
    body?.contact?.customFields,
    body?.contact?.custom_fields,
    body?.customFields,
    body?.custom_fields,
  ];
  for (const c of containers) {
    if (!c) continue;
    if (Array.isArray(c)) {
      // Array shape: [{ id, value }, ...]
      const hit = c.find((f) => f && (f.id === fieldId || f.key === fieldId));
      if (hit) {
        const v = hit.value ?? hit.fieldValue ?? hit.fieldValueString;
        if (typeof v === "string" && v.trim()) return v.trim();
        if (typeof v === "number") return String(v);
      }
    } else if (typeof c === "object") {
      // Object shape: { <fieldId>: value }
      const v = c[fieldId];
      if (typeof v === "string" && v.trim()) return v.trim();
      if (typeof v === "number") return String(v);
    }
  }
  return "";
}

async function mondayMutate(token, mutation, variables) {
  const res = await fetch(MONDAY_API, {
    method: "POST",
    headers: {
      Authorization: token,
      "Content-Type": "application/json",
      // API-Version 2025-04 is required for board_relation column writes.
      // Prior 2024-01 default silently rejected board_relation writes with
      // no error; column value would stay null. Bumped 2026-08-10.
      "API-Version": "2025-04",
    },
    body: JSON.stringify({ query: mutation, variables }),
  });
  const json = await res.json();
  if (json.errors) return { ok: false, errors: json.errors };
  return { ok: true, data: json.data };
}

/**
 * Idempotency guards (added 2026-08-17). GHL retries the webhook when it gets
 * no timely 2xx, which used to create up to 5 duplicate contacts per lead.
 * Before creating, look for a matching row created in the last 48h and reuse
 * it. Failures return null (= no match) so a guard error can never block a
 * lead from landing.
 */
const DEDUPE_WINDOW_MS = 48 * 3600 * 1000;

async function findRecentContactByEmail(token, email) {
  if (!email) return null;
  const query = `
    query ($board: ID!) {
      boards(ids: [$board]) {
        items_page(limit: 50, query_params: {order_by: [{column_id: "__creation_log__", direction: desc}]}) {
          items { id created_at column_values(ids: ["${CC_EMAIL}"]) { text } }
        }
      }
    }
  `;
  const r = await mondayMutate(token, query, { board: String(CLIENT_CONTACTS_BOARD) });
  if (!r.ok) { console.warn("[dedupe] contact lookup failed:", JSON.stringify(r.errors).slice(0, 200)); return null; }
  const items = r.data?.boards?.[0]?.items_page?.items || [];
  const cutoff = Date.now() - DEDUPE_WINDOW_MS;
  const hit = items.find(
    (it) =>
      new Date(it.created_at).getTime() > cutoff &&
      (it.column_values?.[0]?.text || "").trim().toLowerCase() === email.trim().toLowerCase()
  );
  return hit?.id ?? null;
}

/**
 * Dedupe a lead on BOTH the linked contact AND the title.
 *
 * Contact alone is wrong: one person, or a shared church inbox, can legitimately
 * submit twice inside 48h for two DIFFERENT openings, and keying on the contact
 * discards the second one. Title alone is wrong too: "Role — ???" is generic by
 * construction and collides across different people. A genuine GHL retry carries
 * both the same contact and the same title, so requiring both keeps idempotency
 * while letting real second leads through.
 *
 * Name-based dedupe was safe while every title embedded the person's name. As
 * of 2026-08-21 an unknown church renders as "Role — ???", so two different
 * candidates hiring the same role with no church produce an IDENTICAL title —
 * and the second one would have been silently swallowed as a duplicate. The
 * linked Client Contacts row is unique per person, so it is the correct key.
 */
async function findRecentLeadByContact(token, contactItemId, leadName) {
  if (!contactItemId) return null;
  const query = `
    query ($board: ID!) {
      boards(ids: [$board]) {
        items_page(limit: 50, query_params: {order_by: [{column_id: "__creation_log__", direction: desc}]}) {
          items {
            id name created_at
            column_values(ids: ["${LD_CONTACT_LINK}"]) {
              ... on BoardRelationValue { linked_item_ids }
            }
          }
        }
      }
    }
  `;
  const r = await mondayMutate(token, query, { board: String(LEADS_BOARD) });
  if (!r.ok) { console.warn("[dedupe] lead-by-contact lookup failed:", JSON.stringify(r.errors).slice(0, 200)); return null; }
  const items = r.data?.boards?.[0]?.items_page?.items || [];
  const cutoff = Date.now() - DEDUPE_WINDOW_MS;
  const want = String(contactItemId);
  const hit = items.find((it) =>
    new Date(it.created_at).getTime() > cutoff &&
    (it.column_values?.[0]?.linked_item_ids || []).map(String).includes(want) &&
    it.name.trim().toLowerCase() === String(leadName || "").trim().toLowerCase()
  );
  return hit?.id ?? null;
}

async function findRecentLeadByName(token, name) {
  if (!name) return null;
  const query = `
    query ($board: ID!) {
      boards(ids: [$board]) {
        items_page(limit: 50, query_params: {order_by: [{column_id: "__creation_log__", direction: desc}]}) {
          items { id name created_at }
        }
      }
    }
  `;
  const r = await mondayMutate(token, query, { board: String(LEADS_BOARD) });
  if (!r.ok) { console.warn("[dedupe] lead lookup failed:", JSON.stringify(r.errors).slice(0, 200)); return null; }
  const items = r.data?.boards?.[0]?.items_page?.items || [];
  const cutoff = Date.now() - DEDUPE_WINDOW_MS;
  const hit = items.find(
    (it) => new Date(it.created_at).getTime() > cutoff && it.name.trim().toLowerCase() === name.trim().toLowerCase()
  );
  return hit?.id ?? null;
}

async function createContact(token, data) {
  const columnValues = {
    [CC_DATE]: { date: todayISO() },
    [CC_REL]: { label: "Cold Reach Out" },
  };
  if (data.church)  columnValues[CC_CHURCH] = data.church;
  // Title is THIS PERSON's job title, not the role they are hiring for. It used
  // to be filled with data.position ("Position Hiring For"), so an SM opening a
  // church's HR director saw "Title: Worship Pastor". Actively misleading, so
  // no fallback: blank beats wrong. The opening still shows on the Leads row.
  if (data.jobTitle) columnValues[CC_TITLE] = data.jobTitle;
  if (data.email)   columnValues[CC_EMAIL] = { email: data.email, text: data.email };
  if (data.phone)
    columnValues[CC_PHONE] = {
      phone: sanitizePhoneDigits(data.phone),
      countryShortName: "US",
    };

  const mutation = `
    mutation ($board: ID!, $name: String!, $cols: JSON!) {
      create_item(board_id: $board, item_name: $name, column_values: $cols, create_labels_if_missing: true) {
        id
      }
    }
  `;
  const variables = {
    board: String(CLIENT_CONTACTS_BOARD),
    name: `${data.first} ${data.last}`.trim() || data.email || "Unnamed",
    cols: JSON.stringify(columnValues),
  };

  const r = await mondayMutate(token, mutation, variables);
  if (!r.ok) {
    console.error("Contact create errors:", JSON.stringify(r.errors));
    return null;
  }
  return r.data?.create_item?.id ?? null;
}

/**
 * The lead row's title. Extracted so the dry-run path and the real write use
 * the exact same code — a second copy would drift and the dry run would stop
 * proving anything.
 *
 * Titles describe the OPENING, not the person: the slot after the separator is
 * always the church. Will 2026-08-21 — a person's name sitting where the church
 * belongs reads like the church is called "Kervens". Unknown church is "???",
 * matching the unknown-role convention on the line above it. The final fallback
 * keeps the person's name because "??? — ???" would tell an SM nothing.
 */
function buildLeadName(data) {
  const role = (data.position || "").trim();
  const church = (data.church || "").trim();
  const nameFallback = `${data.first || ""} ${data.last || ""}`.trim();
  if (role && church) return `${role} @ ${church}`;
  if (church)         return `??? @ ${church}`;
  if (role)           return `${role} — ???`;
  return nameFallback || "PPC lead";
}

async function createLead(token, data) {
  const attendanceLabel = mapAttendance(data.attendance);
  const timelineLabel   = mapTimeline(data.timeline);

  // Demographic column now holds the CHURCH DEMOGRAPHIC (Will 2026-08-10 rule
  // change) — not metadata about the lead record. Fetched via Anthropic +
  // web_search. Falls back to a placeholder if enrichment fails or is skipped.
  // City/State also come from this enrichment when the form didn't collect them.
  // Prepend a suspicious-lead warning if we detect obvious signals.
  const suspicious = detectSuspicious(data.first, data.last, data.email, data.church);
  const suspiciousPrefix = suspicious
    ? `⚠ SUSPICIOUS LEAD FLAG: ${suspicious.join("; ")}. This may not be a high-quality lead — SM should verify authenticity before spending time.\n\n`
    : "";
  let demographic = data.church
    ? `${suspiciousPrefix}No church profile on file — SM to research before the call.`
    : `${suspiciousPrefix}Church name missing on form — SM to collect during discovery call.`;

  // Enrichment-gap banner. This list must track what the FORM actually
  // requires, or it cries wolf. As of 2026-08-21 both forms require church,
  // role, attendance, city and state; timeline and notes are optional. So a
  // missing timeline is a normal lead, not a failure — flagging it would fire
  // on healthy rows and train SMs to ignore the one visible warning we have.
  //
  // City/State are also excluded, for a different reason: they are required on
  // the form but GHL has nowhere to store them, so they are missing on every
  // single lead until that mapping exists. See the runbook.
  const missing = [];
  if (!data.position)   missing.push("role");
  if (!data.church)     missing.push("church");
  if (!data.attendance) missing.push("attendance");
  // The banner itself is applied AFTER the Anthropic enrichment below, which
  // reassigns `demographic` and would otherwise wipe it.
  let enrichedCity = data.city || null;
  let enrichedState = data.state || null;
  // Race the enrichment against a 6s timeout. 2026-08-17 root cause of the
  // 8/12-8/17 outage (Clinton→Preston, 8 leads dropped): the previous 25s
  // race NEVER resolves because Vercel's DEFAULT maxDuration (10s) killed
  // the whole function mid-race — contact row landed, Lead write never ran,
  // GHL got no response and retried 5x (hence 5x duplicate contacts).
  // 6s keeps total runtime under 10s even if vercel.json maxDuration=60
  // (added same day) doesn't take effect on this plan. If Anthropic needs
  // longer, the Lead ships with placeholder demographic — SMs verify.
  // DISABLED IN-BAND 2026-08-21. This raced Anthropic+web_search against 6s.
  // Measured actual latency for this exact model/prompt/tools config: 9.6s,
  // 11.0s, 12.6s, 13.2s, 14.5s, 14.7s — the fastest run is 1.8x the cap, so the
  // race has NEVER been won. Every Demographic since 8/17 has been the
  // placeholder, while each lead still burned ~40k input tokens and held GHL's
  // connection for 6s (Promise.race does not abort the fetch).
  //
  // Raising the cap is not the fix: holding the connection 15-20s recreates the
  // retry storm that caused the 8/12-8/17 outage. Enrichment belongs off the
  // request path. Set ENRICH_IN_BAND=1 to re-enable with a longer budget.
  const enrichBudgetMs = Number(process.env.ENRICH_BUDGET_MS || 0);
  try {
    const enrichment = enrichBudgetMs <= 0 ? null : await Promise.race([
      anthropicEnrichChurch(data.church, data.city, data.state, data.position),
      new Promise((resolve) => setTimeout(() => resolve({ __timeout: true }), enrichBudgetMs)),
    ]);
    if (enrichment?.__timeout) {
      console.warn("[enrich] Anthropic enrichment timed out at 6s — shipping Lead with placeholder demographic");
    } else if (enrichment) {
      if (enrichment.demographic) demographic = suspiciousPrefix + enrichment.demographic;
      // Normalize exactly like collected values, and mark them as inferred so an
      // SM can tell a guess from an answer. Note the live State column already
      // holds "Tennessee" AND "TN", plus "IL (assumed)", from unnormalized
      // output — do not add to it.
      if (!enrichedCity && enrichment.city) enrichedCity = String(enrichment.city).trim();
      if (!enrichedState && enrichment.state) enrichedState = normalizeState(enrichment.state);
    }
  } catch (e) {
    console.warn("[enrich] church enrichment threw:", e.message);
  }

  // The lead's own words go ABOVE the researched church demographic — it is
  // first-hand and an SM reads the top of the cell first.
  const ownWords = [
    data.orgType ? `Organization type: ${data.orgType}.` : "",
    data.leadNotes ? `In their words: "${data.leadNotes}"` : "",
  ].filter(Boolean).join(" ");
  if (ownWords) demographic = `${ownWords}\n\n${demographic}`;

  // Applied last, so the Anthropic rewrite above can't drop it.
  if (missing.length) {
    const trace = (data.ghlTrace || []).slice(0, 12).join(" | ") || "none";
    demographic =
      `⚠ ENRICHMENT GAP — missing: ${missing.join(", ")}. ` +
      `GHL custom fields seen: ${data.ghlCfCount ?? 0}. Trace: ${trace}\n\n` + demographic;
  }
  // monday's long_text rejects writes over 2000 chars, and one rejected column
  // value fails the whole create_item — which drops the lead while GHL sees a
  // 200 and never retries. Cap last, after every writer has had its say.
  if (demographic.length > 1900) demographic = demographic.slice(0, 1897) + "...";

  const columnValues = {
    [LD_STAGE]:         { label: "New" },
    [LD_SOURCE]:        { label: "PPC Ads" },
    [LD_DATE]:          { date: todayISO() },
    [LD_LAST_ACTIVITY]: { date: todayISO() },
    [LD_FIT]:           { label: "Unknown" },
    [LD_INTERESTED]:    { label: "Interested" },
    [LD_DEMOGRAPHIC]:   demographic,
  };
  // Only write these when we actually resolved something. Leaving the cell
  // blank rather than stamping "Unknown" is what lets a human — or a later
  // backfill — tell "enrichment failed" apart from "the lead said unknown".
  if (timelineLabel   !== "Unknown") columnValues[LD_TIMELINE]   = { label: timelineLabel };
  if (attendanceLabel !== "Unknown") columnValues[LD_ATTENDANCE] = { label: attendanceLabel };
  if (data.position)  columnValues[LD_ROLE]   = data.position;
  if (data.church)    columnValues[LD_CHURCH] = data.church;
  if (enrichedCity)   columnValues[LD_CITY]   = enrichedCity;
  if (enrichedState)  columnValues[LD_STATE]  = enrichedState;
  // Contact Point (LD_CONTACT_LINK / board_relation_mm5wpr99) — REQUIRES
  // API-Version 2025-04 on the mutation. Prior versions silently rejected
  // the write with no error. Bumped mondayMutate() to 2025-04 on 2026-08-10.
  if (data.contactItemId) {
    columnValues[LD_CONTACT_LINK] = { item_ids: [Number(data.contactItemId)] };
  }
  // NO owner, NO Client Manager assignment — SMs claim from Fresh group.

  const leadName = buildLeadName(data);

  // Idempotency: if a GHL retry already produced this lead in the last 48h,
  // return the existing row instead of creating a duplicate.
  // Prefer the linked contact — unique per person. Fall back to the title only
  // when it is specific enough to identify one lead: a title containing "???"
  // is generic by construction and would collide across different people.
  const existingLead = await findRecentLeadByContact(token, data.contactItemId, leadName);
  if (existingLead) {
    console.log(`[dedupe] lead "${leadName}" already exists (${existingLead}) — skipping create`);
    return existingLead;
  }

  const mutation = `
    mutation ($board: ID!, $group: String!, $name: String!, $cols: JSON!) {
      create_item(board_id: $board, group_id: $group, item_name: $name, column_values: $cols, create_labels_if_missing: true) {
        id
      }
    }
  `;
  const variables = {
    board: String(LEADS_BOARD),
    group: LEADS_FRESH_GROUP,
    name: leadName,
    cols: JSON.stringify(columnValues),
  };

  const r = await mondayMutate(token, mutation, variables);
  if (!r.ok) {
    console.error("Lead create errors:", JSON.stringify(r.errors));
    return null;
  }
  return r.data?.create_item?.id ?? null;
}

module.exports = async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      route: "/api/ghl-webhook",
      version: "2026-08-21-review-fixes",
      target_boards: { leads: LEADS_BOARD, contacts: CLIENT_CONTACTS_BOARD },
      hint: "POST with ?secret=... to sync a GHL contact to Monday",
    });
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Secret check.
  const providedSecret = req.query.secret;
  const expectedSecret = process.env.WEBHOOK_SECRET;
  if (!expectedSecret) {
    return res.status(500).json({ error: "Server missing WEBHOOK_SECRET" });
  }
  if (providedSecret !== expectedSecret) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const mondayToken = process.env.MONDAY_TOKEN;
  if (!mondayToken) {
    return res.status(500).json({ error: "Server missing MONDAY_TOKEN" });
  }

  // Body — Vercel serverless auto-parses JSON if Content-Type is application/json
  const body = req.body || {};

  // Raw-payload logging removed 2026-08-21: it dumped every lead's PII into the
  // runtime logs, and `diag.payloadKeys` on the response answers the same
  // question (which keys GHL actually sends) without the contents.

  const first = pickField(
    body,
    "first_name",
    "firstName",
    "contact.first_name",
    "contact.firstName",
  );
  const last = pickField(
    body,
    "last_name",
    "lastName",
    "contact.last_name",
    "contact.lastName",
  );
  const email = pickField(body, "email", "contact.email");
  const phone = pickField(body, "phone", "contact.phone");

  // CRITICAL: GHL's Custom Webhook payload frequently OMITS customFields entirely,
  // even when the fields are populated on the contact. Verified 2026-08-10 with
  // Alberto Pedroso — payload had zero customFields, but /contacts/{id} returned
  // position/attendance/timeline all populated. Always fetch the full contact
  // from GHL by ID to guarantee we have the data. Falls back to payload if the
  // fetch fails (missing GHL_TOKEN, network error, etc.).
  // Per-request, never module scope — Fluid compute shares one process across
  // concurrent leads. This is the only durable record of what the GHL calls
  // did: Vercel's historical runtime logs are unreachable from CLI and API.
  const ghlTrace = [];

  // Deliberately NOT deep-scanned. A stray `id` elsewhere in the payload would
  // be a workflow or location id, and a wrong contact id is worse than none.
  const ghlContactId =
    pickField(body, "contact_id", "contactId", "contact.id", "id");
  if (!ghlContactId) ghlTrace.push("noContactIdInPayload");
  const ghlContact = ghlContactId ? await ghlFetchContact(ghlContactId, ghlTrace) : null;
  if (ghlContact) {
    console.log(`[ghl] enriched from /contacts/${ghlContactId} — customFields: ${(ghlContact.customFields || []).length}`);
  } else if (ghlContactId) {
    console.warn(`[ghl] failed to enrich contact ${ghlContactId} — falling back to webhook payload`);
  }

  // Read custom fields — prefer the fetched full contact, fall back to payload.
  // If the by-id fetch came back without usable custom fields, fall back to an
  // email search before reading any field. Added 2026-08-19 after every PPC lead
  // from 8/17-8/19 landed with church empty while GHL held the value.
  // The old gate looked only at church and position. A candidate can legitimately
  // have neither (church is optional on the form), so a perfectly good record
  // carrying attendance and timeline was thrown away and a round trip wasted.
  // Every field we read, not just the primary four. Second-funnel contacts have
  // none of the primaries, so a SUCCESSFUL fetch was being thrown away and
  // re-fetched twice — and the trace printed onto the board said the id lookup
  // had failed when it had not.
  const CF_IDS = [
    GHL_CF_CHURCH, GHL_CF_POSITION, GHL_CF_ATTENDANCE, GHL_CF_TIMELINE,
    GHL_CF_ORG_NAME, GHL_CF_WANT_HIRE, GHL_CF_JOB_TITLE,
    GHL_CF_NOTES, GHL_CF_ANYTHING, GHL_CF_ORG_TYPE, GHL_CF_LOCATION,
  ];
  const hasAnyCF = (c) => !!c && Array.isArray(c.customFields) && CF_IDS.some(id => ghlGetCF(c, id));

  let ghlSource = ghlContact;
  if (!hasAnyCF(ghlSource) && email) {
    const byEmail = await ghlFindContactByEmail(email, ghlTrace);
    // Accept on ANY custom fields, not just the four we map — the record may
    // still carry city/state we want, and it is strictly better than nothing.
    if (byEmail && (byEmail.customFields || []).length) {
      ghlSource = byEmail;
      ghlTrace.push("usedEmailSearch");
      console.log(`[ghl] using email-search record for ${email} (id-fetch had no custom fields)`);
    }
  }
  // Third and last identifier. Between contact id, email and phone, at least
  // one should always be readable — that is the whole point of having three.
  if (!hasAnyCF(ghlSource) && phone) {
    const byPhone = await ghlFindContactByPhone(phone, ghlTrace);
    if (byPhone && (byPhone.customFields || []).length) {
      ghlSource = byPhone;
      ghlTrace.push("usedPhoneSearch");
    }
  }

  // Church and role exist ONLY on the contact record, never in the webhook
  // payload. If both lookups came back unusable the lead will land bare, which
  // is exactly the failure that went unnoticed 8/17-8/20. Shout about it.
  if (!ghlSource || !(ghlSource.customFields || []).length) {
    console.error(`[ghl] ALARM: no custom fields for ${email || "(no email)"} — church/role will be EMPTY. Check GHL_TOKEN and Cloudflare 403s.`);
  }

  // Alias lists deliberately include GHL's own dotted fieldKeys (measured live
  // from GET /locations/<id>/customFields), the landing page's data-field
  // names, and the Title Case forms a human might type into the GHL webhook
  // action. Note church previously had NO church_name alias at all, so it
  // could only ever come from the contact record, never the payload.
  const A_POSITION = ["position", "role", "position_hiring_for", "contact.position_hiring_for", "Position Hiring For"];  // NOT job_title — that is the submitter's own title
  const A_CHURCH   = ["church", "church_name", "contact.church_name", "Church Name", "company_name", "companyName", "contact.company_name", "contact.companyName", "organization"];
  const A_ATTEND   = ["attendance", "weekly_attendance", "contact.weekly_attendance", "contact.attendance", "Weekly Attendance", "average_attendance"];
  const A_TIMELINE = ["timeline", "ideal_timeline", "contact.ideal_timeline", "Ideal Timeline", "hiring_timeline"];

  const resolveField = (cfId, aliases) =>
    ghlGetCF(ghlSource, cfId) ||
    pickCustomField(body, cfId) ||
    pickField(body, ...aliases) ||
    deepFind(body, aliases) ||
    "";

  // Church: primary field, then the second funnel's "Name of organization".
  // Role: primary field, then "what position do you want to hire?" — which is
  // the OPENING. Job Title is deliberately not used: it holds the submitter's
  // own title ("CEO", "chief of staff"), not the role they are hiring for.
  const church =
    resolveField(GHL_CF_CHURCH, A_CHURCH) ||
    ghlGetCF(ghlSource, GHL_CF_ORG_NAME) ||
    pickCustomField(body, GHL_CF_ORG_NAME) ||
    pickField(body, "name_of_organization", "contact.name_of_organization") ||
    "";
  const position =
    resolveField(GHL_CF_POSITION, A_POSITION) ||
    ghlGetCF(ghlSource, GHL_CF_WANT_HIRE) ||
    pickCustomField(body, GHL_CF_WANT_HIRE) ||
    pickField(body, "what_position_do_you_want_to_hire", "contact.what_position_do_you_want_to_hire") ||
    "";

  // The lead's own words. 77 of 700 contacts had a Notes value that never
  // reached the board — the single most useful thing an SM can read before a
  // discovery call ("Apostolic/ pentecostal.").
  const leadNotes = [
    ghlGetCF(ghlSource, GHL_CF_NOTES) || pickCustomField(body, GHL_CF_NOTES) || pickField(body, "notes", "contact.notes"),
    ghlGetCF(ghlSource, GHL_CF_ANYTHING) || pickCustomField(body, GHL_CF_ANYTHING),
  ].map(x => (x || "").trim()).filter(Boolean).join(" — ");

  const orgType = (ghlGetCF(ghlSource, GHL_CF_ORG_TYPE) || "").trim();

  // The submitter's OWN title, for their Client Contacts row. Distinct from
  // `position`, which is the opening they want filled.
  const jobTitle = (
    ghlGetCF(ghlSource, GHL_CF_JOB_TITLE) ||
    pickCustomField(body, GHL_CF_JOB_TITLE) ||
    pickField(body, "job_title", "contact.job_title") ||
    ""
  ).trim();
  const attendance = resolveField(GHL_CF_ATTENDANCE, A_ATTEND);
  const timeline   = resolveField(GHL_CF_TIMELINE, A_TIMELINE);

  const rawSource = pickField(body, "source", "contact.source", "trigger");
  const sourceLabel = "PPC Ads";

  // City + state. Measured 2026-08-21: GHL has NO city/state custom field, and
  // 0 of 600 contacts carry a native city — so historically these have died
  // before reaching us regardless of what the form collected. Both forms now
  // require them, so try every place the value could survive:
  //   1. the webhook payload, flat or nested, in any key spelling
  //   2. GHL's native contact.city / contact.state
  //   3. the unused "Location" custom field (contact.location), which is where
  //      a "Dallas, TX" style value would land if it were mapped there
  //   4. Anthropic church enrichment further down, which fills blanks
  const A_CITY  = ["city", "contact.city", "City"];
  const A_STATE = ["state", "contact.state", "State", "st"];

  let city  = pickField(body, ...A_CITY)  || deepFind(body, A_CITY)  || (ghlSource && ghlSource.city)  || "";
  let state = pickField(body, ...A_STATE) || deepFind(body, A_STATE) || (ghlSource && ghlSource.state) || "";

  // The Location custom field is free text. Written against all 18 real values
  // present in the CRM — see parseLocation() and its test cases.
  if (!city || !state) {
    const parsed = parseLocation(ghlGetCF(ghlSource, GHL_CF_LOCATION));
    if (!city && parsed.city) city = parsed.city;
    if (!state && parsed.state) state = parsed.state;
  }
  state = normalizeState(state);

  if (!first && !last && !email && !phone) {
    return res
      .status(400)
      .json({ error: "Missing required contact fields (need name/email/phone)" });
  }

  const data = {
    first,
    last,
    church,
    phone,
    email,
    city,
    state,
    source: rawSource || sourceLabel,
    sourceLabel,
    attendance,
    position,
    timeline,
    // Carried onto the board when enrichment came up short. Vercel's historical
    // runtime logs are unreachable, so the Demographic column is the only
    // durable, human-readable record of what the GHL calls actually did.
    ghlTrace,
    ghlCfCount: (ghlSource?.customFields || []).length,
    leadNotes,
    orgType,
    jobTitle,
  };

  // Always create the Contact row first (so we can link the Lead to it).
  // Idempotency: reuse a contact created in the last 48h with the same email
  // (GHL retry protection — see findRecentContactByEmail).
  let contactId = await findRecentContactByEmail(mondayToken, email);
  if (contactId) {
    console.log(`[dedupe] contact for ${email} already exists (${contactId}) — skipping create`);
  } else {
    contactId = await createContact(mondayToken, data);
  }

  // Always create a Lead row on the NEW board too — Will's directive
  // 2026-08-05: every PPC lead goes to the new board. Fresh group, no
  // owner/CM assignment, SM triages manually.
  const leadId = await createLead(mondayToken, {
    ...data,
    contactItemId: contactId,
  });

  if (!contactId && !leadId) {
    return res.status(502).json({ error: "Monday writes failed" });
  }

  // A contact row without a Lead row is a SILENTLY LOST LEAD: the old code
  // returned 200 here, so GHL saw success and never retried, and nothing on the
  // board showed the gap. Shout about it. Still 200 — a retry would duplicate
  // the contact row that already succeeded (that was Bug 1).
  if (contactId && !leadId) {
    // Returning 200 here told GHL "success" and the lead was gone for good.
    // The original rationale — that a retry would duplicate the contact row —
    // is obsolete: findRecentContactByEmail now reuses it, and the lead dedupe
    // finds nothing to collide with. Let GHL retry.
    console.error(`[monday] ALARM: contact ${contactId} written but LEAD WRITE FAILED. trace: ${ghlTrace.join(" | ")}`);
    return res.status(502).json({ error: "Lead write failed", contactId });
  }

  return res.status(200).json({
    ok: true,
    contactId,
    leadId,
    sourceLabel,
    attendance,
    // Diagnostics — keys and booleans only, never lead PII. GHL stores the
    // webhook action's response in its workflow execution log, which is the one
    // runtime log channel we can actually read: Vercel's historical logs are
    // unreachable from both the CLI and the public API. `payloadKeys` alone
    // answers the question this whole investigation could not measure — what
    // the hand-authored Custom Webhook body actually sends.
    diag: {
      payloadKeys: Object.keys(body || {}).slice(0, 40),
      resolved: {
        position: !!position,
        church: !!church,
        attendance: !!attendance,
        timeline: !!timeline,
        // Deliberately reported but NOT in the board's gap banner: both forms
        // require these now, but GHL has nowhere to store them yet, so they
        // would fire on every single lead and train SMs to ignore the banner.
        city: !!city,
        state: !!state,
        notes: !!leadNotes,
      },
      ghl: {
        tokenPresent: !!process.env.GHL_TOKEN,
        contactIdSeen: !!ghlContactId,
        emailSeen: !!email,
        cfCount: (ghlSource?.customFields || []).length,
        trace: ghlTrace,
      },
    },
    target: { leads: LEADS_BOARD, contacts: CLIENT_CONTACTS_BOARD },
  });
};
