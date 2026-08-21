/**
 * End-to-end test of the webhook handler with the network mocked.
 *
 * Run: node test/handler.test.js
 *
 * This is the test that could not exist before: the only way to exercise the
 * real handler used to be POSTing to production, which writes a junk row onto a
 * client's live board. Here fetch is stubbed for both GHL and monday, so the
 * whole path runs offline and we can assert on the exact monday mutation
 * variables the handler would have sent.
 *
 * Scenario 1 is the actual 2026-08-20 failure (Apostle Shands / Kervens):
 * the GHL contact lookup yields nothing and the payload carries GHL's dotted
 * field keys as FLAT keys. Before the fix that produced a bare person name with
 * Role and Timeline empty. It is the regression guard for this whole incident.
 */

const path = require("path");

const handler = require(path.join(__dirname, "..", "api", "ghl-webhook.js"));

let failed = 0;
function eq(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { failed++; console.log(`  FAIL ${label}\n       expected ${JSON.stringify(expected)}\n       got      ${JSON.stringify(actual)}`); }
  else console.log(`  ok   ${label}`);
}
function truthy(actual, label) {
  if (actual) console.log(`  ok   ${label}`);
  else { failed++; console.log(`  FAIL ${label} (got ${JSON.stringify(actual)})`); }
}
function falsy(actual, label) {
  if (!actual) console.log(`  ok   ${label}`);
  else { failed++; console.log(`  FAIL ${label} (got ${JSON.stringify(actual)})`); }
}

process.env.WEBHOOK_SECRET = "test-secret";
process.env.MONDAY_TOKEN = "test-monday-token";
process.env.GHL_TOKEN = "test-ghl-token";
delete process.env.ANTHROPIC_API_KEY; // skip church enrichment entirely

const CF = {
  role: "GEUd0b8wdH15F3Lx1URs",
  church: "w0sm9wpx7ODNrmJfqq9Q",
  attendance: "p4pYMUi5AsSoy6sGlH0w",
  timeline: "H2R6Qkt2dDGICqv0SLRl",
};

/**
 * @param ghlCustomFields  array to return from the GHL contact lookup, or null
 *                         to simulate the lookup yielding nothing usable
 */
function installFetchMock({ ghlCustomFields, searchCustomFields }) {
  const mondayCalls = [];
  global.fetch = async (url, opts = {}) => {
    const u = String(url);

    if (u.includes("leadconnectorhq.com")) {
      const contact = {
        id: "TESTCONTACT",
        phone: "+15557778888",
        customFields: (u.includes("/contacts/?") ? (searchCustomFields ?? ghlCustomFields) : ghlCustomFields) || [],
      };
      const payload = u.includes("/contacts/?") ? { contacts: [contact] } : { contact };
      return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
    }

    if (u.includes("api.monday.com")) {
      const parsed = JSON.parse(opts.body || "{}");
      mondayCalls.push(parsed);
      const isCreate = /create_item/.test(parsed.query || "");
      // items_page queries are the dedupe lookups — return no matches.
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: isCreate
            ? { create_item: { id: String(9000 + mondayCalls.length) } }
            : { boards: [{ items_page: { items: [] } }] },
        }),
        text: async () => "{}",
      };
    }
    throw new Error(`unexpected fetch to ${u}`);
  };
  return mondayCalls;
}

function makeRes() {
  const out = {};
  return {
    out,
    status(code) { out.code = code; return this; },
    json(payload) { out.body = payload; return this; },
  };
}

async function run({ ghlCustomFields, searchCustomFields, payload }) {
  const mondayCalls = installFetchMock({ ghlCustomFields, searchCustomFields });
  const res = makeRes();
  await handler({ method: "POST", query: { secret: "test-secret" }, body: payload }, res);
  const create = mondayCalls.filter(c => /create_item/.test(c.query || ""));
  const lead = create.find(c => String(c.variables?.board) === "18424840901");
  const contact = create.find(c => String(c.variables?.board) === "18424840911");
  return {
    res: res.out,
    leadName: lead?.variables?.name,
    leadCols: lead ? JSON.parse(lead.variables.cols) : null,
    contactCreated: !!contact,
  };
}

