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

/**
 * Fetch the full GHL contact record by ID. Guarantees customFields presence.
 * Requires GHL_TOKEN env var (Bearer). Returns null on failure.
 */
async function ghlFetchContact(contactId) {
  if (!contactId) return null;
  const token = process.env.GHL_TOKEN;
  if (!token) { console.warn("[ghl] GHL_TOKEN env var not set — cannot enrich contact"); return null; }
  try {
    const r = await fetch(`${GHL_API}/contacts/${contactId}`, {
      headers: {
        "Authorization": `Bearer ${token}`,
        "Version": GHL_API_VERSION,
        "Accept": "application/json",
      },
    });
    if (!r.ok) {
      console.warn(`[ghl] contact fetch ${contactId} HTTP ${r.status}`);
      return null;
    }
    const body = await r.json();
    return body.contact || body || null;
  } catch (e) {
    console.warn(`[ghl] contact fetch ${contactId} threw:`, e.message);
    return null;
  }
}

/** Read a specific customField value by id from a GHL contact record. */
function ghlGetCF(contact, cfId) {
  if (!contact || !Array.isArray(contact.customFields)) return null;
  const match = contact.customFields.find(f => f.id === cfId);
  return match?.value ?? null;
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
// LD_CONTACT_LINK ("board_relation_mm5wpr99") intentionally NOT written here.
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
  if (s.includes("2500+") || s.includes("2500 +") || s.includes("2,500+") || s.includes("over 2500") || s.includes("more than 2500")) return "2,500+";
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
  if (!text) return "Unknown";
  const s = String(text).trim().toLowerCase();
  if (!s) return "Unknown";
  if (/(asap|immediately|urgent|right away|\bnow\b)/.test(s)) return "ASAP";
  if (/(1\s*-\s*3|1\s*to\s*3|1\s*–\s*3|within 3|next month|few weeks)/.test(s)) return "1 - 3 months";
  if (/(3\s*-\s*6|3\s*to\s*6|3\s*–\s*6|quarter|few months)/.test(s)) return "3 - 6 months";
  if (/(6\s*-\s*12|6\s*to\s*12|6\s*–\s*12|next year|6\+\s*months|6\s*months\+)/.test(s)) return "6 - 12 months";
  if (/(someday|no rush|not soon|later|just exploring|exploring)/.test(s)) return "Someday";
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
    const parts = n.split(".");
    let cur = body;
    for (const p of parts) {
      cur = cur && typeof cur === "object" ? cur[p] : undefined;
    }
    if (typeof cur === "string" && cur.trim()) return cur.trim();
  }
  return "";
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

