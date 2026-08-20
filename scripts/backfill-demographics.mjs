#!/usr/bin/env node
/**
 * Backfill Demographic column for all PPC Ads leads on the NEW Leads board.
 *
 * Per Will's 2026-08-10 rule change: Demographic must describe the CHURCH
 * (denomination, size, pastor + tenure, notable programs, culture), NOT the
 * lead record metadata. This script rewrites every existing PPC lead's
 * Demographic using the same Anthropic + web_search enrichment shipped in
 * commit 5c4d69e (webhook `anthropicEnrichChurch()`).
 *
 * Board:            18424840901  (Leads [NEW])
 * Filter:           Source column color_mm5hjwrs == "PPC Ads" (label idx 1)
 * Writes:           long_text_mm5hrgzb (Demographic)
 *                   text_mm5hke00     (City)  -- only if currently blank
 *                   text_mm5h5vzx     (State) -- only if currently blank
 * Does NOT touch:   Owner, Client Manager, Fit, Interested, Timeline, Stage,
 *                   Attendance, Role, Church, Contact Point
 *
 * Rate limits: 800ms between Anthropic calls, 300ms between Monday writes.
 * Persistence:  writes /tmp/demographic-backfill-results.json after each item.
 */

import fs from "node:fs";
import path from "node:path";

// ---- Config ---------------------------------------------------------------
const MONDAY_API   = "https://api.monday.com/v2";
const MONDAY_TOKEN = fs.readFileSync("/Users/will/.monday-token", "utf8").trim();

// Load ANTHROPIC_API_KEY from ~/work/clients/one39/.env
const envRaw = fs.readFileSync("/Users/will/work/clients/one39/.env", "utf8");
const anthropicKeyLine = envRaw.split("\n").find(l => l.startsWith("ANTHROPIC_API_KEY"));
if (!anthropicKeyLine) { console.error("ANTHROPIC_API_KEY not found in env"); process.exit(1); }
const ANTHROPIC_KEY = anthropicKeyLine.split("=", 2)[1].trim().replace(/^"|"$/g, "");

const BOARD_ID       = 18424840901;
const COL_SOURCE     = "color_mm5hjwrs";
const COL_DEMO       = "long_text_mm5hrgzb";
const COL_CITY       = "text_mm5hke00";
const COL_STATE      = "text_mm5h5vzx";
const COL_ROLE       = "text_mm5hcd2d";
const COL_CHURCH     = "text_mm5h11je";

const RESULTS_PATH   = "/tmp/demographic-backfill-results.json";

const ANTHROPIC_DELAY_MS = 800;
const MONDAY_DELAY_MS    = 300;

// Church names that are unparseable garbage → skip enrichment, write placeholder.
const GARBAGE_PATTERNS = [
  /^$/i,
  /^[\s\-–—]+$/,
  /^\d+$/,                    // pure numerics like "2052"
  /^1st$/i,
  /^first$/i,
  /^mile$/i,
  /^vic$/i,
  /^n\/?a$/i,
  /^none$/i,
  /^tbd$/i,
  /^unknown$/i,
  /^test$/i,
];