// ── Scenario 1 — THE 2026-08-20 FAILURE ─────────────────────────────────────
// GHL lookup yields nothing usable; payload carries GHL's own dotted field keys
// as flat keys. Pre-fix this produced a bare "Apostle Shands" with Role empty.
(async () => {
  console.log("\n1. Lookup yields nothing, payload has GHL's dotted keys (the live bug)");
  const r = await run({
    ghlCustomFields: null,
    payload: {
      "contact.id": "TESTCONTACT",
      contact_name: "Apostle Shands",
      first_name: "Apostle",
      last_name: "Shands",
      email: "shands@example.org",
      phone: "+15551234567",
      "contact.position_hiring_for": "Lead / Senior Pastor",
      "contact.ideal_timeline": "6+ Months",
      "contact.weekly_attendance": "1,000 - 2,499",
      submitted_at: "2026-08-20T23:33:13.230Z",
    },
  });
  eq(r.leadName, "Lead / Senior Pastor — ???", "title reads Role — ???, never a person name in the church slot");
  eq(r.leadCols?.text_mm5hcd2d, "Lead / Senior Pastor", "Role column filled from payload");
  eq(r.leadCols?.color_mm5hjjxz?.label, "6 - 12 months", "Timeline mapped from payload");
  eq(r.leadCols?.color_mm5he334?.label, "1,000 - 2,499", "Attendance mapped from payload");
  falsy(r.leadCols?.long_text_mm5hrgzb?.includes?.("ENRICHMENT GAP"), "no gap banner when everything resolved");
  truthy(r.contactCreated, "Client Contacts row still created");
  eq(r.res.code, 200, "returns 200 so GHL does not retry");

  // ── Scenario 2 — the healthy path still works ─────────────────────────────
  console.log("\n2. GHL lookup succeeds — contact record wins");
  const r2 = await run({
    ghlCustomFields: [
      { id: CF.role, value: "Worship Pastor / Music Director" },
      { id: CF.church, value: "Community Life" },
      { id: CF.attendance, value: "200 - 499" },
      { id: CF.timeline, value: "ASAP" },
    ],
    payload: {
      contact_id: "TESTCONTACT",
      first_name: "Mike", last_name: "Jones",
      email: "mike@example.org", phone: "+15551110000",
    },
  });
  eq(r2.leadName, "Worship Pastor / Music Director @ Community Life", "Role @ Church title");
  eq(r2.leadCols?.text_mm5h11je, "Community Life", "Church column");
  eq(r2.leadCols?.color_mm5hjjxz?.label, "ASAP", "Timeline ASAP still maps");
  eq(r2.res.code, 200, "200");

  // ── Scenario 3 — total enrichment failure is now visible, not silent ──────
  console.log("\n3. Nothing resolves anywhere — the gap is stated on the board");
  const r3 = await run({
    ghlCustomFields: null,
    payload: {
      contact_id: "TESTCONTACT",
      first_name: "Rory", last_name: "Comtois",
      email: "rory@example.org", phone: "+15552220000",
      submitted_at: "2026-08-20T23:33:13.230Z",
    },
  });
  // Nothing at all resolved: the person's name is the only identifier left, and
  // "??? — ???" would tell an SM nothing. This is the one case that keeps it.
  eq(r3.leadName, "Rory Comtois", "total failure still falls back to the person's name");
  truthy(r3.leadCols?.long_text_mm5hrgzb?.includes("ENRICHMENT GAP"), "gap banner present");
  truthy(r3.leadCols?.long_text_mm5hrgzb?.includes("role"), "banner names the missing fields");
  falsy(r3.leadCols?.color_mm5hjjxz, "Timeline column left blank, not stamped Unknown");
  falsy(r3.leadCols?.color_mm5he334, "Attendance column left blank, not fabricated from the timestamp");
  truthy(r3.leadCols?.long_text_mm5hrgzb?.length <= 1900, "demographic within monday's long_text limit");
  eq(r3.res.code, 200, "200");

  // ── Scenario 4 — the deep-scan must not steal an SM's identity ────────────
  console.log("\n4. Sibling objects in the payload cannot poison the lead");
  const r4 = await run({
    ghlCustomFields: null,
    payload: {
      contact_id: "TESTCONTACT",
      first_name: "Dana", last_name: "Reed",
      email: "dana@example.org", phone: "+15553330000",
      "contact.position_hiring_for": "Executive Pastor",
      user: { email: "sm@one39.co", position: "Staffing Manager", church_name: "Not A Church" },
      location: { name: "One39 HQ", church_name: "Also Not A Church" },
    },
  });
  eq(r4.leadCols?.text_mm5hcd2d, "Executive Pastor", "role comes from the contact, not the SM");
  falsy(r4.leadCols?.text_mm5h11je, "church NOT taken from the location object");
  truthy(r4.res.body?.diag?.payloadKeys?.includes("user"), "payload keys echoed for diagnosis");

  // ── Scenario 4b — city/state must survive to the monday columns ──────────
  console.log("\n4b. City and State reach the board from every source they can");
  const rCity = await run({
    ghlCustomFields: null,
    payload: {
      contact_id: "TESTCONTACT", first_name: "Pat", last_name: "Lin",
      email: "pat@example.org", phone: "+15554440000",
      "contact.position_hiring_for": "Executive Pastor",
      city: "Dallas", state: "tx",
    },
  });
  eq(rCity.leadCols?.text_mm5hke00, "Dallas", "City written from a flat payload key");
  eq(rCity.leadCols?.text_mm5h5vzx, "TX", "State normalized to 2-letter uppercase");
  truthy(rCity.res.body?.diag?.resolved?.city, "city reported in diag");

  const rNative = await run({
    ghlCustomFields: [{ id: CF.role, value: "Executive Pastor" }],
    payload: {
      contact_id: "TESTCONTACT", first_name: "Pat", last_name: "Lin",
      email: "pat@example.org", phone: "+15554440000",
      contact: { city: "Tulsa", state: "OK" },
    },
  });
  eq(rNative.leadCols?.text_mm5hke00, "Tulsa", "City read from a nested contact object");
  eq(rNative.leadCols?.text_mm5h5vzx, "OK", "State read from a nested contact object");

  const rLoc = await run({
    ghlCustomFields: [
      { id: CF.role, value: "Executive Pastor" },
      { id: "YqPGLHhoyynXXf3bPfVs", value: "Nashville, TN" },
    ],
    payload: {
      contact_id: "TESTCONTACT", first_name: "Pat", last_name: "Lin",
      email: "pat@example.org", phone: "+15554440000",
    },
  });
  eq(rLoc.leadCols?.text_mm5hke00, "Nashville", "City split out of the Location custom field");
  eq(rLoc.leadCols?.text_mm5h5vzx, "TN", "State split out of the Location custom field");

  // ── Scenario 4c — the second funnel's fields ─────────────────────────────
  // 20 of 700 contacts carry their church in "Name of organization" with
  // Church Name empty, and the role in "what position do you want to hire?".
  console.log("\n4c. Second-funnel fields are read, not dropped");
  const rAlt = await run({
    ghlCustomFields: [
      { id: "MI2gVKP3HtCFzE0PPztw", value: "Passion Vineyard Fellowship" },  // Name of organization
      { id: "Or55TMbK7iXHtEXrDY50", value: "Associate Pastor of Worship" },  // what position to hire
      { id: "UroWlloe7OceSzfAu1SK", value: "Lead Pastor" },                  // submitter's OWN title
      { id: "46Tu8iCoq2CKEgE3JrQE", value: "Apostolic/ pentecostal." },      // Notes
      { id: "MSpojZudzGhuuIDyPFRo", value: "Church" },                       // Type of organization
    ],
    payload: { contact_id: "TESTCONTACT", first_name: "Wade", last_name: "Buzzard",
               email: "wade@example.org", phone: "+15556660000" },
  });
  eq(rAlt.leadName, "Associate Pastor of Worship @ Passion Vineyard Fellowship",
     "church + role recovered from the second funnel's fields");
  eq(rAlt.leadCols?.text_mm5h11je, "Passion Vineyard Fellowship", "Church column from Name of organization");
  eq(rAlt.leadCols?.text_mm5hcd2d, "Associate Pastor of Worship", "Role is the OPENING, not the submitter's own title");
  truthy(!rAlt.leadCols?.text_mm5hcd2d?.includes("Lead Pastor"), "Job Title never mistaken for the opening");
  truthy(rAlt.leadCols?.long_text_mm5hrgzb?.includes('In their words: "Apostolic/ pentecostal."'),
     "the lead's own note reaches the board");
  truthy(rAlt.leadCols?.long_text_mm5hrgzb?.includes("Organization type: Church"), "org type surfaced");
  truthy(rAlt.res.body?.diag?.resolved?.notes, "notes reported in diag");

  // ── Scenario 4d — third identifier: phone ────────────────────────────────
  // The weeks-long outage happened because contact id AND email were both
  // unreadable from the payload. Phone is required on both forms, so it is the
  // backstop that makes identification fail-proof.
  console.log("\n4d. Phone finds the contact when id and email are unreadable");
  const rPhone = await run({
    ghlCustomFields: null,                                  // by-id yields nothing
    searchCustomFields: [                                   // but a search does
      { id: CF.role, value: "Executive Pastor" },
      { id: CF.church, value: "Grace Chapel" },
    ],
    payload: {
      first_name: "Dale", last_name: "Ng",
      phone: "(555) 777-8888",                              // no contact id, no email
    },
  });
  eq(rPhone.leadName, "Executive Pastor @ Grace Chapel", "recovered with phone alone");
  truthy(rPhone.res.body?.diag?.ghl?.trace?.some(t => /byPhone|usedPhoneSearch/.test(t)),
     "trace records the phone lookup");

  // ── Scenario 5 — response diagnostics ─────────────────────────────────────
  console.log("\n5. Response carries diagnostics but never lead PII");
  const blob = JSON.stringify(r3.res.body);
  falsy(blob.includes("rory@example.org"), "no email in the response");
  falsy(blob.includes("Rory"), "no lead name in the response");
  truthy(Array.isArray(r3.res.body?.diag?.ghl?.trace), "GHL trace present");
  truthy(r3.res.body?.diag?.ghl?.trace.length > 0, "trace is non-empty on a failed lookup");

  console.log("\n" + "=".repeat(58));
  if (failed) { console.log(`${failed} FAILED`); process.exit(1); }
  console.log("all handler tests passed");
})();
