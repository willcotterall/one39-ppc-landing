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
 * merge object; we dual-write to Client Contacts + Leads/Deals boards.
 *
 * No dependencies — pure Node.js serverless function (fetch is native ≥ Node 18).
 */

const MONDAY_API = "https://api.monday.com/v2";
const CLIENT_CONTACTS_BOARD = 3503945069;
const LEADS_DEALS_BOARD = 3503945052;

// Client Contacts board — column IDs (verified 2026-07-06)
const CC_FIRST = "text9";
const CC_LAST = "text";
const CC_ORG = "text8";
const CC_PHONE = "phone";
const CC_EMAIL = "email";
const CC_DATE = "date_mkpny1wf";
const CC_RELATIONSHIP = "status";
const CC_COMMENTS = "long_text4";
const CC_OWNERSHIP = "people__1";

// Search Manager user IDs (Monday.com)
const USER_OWEN = 91705318;

// Sub-200 attendance strings we should route to Owen for nurture
function isSubTwoHundred(attendance) {
  if (!attendance) return false;
  const s = String(attendance).toLowerCase();
  return s.includes("under 200") || s.includes("<200") || s.includes("< 200");
}

// Leads/Deals board — column IDs
const LD_STAGE = "status";
const LD_SOURCE = "color_mm2frs0y";
const LD_DATE = "date_mm2fvkk3";
const LD_CONTACT_LINK = "link_to___accounts";

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

async function createContact(token, data) {
  const subTwoHundred = isSubTwoHundred(data.attendance);
  const commentPrefix = subTwoHundred
    ? `🔵 NURTURE — Small Church (Under 200) — Assigned to Owen. `
    : "";
  const columnValues = {
    [CC_FIRST]: data.first,
    [CC_LAST]: data.last,
    [CC_ORG]: data.church,
    [CC_DATE]: { date: todayISO() },
    [CC_RELATIONSHIP]: { index: 3 }, // "Cold Reach Out"
    [CC_COMMENTS]: `${commentPrefix}Auto-created from GHL webhook. Source: ${data.source}. Attendance: ${data.attendance || "n/a"}. Position: ${data.position || "n/a"}. Timeline: ${data.timeline || "n/a"}.`,
  };
  if (subTwoHundred) {
    columnValues[CC_OWNERSHIP] = { personsAndTeams: [{ id: USER_OWEN, kind: "person" }] };
  }
  if (data.email) columnValues[CC_EMAIL] = { email: data.email, text: data.email };
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

  const res = await fetch(MONDAY_API, {
    method: "POST",
    headers: { Authorization: token, "Content-Type": "application/json" },
    body: JSON.stringify({ query: mutation, variables }),
  });
  const json = await res.json();
  if (json.errors) {
    console.error("Contact create errors:", JSON.stringify(json.errors));
    return null;
  }
  return json.data?.create_item?.id ?? null;
}

async function createDeal(token, data) {
  const columnValues = {
    [LD_STAGE]: { label: "New" },
    [LD_SOURCE]: { label: data.sourceLabel },
    [LD_DATE]: { date: todayISO() },
  };
  if (data.contactItemId) {
    columnValues[LD_CONTACT_LINK] = { item_ids: [Number(data.contactItemId)] };
  }

  const dealName = `${data.first} ${data.last} — ${data.church}`.trim() || "PPC lead";
  const mutation = `
    mutation ($board: ID!, $name: String!, $cols: JSON!) {
      create_item(board_id: $board, item_name: $name, column_values: $cols, create_labels_if_missing: true) {
        id
      }
    }
  `;
  const variables = {
    board: String(LEADS_DEALS_BOARD),
    name: dealName,
    cols: JSON.stringify(columnValues),
  };

  const res = await fetch(MONDAY_API, {
    method: "POST",
    headers: { Authorization: token, "Content-Type": "application/json" },
    body: JSON.stringify({ query: mutation, variables }),
  });
  const json = await res.json();
  if (json.errors) {
    console.error("Deal create errors:", JSON.stringify(json.errors));
    return null;
  }
  return json.data?.create_item?.id ?? null;
}

module.exports = async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      route: "/api/ghl-webhook",
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
  const church = pickField(
    body,
    "company_name",
    "companyName",
    "contact.company_name",
    "contact.companyName",
    "organization",
  );
  const rawSource = pickField(body, "source", "contact.source", "trigger");
  const sourceLabel =
    rawSource && !/ppc/i.test(rawSource) ? rawSource : "PPC Ads";
  const attendance = pickField(
    body,
    "attendance",
    "weekly_attendance",
    "contact.weekly_attendance",
    "contact.attendance",
  );
  const position = pickField(
    body,
    "position",
    "position_hiring_for",
    "contact.position_hiring_for",
  );
  const timeline = pickField(
    body,
    "timeline",
    "ideal_timeline",
    "contact.ideal_timeline",
  );

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
    source: rawSource || sourceLabel,
    attendance,
    position,
    timeline,
  };

  const subTwoHundred = isSubTwoHundred(attendance);
  const route = subTwoHundred ? "nurture (sub-200 → Owen)" : "active pipeline";

  // Always create the Contact row
  const contactId = await createContact(mondayToken, data);

  // Create Deal row ONLY for active pipeline (200+). Sub-200 stays contact-only.
  let dealId = null;
  if (!subTwoHundred) {
    dealId = await createDeal(mondayToken, {
      first,
      last,
      church,
      contactItemId: contactId,
      sourceLabel,
    });
  }

  if (!contactId && !dealId) {
    return res.status(502).json({ error: "Monday writes failed" });
  }

  return res
    .status(200)
    .json({ ok: true, contactId, dealId, sourceLabel, route, attendance });
}
