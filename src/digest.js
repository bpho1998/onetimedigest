/**
 * SF Fillmore Research Report — One-time comprehensive intelligence snapshot.
 *
 * Sources:
 *   ✅ SF Ethics Lobbyist Activity  (s4ub-8j3t)
 *   ✅ SF Ethics Campaign Finance   (pitq-e56w)
 *   ⚠️  SF DBI Building Permits     (i98e-djp9) — description text only, no name fields
 *   ❌ SF Assessor Recorded Docs    — no public API; search manually at recorder.sfgov.org
 */

const https = require("https");

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const SINCE_DATE = process.env.SINCE_DATE || "2018-01-01";

const SEARCH_TERMS = [
  "Upper Fillmore Revitalization",
  "Aegis Reserve",
  "Fillmore Reserve",
  "Cody Allen",
  "Maven Properties",
  "SF Reserve Foundation",
  "Sam Singer",
  "Singer Associates",
  "Neil Mehta",
  "Lighthouse Public Affairs",
  "Peterson, Rich",
  "North Room LLC",
  "Pointed Blue LLC",
  "Shaded Flame LLC",
  "Temperate Lands LLC",
  "White Birches LLC",
];

const SOURCES = [
  {
    id: "lobbyist_activity",
    url: "https://data.sfgov.org/resource/s4ub-8j3t.json",
    dateField: "date",
    textFields: ["lobbyistname", "firmname", "clientname", "description", "employeename", "candidatename"],
    linkTemplate: (r) => r.fromfiling ? `https://netfile.com/app/lobbyist/filing/${r.fromfiling}/report` : "https://netfile.com/lobbyistpub/#sfo",
  },
  {
    id: "campaign_finance",
    url: "https://data.sfgov.org/resource/pitq-e56w.json",
    dateField: "filing_date",
    textFields: ["filer_name", "transaction_first_name", "transaction_last_name", "transaction_employer", "transaction_occupation", "transaction_description"],
    linkTemplate: (r) => r.filing_id_number ? `https://netfile.com/pub2/api/filing/${r.filing_id_number}/detail?aid=sfo` : "https://sfethics.org/disclosures/campaign-finance-disclosure",
  },
  {
    id: "building_permits",
    url: "https://data.sfgov.org/resource/i98e-djp9.json",
    dateField: "filed_date",
    textFields: ["description", "street_name"],
    linkTemplate: (r) => r.permit_number ? `https://dbiweb02.sfgov.org/dbipts/default.aspx?permit=${r.permit_number}` : "https://sfdbi.org/dbipts",
  },
];

// ─── HTTP ─────────────────────────────────────────────────────────────────────

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { Accept: "application/json" } }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch (e) { reject(new Error(`Parse error: ${e.message}`)); } });
    }).on("error", reject);
  });
}

function postJSON(url, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const u = new URL(url);
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } },
      (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve({ status: res.statusCode, body: d })); }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// ─── Matching ─────────────────────────────────────────────────────────────────

function matchedTerms(row, textFields) {
  const haystack = textFields.map((f) => (row[f] || "").toString().toLowerCase()).join(" ");
  return SEARCH_TERMS.filter((t) => haystack.includes(t.toLowerCase()));
}

// ─── Fetch all data ───────────────────────────────────────────────────────────

async function fetchAllMatches() {
  const results = { lobbyist_activity: [], campaign_finance: [], building_permits: [] };
  for (const source of SOURCES) {
    console.log(`\n📡 Fetching ${source.id}…`);
    let offset = 0, total = 0;
    while (true) {
      const where = encodeURIComponent(`${source.dateField} >= '${SINCE_DATE}'`);
      const order = encodeURIComponent(`${source.dateField} ASC`);
      const url = `${source.url}?$where=${where}&$order=${order}&$limit=1000&$offset=${offset}`;
      let rows;
      try { rows = await fetchJSON(url); } catch (e) { console.error(`  ❌ ${e.message}`); break; }
      if (!Array.isArray(rows) || rows.length === 0) break;
      total += rows.length;
      for (const row of rows) {
        const terms = matchedTerms(row, source.textFields);
        if (terms.length > 0) results[source.id].push({ row, terms, link: source.linkTemplate(row) });
      }
      if (rows.length < 1000) break;
      offset += 1000;
      await new Promise((r) => setTimeout(r, 300));
    }
    console.log(`  ↳ ${total} rows scanned → ${results[source.id].length} matches`);
  }
  return results;
}