function isGarbageChurchName(name) {
  const s = (name || "").trim();
  if (s.length < 3) return true;                     // <3 chars = unparseable
  return GARBAGE_PATTERNS.some(re => re.test(s));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---- Monday helpers -------------------------------------------------------
async function mondayQuery(query, variables = {}) {
  const res = await fetch(MONDAY_API, {
    method: "POST",
    headers: {
      "Authorization": MONDAY_TOKEN,
      "Content-Type": "application/json",
      "API-Version": "2025-04",
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) {
    console.error("Monday errors:", JSON.stringify(json.errors));
    return { ok: false, errors: json.errors };
  }
  return { ok: true, data: json.data };
}

async function fetchAllPPCItems() {
  const items = [];
  let cursor = null;
  let page = 0;
  do {
    page++;
    const q = cursor
      ? `query ($cursor: String!) { next_items_page(cursor: $cursor, limit: 100) { cursor items { id name column_values(ids: ["${COL_SOURCE}","${COL_CHURCH}","${COL_CITY}","${COL_STATE}","${COL_ROLE}","${COL_DEMO}"]) { id text value } } } }`
      : `query { boards(ids: ${BOARD_ID}) { items_page(limit: 100, query_params: {rules: [{column_id: "${COL_SOURCE}", compare_value: [1]}]}) { cursor items { id name column_values(ids: ["${COL_SOURCE}","${COL_CHURCH}","${COL_CITY}","${COL_STATE}","${COL_ROLE}","${COL_DEMO}"]) { id text value } } } } }`;
    const r = cursor ? await mondayQuery(q, { cursor }) : await mondayQuery(q);
    if (!r.ok) throw new Error("Fetch failed on page " + page);
    const pageData = cursor ? r.data.next_items_page : r.data.boards[0].items_page;
    items.push(...pageData.items);
    cursor = pageData.cursor;
    console.log(`  page ${page}: +${pageData.items.length} items (total ${items.length}), cursor=${cursor ? "yes" : "done"}`);
  } while (cursor);
  return items;
}

async function writeItemColumns(itemId, updates) {
  // updates = { [colId]: string|object }
  const mutation = `
    mutation ($board: ID!, $item: ID!, $cols: JSON!) {
      change_multiple_column_values(board_id: $board, item_id: $item, column_values: $cols) {
        id
      }
    }
  `;
  const variables = {
    board: String(BOARD_ID),
    item: String(itemId),
    cols: JSON.stringify(updates),
  };
  return mondayQuery(mutation, variables);
}

// ---- Anthropic enrichment (mirrors ghl-webhook.js) -----------------------
async function anthropicEnrichChurch(church, city, state, role) {
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
- If MULTIPLE churches share the name and you can't tell which one (no city/state hint), return demographic="Multiple churches share this name — SM should confirm which location during discovery call." and city/state empty
- No fabrication — do not pick one of many matches at random`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_KEY,
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
      const errText = await res.text();
      console.warn(`  [anthropic] HTTP ${res.status}: ${errText.slice(0, 200)}`);
      return null;
    }
    const body = await res.json();
    const textBlocks = (body.content || []).filter(b => b.type === "text");
    const text = textBlocks.map(b => b.text).join("\n").trim();
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) { console.warn("  [anthropic] no JSON in response"); return null; }
    const parsed = JSON.parse(match[0]);
    // Strip Anthropic web_search <cite index="..."> tags — Monday auto-strips them
    // on write, but we want clean text in the local results file too.
    const stripCites = s => (s || "").replace(/<\/?cite[^>]*>/g, "").replace(/\s+/g, " ").trim();
    return {
      demographic: stripCites(parsed.demographic) || null,
      city: parsed.city || null,
      state: parsed.state || null,
    };
  } catch (e) {
    console.warn("  [anthropic] threw:", e.message);
    return null;
  }
}

// ---- Item processor ------------------------------------------------------
function getCol(item, id) {
  const c = (item.column_values || []).find(x => x.id === id);
  return c ? { text: c.text || "", value: c.value } : { text: "", value: null };
}

async function processItem(item) {
  const church = getCol(item, COL_CHURCH).text.trim();
  const city   = getCol(item, COL_CITY).text.trim();
  const state  = getCol(item, COL_STATE).text.trim();
  const role   = getCol(item, COL_ROLE).text.trim();
  const oldDemo = getCol(item, COL_DEMO).text;

  const result = {
    itemId: item.id,
    itemName: item.name,
    church,
    role,
    cityBefore: city,
    stateBefore: state,
    oldDemoPreview: (oldDemo || "").slice(0, 120),
    status: null,        // "garbage" | "enriched" | "unverified" | "error"
    newDemographic: null,
    cityWritten: null,
    stateWritten: null,
    error: null,
  };

  // Case 1: garbage church name → placeholder, no Anthropic call
  if (isGarbageChurchName(church)) {
    const placeholder = `Church name unclear on form ('${church || "(blank)"}') — SM should collect real church name during discovery call.`;
    result.status = "garbage";
    result.newDemographic = placeholder;
    const write = await writeItemColumns(item.id, { [COL_DEMO]: placeholder });
    if (!write.ok) { result.status = "error"; result.error = JSON.stringify(write.errors); }
    return result;
  }

  // Case 2: real name → enrich
  const enrichment = await anthropicEnrichChurch(church, city, state, role);
  if (!enrichment || !enrichment.demographic) {
    result.status = "error";
    result.error = "Anthropic returned null";
    return result;
  }

  result.newDemographic = enrichment.demographic;
  const demoLower = enrichment.demographic.toLowerCase();
  if (
    demoLower.includes("unable to verify") ||
    demoLower.includes("cannot verify") ||
    demoLower.includes("multiple churches share")
  ) {
    result.status = "unverified";
  } else {
    result.status = "enriched";
  }

  const updates = { [COL_DEMO]: enrichment.demographic };
  if (!city && enrichment.city && enrichment.city.trim()) {
    updates[COL_CITY] = enrichment.city.trim();
    result.cityWritten = enrichment.city.trim();
  }
  if (!state && enrichment.state && enrichment.state.trim()) {
    updates[COL_STATE] = enrichment.state.trim().toUpperCase();
    result.stateWritten = enrichment.state.trim().toUpperCase();
  }

  const write = await writeItemColumns(item.id, updates);
  if (!write.ok) { result.status = "error"; result.error = JSON.stringify(write.errors); }
  return result;
}

// ---- Main ----------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  const dryRun  = args.includes("--dry-run");
  const limitArg = args.find(a => a.startsWith("--limit="));
  const limit   = limitArg ? Number(limitArg.split("=")[1]) : null;

  console.log("=== Backfill Demographic (PPC leads) ===");
  console.log(`Board:   ${BOARD_ID}`);
  console.log(`DryRun:  ${dryRun}`);
  console.log(`Limit:   ${limit || "all"}`);
  console.log("");

  console.log("Fetching PPC items…");
  let items = await fetchAllPPCItems();
  console.log(`Total PPC items: ${items.length}`);

  if (limit) items = items.slice(0, limit);

  // Load prior results (resume-friendly)
  let results = [];
  if (fs.existsSync(RESULTS_PATH)) {
    try {
      results = JSON.parse(fs.readFileSync(RESULTS_PATH, "utf8"));
      console.log(`Loaded ${results.length} prior results — will skip those.`);
    } catch (e) { results = []; }
  }
  const doneIds = new Set(results.filter(r => r.status !== "error").map(r => r.itemId));

  const startedAt = Date.now();
  let processed = 0;
  for (const item of items) {
    processed++;
    if (doneIds.has(item.id)) {
      console.log(`[${processed}/${items.length}] SKIP already-done: ${item.name}`);
      continue;
    }
    console.log(`[${processed}/${items.length}] ${item.name}`);

    if (dryRun) {
      const church = getCol(item, COL_CHURCH).text.trim();
      console.log(`   church='${church}' garbage=${isGarbageChurchName(church)}`);
      continue;
    }

    try {
      const r = await processItem(item);
      // Replace any prior error entry for same id
      results = results.filter(x => x.itemId !== r.itemId);
      results.push(r);
      fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));
      console.log(`   → ${r.status}${r.cityWritten ? ` +city=${r.cityWritten}` : ""}${r.stateWritten ? ` +state=${r.stateWritten}` : ""}`);
      if (r.newDemographic) console.log(`   demo: ${r.newDemographic.slice(0, 140)}${r.newDemographic.length > 140 ? "…" : ""}`);
    } catch (e) {
      console.error(`   ERROR: ${e.message}`);
      results.push({ itemId: item.id, itemName: item.name, status: "error", error: e.message });
      fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));
    }

    // Rate limits: Anthropic first (heaviest), then a Monday breather
    await sleep(ANTHROPIC_DELAY_MS);
    await sleep(MONDAY_DELAY_MS);
  }

  const elapsedMin = ((Date.now() - startedAt) / 60000).toFixed(1);
  console.log(`\nDone in ${elapsedMin} min. Results at ${RESULTS_PATH}`);

  // Summary
  const byStatus = results.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {});
  console.log("\nSummary:");
  console.log(JSON.stringify(byStatus, null, 2));
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
