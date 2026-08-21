/**
 * TEMPORARY diagnostic — delete once the GHL enrichment failure is understood.
 *
 * Why this exists: PPC leads keep landing on Monday with role/church empty even
 * though GHL holds the values. Every test so far has run from a laptop, which
 * proves nothing about what happens from Vercel's egress. Vercel's historical
 * runtime logs are not reachable from the CLI or the public API, so the
 * console.error ALARM inside ghl-webhook.js can't be read either.
 *
 * This endpoint runs the exact same lookups ghl-webhook.js runs, from inside the
 * same runtime, and reports what came back.
 *
 * SAFETY: read-only. Writes nothing to GHL, nothing to Monday. Returns custom
 * FIELD IDS and value lengths only, never values, so it leaks no lead PII and no
 * credentials. Gated behind a fixed token so it isn't an open probe.
 *
 * Usage:
 *   GET /api/ghl-diag?t=<TOKEN>&contactId=<id>[&email=<addr>]
 */

const DIAG_TOKEN = "d7f4a1c9-one39-diag-2026-08-20";

const GHL_API = "https://services.leadconnectorhq.com";
const GHL_API_VERSION = "2021-07-28";
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID || "l9GVEA91SsaZzg0pNW61";

// Same UA the deployed webhook uses, so this measures the real code path.
const GHL_UA = "Mozilla/5.0 (compatible; One39-PPC-Webhook/1.0; +https://hire.one39.co)";

const FIELD_NAMES = {
  GEUd0b8wdH15F3Lx1URs: "role",
  w0sm9wpx7ODNrmJfqq9Q: "church",
  p4pYMUi5AsSoy6sGlH0w: "attendance",
  H2R6Qkt2dDGICqv0SLRl: "timeline",
  YqPGLHhoyynXXf3bPfVs: "location",
};

/** Describe a fetch without ever echoing a value. */
async function probe(label, url, token, withUA) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Version: GHL_API_VERSION,
    Accept: "application/json",
  };
  if (withUA) headers["User-Agent"] = GHL_UA;

  const started = Date.now();
  try {
    const r = await fetch(url, { headers });
    const text = await r.text();
    const ms = Date.now() - started;

    const cloudflare = /cloudflare|error-?1010|client.?banned/i.test(text);

    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* non-JSON body */ }

    const record = parsed?.contact || (parsed?.contacts || [])[0] || null;
    const cf = Array.isArray(record?.customFields) ? record.customFields : [];

    return {
      label,
      ok: r.ok,
      status: r.status,
      ms,
      cloudflare_block: cloudflare,
      body_snippet: r.ok ? null : text.slice(0, 200),
      record_found: !!record,
      custom_field_count: cf.length,
      // ids + whether a value is present. Never the value itself.
      fields: cf.map(f => ({
        id: f.id,
        name: FIELD_NAMES[f.id] || "(other)",
        has_value: !!(f.value && String(f.value).trim()),
        value_length: f.value ? String(f.value).length : 0,
      })),
    };
  } catch (e) {
    return { label, ok: false, threw: e.message, ms: Date.now() - started };
  }
}

module.exports = async function handler(req, res) {
  if ((req.query?.t || "") !== DIAG_TOKEN) {
    return res.status(404).json({ error: "Not found" });
  }

  const token = process.env.GHL_TOKEN;
  if (!token) {
    return res.status(200).json({ fatal: "GHL_TOKEN is not set in this environment" });
  }

  const contactId = req.query?.contactId || null;
  const email = req.query?.email || null;

  const runtime = {
    node: process.version,
    region: process.env.VERCEL_REGION || null,
    vercel_env: process.env.VERCEL_ENV || null,
    token_length: token.length,
  };

  const probes = [];

  if (contactId) {
    // The exact call ghlFetchContact makes.
    probes.push(await probe("by-id WITH UA", `${GHL_API}/contacts/${contactId}`, token, true));
    // Same call with no UA — settles whether the UA is doing anything at all here.
    probes.push(await probe("by-id NO UA", `${GHL_API}/contacts/${contactId}`, token, false));
  }

  if (email) {
    probes.push(await probe(
      "email-search WITH UA",
      `${GHL_API}/contacts/?locationId=${GHL_LOCATION_ID}&query=${encodeURIComponent(email)}`,
      token,
      true,
    ));
  }

  // Location list call — works even with no contactId, so a bare hit still tells
  // us whether Vercel can reach GHL at all.
  probes.push(await probe(
    "location list WITH UA",
    `${GHL_API}/contacts/?locationId=${GHL_LOCATION_ID}&limit=1`,
    token,
    true,
  ));

  return res.status(200).json({ diagnostic: "ghl-reachability", runtime, probes });
}