// ─── Discord embed helpers ────────────────────────────────────────────────────

// Discord limits: 6000 total chars per embed (title + description + all fields + footer)
// We keep description under 3000 and titles short to stay safely under 6000 total.
const DESC_MAX = 3000;

function makeEmbed(title, color, description, footer) {
  const d = description.length > DESC_MAX ? description.slice(0, DESC_MAX - 2) + "…" : description;
  const e = { title, color, description: d };
  if (footer) e.footer = { text: footer };
  return e;
}

// Split a body string into multiple embeds if it exceeds DESC_MAX
function splitEmbeds(baseTitle, color, body, footer) {
  if (body.length <= DESC_MAX) return [makeEmbed(baseTitle, color, body, footer)];
  const out = [];
  let rem = body, part = 1;
  while (rem.length > 0) {
    const chunk = rem.slice(0, DESC_MAX);
    const cut = chunk.lastIndexOf("\n") > DESC_MAX * 0.7 ? chunk.lastIndexOf("\n") : DESC_MAX;
    const text = rem.slice(0, cut);
    rem = rem.slice(cut).trimStart();
    const isLast = rem.length === 0;
    out.push(makeEmbed(`${baseTitle} (${part})`, color, text, isLast ? footer : undefined));
    part++;
  }
  return out;
}

const B = (s) => `**${s}**`;
const M = (s) => `\`${s}\``;

// ─── Build: Cover ─────────────────────────────────────────────────────────────

function buildCover(matches, runDate) {
  const lob = matches.lobbyist_activity.length;
  const fin = matches.campaign_finance.length;
  const per = matches.building_permits.length;
  const allDates = [
    ...matches.lobbyist_activity.map(({ row }) => row.date),
    ...matches.campaign_finance.map(({ row }) => row.filing_date),
    ...matches.building_permits.map(({ row }) => row.filed_date),
  ].filter(Boolean).map((d) => d.slice(0, 10)).sort();

  return [makeEmbed(
    "🔍 Fillmore/Mehta Intelligence Report",
    0x1a1a2e,
    `Full-record synthesis of all public SF filings related to Neil Mehta and the Upper Fillmore Revitalization Project.\n\n` +
    `**Generated:** ${runDate} | **Data from:** ${allDates[0] || "—"} → ${allDates[allDates.length - 1] || "—"}\n\n` +
    `> 🏛 Lobbying filings: **${lob}**\n` +
    `> 💰 Campaign finance: **${fin}** transactions\n` +
    `> 🏗 Permit matches: **${per}**\n` +
    `> 🏠 Property recordings: _No public API — search_ https://recorder.sfgov.org\n\n` +
    `**Tracked (${SEARCH_TERMS.length}):** ${SEARCH_TERMS.map(M).join(" • ")}`,
    "SF Fillmore Report • DataSF • One-time snapshot"
  )];
}

// ─── Build: Lobbying ──────────────────────────────────────────────────────────
// With 4500+ records we must summarize tightly — one line per firm/client pair.