async function createContact(token, data) {
  const columnValues = {
    [CC_DATE]: { date: todayISO() },
    [CC_REL]: { label: "Cold Reach Out" },
  };
  if (data.church)  columnValues[CC_CHURCH] = data.church;
  if (data.position) columnValues[CC_TITLE] = data.position;
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
    ? `${suspiciousPrefix}Church demographic pending enrichment — SM should verify.`
    : `${suspiciousPrefix}Church name missing on form — SM to collect during discovery call.`;
  let enrichedCity = data.city || null;
  let enrichedState = data.state || null;
  // Race the enrichment against a 25s timeout — Vercel serverless kills at
  // 60s and we need time for Monday writes after this. If Anthropic takes
  // longer, the Lead still ships with placeholder demographic. Root-cause
  // fix for Aug 11 issue: JoAnn/Darren Logan contacts created 5x but Lead
  // never landed because Anthropic web_search timed out the whole function.
  try {
    const enrichment = await Promise.race([
      anthropicEnrichChurch(data.church, data.city, data.state, data.position),
      new Promise((resolve) => setTimeout(() => resolve({ __timeout: true }), 25000)),
    ]);
    if (enrichment?.__timeout) {
      console.warn("[enrich] Anthropic enrichment timed out at 25s — shipping Lead with placeholder demographic");
    } else if (enrichment) {
      if (enrichment.demographic) demographic = suspiciousPrefix + enrichment.demographic;
      if (!enrichedCity && enrichment.city) enrichedCity = enrichment.city;
      if (!enrichedState && enrichment.state) enrichedState = enrichment.state;
    }
  } catch (e) {
    console.warn("[enrich] church enrichment threw:", e.message);
  }

  const columnValues = {
    [LD_STAGE]:         { label: "New" },
    [LD_SOURCE]:        { label: "PPC Ads" },
    [LD_DATE]:          { date: todayISO() },
    [LD_LAST_ACTIVITY]: { date: todayISO() },
    [LD_FIT]:           { label: "Unknown" },
    [LD_INTERESTED]:    { label: "Interested" },
    [LD_TIMELINE]:      { label: timelineLabel },
    [LD_ATTENDANCE]:    { label: attendanceLabel },
    [LD_DEMOGRAPHIC]:   demographic,
  };
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

  const role = (data.position || "").trim();
  const church = (data.church || "").trim();
  const nameFallback = `${data.first || ""} ${data.last || ""}`.trim();
  let leadName;
  if (role && church)      leadName = `${role} @ ${church}`;
  else if (church)         leadName = `??? @ ${church}`;
  else if (role)           leadName = `${role} — ${nameFallback}`.trim();
  else                     leadName = nameFallback || "PPC lead";

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
      target_boards: { leads: LEADS_BOARD, contacts: CLIENT_CONTACTS_BOARD },
      hint: "POST with ?secret=... to sync a GHL contact to Monday",
    });
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Secret check
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

  // === PAYLOAD DEBUG LOGGING (added 2026-08-10) ===
  // Log full raw payload so we can see GHL's actual field structure.
  // Vercel captures console.log at Deployments → Logs. Search for "GHL_PAYLOAD".
  // Once we see 2-3 real payloads, we'll know the exact custom-field IDs to map.
  console.log("GHL_PAYLOAD_START", JSON.stringify({
    top_level_keys: Object.keys(body),
    contact_keys: body?.contact ? Object.keys(body.contact) : null,
    custom_fields_shape: body?.contact?.custom_fields
      ? (Array.isArray(body.contact.custom_fields)
          ? { type: "array", length: body.contact.custom_fields.length, sample: body.contact.custom_fields.slice(0, 2) }
          : { type: "object", keys: Object.keys(body.contact.custom_fields) })
      : (body?.custom_fields ? "top-level custom_fields exists" : "none"),
    full_payload: body,
  }));
  console.log("GHL_PAYLOAD_END");
  // === END DEBUG LOGGING ===

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
  const ghlContactId =
    pickField(body, "contact_id", "contactId", "contact.id", "id");
  const ghlContact = ghlContactId ? await ghlFetchContact(ghlContactId) : null;
  if (ghlContact) {
    console.log(`[ghl] enriched from /contacts/${ghlContactId} — customFields: ${(ghlContact.customFields || []).length}`);
  } else if (ghlContactId) {
    console.warn(`[ghl] failed to enrich contact ${ghlContactId} — falling back to webhook payload`);
  }

  // Read custom fields — prefer the fetched full contact, fall back to payload.
  const church =
    ghlGetCF(ghlContact, GHL_CF_CHURCH) ||
    pickCustomField(body, GHL_CF_CHURCH) ||
    pickField(body, "company_name", "companyName", "contact.company_name", "contact.companyName", "organization");
  const position =
    ghlGetCF(ghlContact, GHL_CF_POSITION) ||
    pickCustomField(body, GHL_CF_POSITION) ||
    pickField(body, "position", "position_hiring_for", "contact.position_hiring_for");
  const attendance =
    ghlGetCF(ghlContact, GHL_CF_ATTENDANCE) ||
    pickCustomField(body, GHL_CF_ATTENDANCE) ||
    pickField(body, "attendance", "weekly_attendance", "contact.weekly_attendance", "contact.attendance");
  const timeline =
    ghlGetCF(ghlContact, GHL_CF_TIMELINE) ||
    pickCustomField(body, GHL_CF_TIMELINE) ||
    pickField(body, "timeline", "ideal_timeline", "contact.ideal_timeline");

  const rawSource = pickField(body, "source", "contact.source", "trigger");
  const sourceLabel = "PPC Ads";

  // City + state — added to the form 2026-08-10. Read from payload if GHL
  // passes them through. Enrichment can fill these later if blank.
  const city  = pickField(body, "city", "contact.city");
  const state = pickField(body, "state", "contact.state");

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
  };

  // Always create the Contact row first (so we can link the Lead to it)
  const contactId = await createContact(mondayToken, data);

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

  return res.status(200).json({
    ok: true,
    contactId,
    leadId,
    sourceLabel,
    attendance,
    target: { leads: LEADS_BOARD, contacts: CLIENT_CONTACTS_BOARD },
  });
};
