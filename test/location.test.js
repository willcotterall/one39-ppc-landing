/**
 * parseLocation regression suite.
 *
 * Every case below is a REAL value from the One39 GHL location's "Location"
 * custom field, captured 2026-08-21. That field is free text and the range is
 * wide — from "Atlanta" to "3605 E ZALESKY RD - Cottonwood, AZ 86326". A wrong
 * city is worse than a blank one, so anything unrecognised must yield nothing.
 *
 * Run: node test/location.test.js
 */
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "api", "ghl-webhook.js"), "utf8");
const a = SRC.indexOf("const US_STATES = {");
const b = SRC.indexOf("function normKey(", a);
// eslint-disable-next-line no-new-func
const parseLocation = new Function(SRC.slice(a, b) + "\nreturn parseLocation;")();

const CASES = [
  ["1199 Clay Street Winter Park, FL 32789", "Winter Park", "FL"],
  ["2416 2nd St, Richlands VA 24641",        "Richlands",   "VA"],
  ["3605 E ZALESKY RD - Cottonwood, AZ 86326","Cottonwood", "AZ"],
  ["5513 IH 35 South",                        "",           ""],
  ["Atlanta",                                 "Atlanta",    ""],
  ["Bethlehem PA",                            "Bethlehem",  "PA"],
  ["Bluffton, SC",                            "Bluffton",   "SC"],
  ["Eden Prairie, MN",                        "Eden Prairie","MN"],
  ["Las Vegas nv",                            "Las Vegas",  "NV"],
  ["Mesa, AZ",                                "Mesa",       "AZ"],
  ["Mount Pleasant, SC",                      "Mount Pleasant","SC"],
  ["Online",                                  "Online",     ""],
  ["San Antonio, TX",                         "San Antonio","TX"],
  ["Sioux Falls, SD",                         "Sioux Falls","SD"],
  ["Statesboro, Georgia",                     "Statesboro", "GA"],
  ["West Seneca, NY",                         "West Seneca","NY"],
  ["durham, nc",                              "Durham",     "NC"],
  ["largo florida",                           "Largo",      "FL"],
];
let bad=0;
for (const [inp, ec, es] of CASES){
  const r=parseLocation(inp);
  const ok = r.city===ec && r.state===es;
  if(!ok){bad++; console.log(`  FAIL ${JSON.stringify(inp)}\n       want ${ec}/${es}  got ${r.city}/${r.state}`);}
  else console.log(`  ok   ${JSON.stringify(inp).padEnd(42)} -> ${r.city||"(none)"} / ${r.state||"(none)"}`);
}
console.log(bad? `\n${bad} FAILED` : "\nall 18 real Location values parse correctly");
process.exit(bad?1:0);