function buildLobbying(lob) {
  if (lob.length === 0) return [makeEmbed("🏛 1. Lobbying Activity", 0xe74c3c, "No records found.")];

  const dates = lob.map(({ row }) => row.date).filter(Boolean).map((d) => d.slice(0, 10)).sort();

  // Aggregate: firm → { clients: Map<client, {count, first, last, officials}> }
  const byFirm = new Map();
  const officialCounts = new Map();

  for (const { row, link } of lob) {
    const firm = row.firmname || "Independent";
    const lobbyist = row.lobbyistname || "Unknown";
    const client = row.clientname || "Unknown";
    const date = row.date ? row.date.slice(0, 10) : "9999";
    const official = row.employeename || row.candidatename;

    const firmKey = `${firm} — ${lobbyist}`;
    if (!byFirm.has(firmKey)) byFirm.set(firmKey, new Map());
    const clientMap = byFirm.get(firmKey);
    if (!clientMap.has(client)) clientMap.set(client, { count: 0, first: date, last: date, officials: new Set(), link });
    const entry = clientMap.get(client);
    entry.count++;
    if (date < entry.first) entry.first = date;
    if (date > entry.last) entry.last = date;
    if (official) entry.officials.add(official);

    if (official) {
      if (!officialCounts.has(official)) officialCounts.set(official, { count: 0, clients: new Set() });
      officialCounts.get(official).count++;
      officialCounts.get(official).clients.add(client);
    }
  }

  // Summary header
  const firms = [...new Set([...byFirm.keys()])];
  const clients = [...new Set(lob.map(({ row }) => row.clientname).filter(Boolean))];

  let body =
    `**${lob.length} filings** | ${dates[0]} → ${dates[dates.length - 1]}\n` +
    `**Firms/lobbyists:** ${firms.length} | **Clients:** ${clients.length}\n\n`;

  // One compact line per firm→client pair
  for (const [firmKey, clientMap] of byFirm) {
    body += `**${firmKey}**\n`;
    for (const [client, { count, first, last, officials, link }] of clientMap) {
      const offStr = officials.size > 0 ? ` | Officials: ${[...officials].slice(0, 3).join(", ")}${officials.size > 3 ? ` +${officials.size - 3}` : ""}` : "";
      body += `  ↳ ${client}: ${count} filings (${first.slice(0, 7)} → ${last.slice(0, 7)})${offStr} [↗](${link})\n`;
    }
    body += "\n";
  }

  const embeds = splitEmbeds("🏛 1. Lobbying Activity", 0xe74c3c, body);

  // Officials section — compact, one line each
  if (officialCounts.size > 0) {
    let oBody = `**${officialCounts.size} city official(s) contacted:**\n\n`;
    [...officialCounts.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .forEach(([name, { count, clients }]) => {
        oBody += `• **${name}** — ${count}x | for: ${[...clients].join(", ")}\n`;
      });
    embeds.push(...splitEmbeds("🏛 1b. Officials Contacted", 0xc0392b, oBody));
  }

  return embeds;
}

// ─── Build: Campaign Finance ──────────────────────────────────────────────────

function buildFinance(fin) {
  if (fin.length === 0) return [makeEmbed("💰 2. Campaign Finance", 0x27ae60, "No records found.")];

  const rows = fin.map(({ row, link }) => ({
    contributor: [row.transaction_first_name, row.transaction_last_name].filter(Boolean).join(" ") || "Unknown",
    employer: row.transaction_employer || "—",
    recipient: row.filer_name || "Unknown",
    amount: Number(row.transaction_amount_1 || 0),
    date: (row.transaction_date || row.filing_date || "").slice(0, 10),
    link,
  })).sort((a, b) => b.amount - a.amount);

  const total = rows.reduce((s, r) => s + r.amount, 0);
  const dates = rows.map((r) => r.date).filter(Boolean).sort();

  const byRecipient = new Map();
  for (const r of rows) {
    if (!byRecipient.has(r.recipient)) byRecipient.set(r.recipient, []);
    byRecipient.get(r.recipient).push(r);
  }

  let body =
    `**${rows.length} transactions** | **Total: $${total.toLocaleString()}**\n` +
    `${dates[0] || "—"} → ${dates[dates.length - 1] || "—"}\n\n`;

  for (const [recipient, contribs] of [...byRecipient.entries()]
    .sort((a, b) => b[1].reduce((s, r) => s + r.amount, 0) - a[1].reduce((s, r) => s + r.amount, 0))) {
    const sub = contribs.reduce((s, r) => s + r.amount, 0);
    body += `**→ ${recipient}** $${sub.toLocaleString()} (${contribs.length})\n`;
    for (const { contributor, employer, amount, date, link } of contribs.slice(0, 6)) {
      body += `  • ${date} | **${contributor}**${employer !== "—" ? ` (${employer})` : ""} | $${amount.toLocaleString()} [↗](${link})\n`;
    }
    if (contribs.length > 6) body += `  • …and ${contribs.length - 6} more\n`;
    body += "\n";
  }

  return splitEmbeds("💰 2. Campaign Finance", 0x27ae60, body);
}

// ─── Build: Permits ───────────────────────────────────────────────────────────

function buildPermits(per) {
  if (per.length === 0) return [makeEmbed("🏗 3. Building Permits", 0xf39c12,
    "No matches found.\n\n_Note: The DBI dataset has no applicant/owner name fields — only permit description text is searchable. Matches reflect permits mentioning tracked terms in the work description._")];

  const byAddr = new Map();
  for (const { row, terms, link } of per) {
    const addr = [row.street_number, row.street_name, row.street_suffix].filter(Boolean).join(" ") || "Unknown";
    if (!byAddr.has(addr)) byAddr.set(addr, []);
    byAddr.get(addr).push({
      num: row.permit_number || "—",
      desc: (row.description || "—").slice(0, 80),
      status: row.status || "—",
      date: (row.filed_date || "").slice(0, 10),
      cost: row.estimated_cost ? `$${Number(row.estimated_cost).toLocaleString()}` : null,
      link,
    });
  }

  const dates = per.map(({ row }) => row.filed_date).filter(Boolean).map((d) => d.slice(0, 10)).sort();
  let body = `**${per.length} permit(s)** across **${byAddr.size} address(es)**\n${dates[0] || "—"} → ${dates[dates.length - 1] || "—"}\n\n`;

  for (const [addr, permits] of byAddr) {
    body += `📍 **${addr}**\n`;
    for (const { num, desc, status, date, cost, link } of permits.sort((a, b) => b.date.localeCompare(a.date))) {
      body += `  • ${M(num)} | ${status} | ${date}${cost ? ` | ${cost}` : ""}\n    ${desc} [↗](${link})\n`;
    }
    body += "\n";
  }

  return splitEmbeds("🏗 3. Building Permits", 0xf39c12, body);
}

// ─── Build: Entity Network ────────────────────────────────────────────────────

function buildNetwork(matches) {
  const counts = new Map(SEARCH_TERMS.map((t) => [t, 0]));
  const sources = new Map(SEARCH_TERMS.map((t) => [t, new Set()]));
  const labels = { lobbyist_activity: "Lobbying", campaign_finance: "Finance", building_permits: "Permits" };

  for (const src of SOURCES) {
    for (const { terms } of matches[src.id]) {
      for (const t of terms) {
        counts.set(t, (counts.get(t) || 0) + 1);
        sources.get(t)?.add(src.id);
      }
    }
  }

  const firms = [...new Set(matches.lobbyist_activity.map(({ row }) => row.firmname).filter(Boolean))];
  const clients = [...new Set(matches.lobbyist_activity.map(({ row }) => row.clientname).filter(Boolean))];
  const recipients = [...new Set(matches.campaign_finance.map(({ row }) => row.filer_name).filter(Boolean))];

  let body = "**Record count per tracked entity:**\n\n";
  [...counts.entries()].filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1]).forEach(([t, c]) => {
    const srcs = [...(sources.get(t) || [])].map((s) => labels[s]).join(", ");
    body += `• **${t}**: ${c} [${srcs}]\n`;
  });
  if (firms.length) { body += `\n**Lobbying firms:**\n${firms.map((f) => `• ${f}`).join("\n")}\n`; }
  if (clients.length) { body += `\n**Lobbying clients:**\n${clients.map((c) => `• ${c}`).join("\n")}\n`; }
  if (recipients.length) { body += `\n**Campaign recipients:**\n${recipients.map((r) => `• ${r}`).join("\n")}\n`; }

  return splitEmbeds("🕸 4. Entity Network", 0x2980b9, body);
}

// ─── Build: Reporter Briefing ─────────────────────────────────────────────────

function buildBriefing(matches, runDate) {
  const lob = matches.lobbyist_activity;
  const fin = matches.campaign_finance;
  const per = matches.building_permits;

  const firms = [...new Set(lob.map(({ row }) => row.firmname).filter(Boolean))];
  const clients = [...new Set(lob.map(({ row }) => row.clientname).filter(Boolean))];
  const officials = [...new Set(lob.map(({ row }) => row.employeename || row.candidatename).filter(Boolean))];
  const totalMoney = fin.reduce((s, { row }) => s + Number(row.transaction_amount_1 || 0), 0);
  const recipients = [...new Set(fin.map(({ row }) => row.filer_name).filter(Boolean))];
  const addresses = [...new Set(per.map(({ row }) => [row.street_number, row.street_name].filter(Boolean).join(" ")).filter(Boolean))];
  const lobDates = lob.map(({ row }) => row.date).filter(Boolean).map((d) => d.slice(0, 10)).sort();

  const lines = [];

  if (lob.length > 0) {
    lines.push(
      `**Lobbying:** ${firms.join(" and ")} filed **${lob.length} lobbying disclosure(s)** on behalf of ` +
      `${clients.join(", ")} from ${lobDates[0]} to ${lobDates[lobDates.length - 1]}. ` +
      (officials.length > 0
        ? `City officials contacted include **${officials.slice(0, 5).join(", ")}**${officials.length > 5 ? ` and ${officials.length - 5} others` : ""}.`
        : "No official contact records in the dataset.")
    );
  }
  if (fin.length > 0) {
    lines.push(
      `**Political money:** $${totalMoney.toLocaleString()} across **${fin.length} transaction(s)** ` +
      `flowing to ${recipients.join(", ") || "unknown committees"}.`
    );
  }
  if (per.length > 0) {
    lines.push(
      `**Construction:** **${per.length} permit(s)** referencing tracked terms filed at ` +
      `${addresses.slice(0, 4).join("; ")}${addresses.length > 4 ? " and others" : ""}.`
    );
  }
  lines.push(
    `**Property records:** No public API available for SF recorded deeds. Search manually at ` +
    `https://recorder.sfgov.org using: Fillmore Reserve, North Room LLC, Pointed Blue LLC, ` +
    `Shaded Flame LLC, Temperate Lands LLC, White Birches LLC, Aegis Reserve.`
  );

  return [makeEmbed(
    "📰 5. Reporter's Briefing",
    0x2c3e50,
    `_Synthesis as of ${runDate}:_\n\n${lines.join("\n\n")}\n\n` +
    `---\n_One-time snapshot. All data from DataSF open data. Links go directly to source records._`,
    `SF Fillmore Intelligence Report • ${runDate}`
  )];
}

// ─── Post to Discord ──────────────────────────────────────────────────────────

async function postToDiscord(embeds) {
  if (!DISCORD_WEBHOOK_URL) {
    console.log(`[DRY RUN] ${embeds.length} embeds. Sizes:`);
    embeds.forEach((e, i) => console.log(`  ${i + 1}: "${e.title}" — ${JSON.stringify(e).length} chars`));
    return;
  }
  for (let i = 0; i < embeds.length; i += 10) {
    const batch = embeds.slice(i, i + 10);
    const result = await postJSON(DISCORD_WEBHOOK_URL, { embeds: batch });
    const batchNum = Math.floor(i / 10) + 1;
    if (result.status >= 300) {
      console.error(`❌ Discord error ${result.status} on batch ${batchNum}:`, result.body);
    } else {
      console.log(`✅ Batch ${batchNum} of ${Math.ceil(embeds.length / 10)} posted`);
    }
    if (i + 10 < embeds.length) await new Promise((r) => setTimeout(r, 1500));
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const runDate = new Date().toISOString().slice(0, 10);
  console.log("═".repeat(60));
  console.log(`SF Fillmore Report | ${runDate} | Since: ${SINCE_DATE} | Webhook: ${!!DISCORD_WEBHOOK_URL}`);
  console.log("═".repeat(60));

  const matches = await fetchAllMatches();
  const total = Object.values(matches).reduce((s, a) => s + a.length, 0);
  console.log(`\n✅ Total matches: ${total}`);

  const embeds = [
    ...buildCover(matches, runDate),
    ...buildLobbying(matches.lobbyist_activity),
    ...buildFinance(matches.campaign_finance),
    ...buildPermits(matches.building_permits),
    ...buildNetwork(matches),
    ...buildBriefing(matches, runDate),
  ];

  console.log(`📨 Posting ${embeds.length} embeds to Discord…`);
  await postToDiscord(embeds);
  console.log("\nReport complete.");
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
