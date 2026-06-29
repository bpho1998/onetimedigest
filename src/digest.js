/**
 * SF Fillmore Research Report — One-time comprehensive intelligence snapshot.
 *
 * Discord strategy: each section posts EXACTLY ONE embed with a tight summary.
 * All counts, key names, date ranges, and notable items — no per-record listing.
 * Links point to the live source for full drill-down.
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
    linkTemplate: (r) => r.fromfiling
      ? `https://netfile.com/app/lobbyist/filing/${r.fromfiling}/report`
      : "https://netfile.com/lobbyistpub/#sfo",
  },
  {
    id: "campaign_finance",
    url: "https://data.sfgov.org/resource/pitq-e56w.json",
    dateField: "filing_date",
    textFields: ["filer_name", "transaction_first_name", "transaction_last_name", "transaction_employer", "transaction_occupation", "transaction_description"],
    linkTemplate: (r) => r.filing_id_number
      ? `https://netfile.com/pub2/api/filing/${r.filing_id_number}/detail?aid=sfo`
      : "https://sfethics.org/disclosures/campaign-finance-disclosure",
  },
  {
    id: "building_permits",
    url: "https://data.sfgov.org/resource/i98e-djp9.json",
    dateField: "filed_date",
    textFields: ["description", "street_name"],
    linkTemplate: (r) => r.permit_number
      ? `https://dbiweb02.sfgov.org/dbipts/default.aspx?permit=${r.permit_number}`
      : "https://sfdbi.org/dbipts",
  },
];

// ─── HTTP ─────────────────────────────────────────────────────────────────────

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { Accept: "application/json" } }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Parse error: ${e.message}`)); }
      });
    }).on("error", reject);
  });
}

function postJSON(url, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const u = new URL(url);
    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method: "POST",
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

// ─── Fetch ────────────────────────────────────────────────────────────────────

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
    console.log(`  ↳ ${total} rows → ${results[source.id].length} matches`);
  }
  return results;
}

// ─── Embed builder — guaranteed single embed per section ──────────────────────
// Hard cap: description ≤ 2000 chars. Title ≤ 100. No fields used.
// Total embed JSON will be well under Discord's 6000 char limit.

function embed(title, color, description, footerText) {
  const MAX = 2000;
  const d = description.length > MAX ? description.slice(0, MAX - 1) + "…" : description;
  const e = { title: title.slice(0, 100), color, description: d };
  if (footerText) e.footer = { text: footerText.slice(0, 200) };
  return e;
}

function ul(items) { return items.map((s) => `• ${s}`).join("\n"); }
function b(s) { return `**${s}**`; }
function m(s) { return `\`${s}\``; }
function pct(n, total) { return total > 0 ? ` (${Math.round(n / total * 100)}%)` : ""; }

// ─── Section builders — one embed each, fixed summary format ─────────────────

function coverEmbed(matches, runDate) {
  const lob = matches.lobbyist_activity.length;
  const fin = matches.campaign_finance.length;
  const per = matches.building_permits.length;

  const allDates = [
    ...matches.lobbyist_activity.map(({ row }) => row.date),
    ...matches.campaign_finance.map(({ row }) => row.filing_date),
  ].filter(Boolean).map((d) => d.slice(0, 10)).sort();

  return embed(
    "🔍 Fillmore/Mehta Intelligence Report",
    0x1a1a2e,
    `Full-record synthesis of all public SF filings related to Neil Mehta and the Upper Fillmore Revitalization Project.\n\n` +
    `**Generated:** ${runDate}\n` +
    `**Records span:** ${allDates[0] || "—"} → ${allDates[allDates.length - 1] || "—"}\n\n` +
    `**🏛 Lobbying filings:** ${lob}\n` +
    `**💰 Campaign finance:** ${fin} transactions\n` +
    `**🏗 Permit matches:** ${per}\n` +
    `**🏠 Property recordings:** No public API — search manually at recorder.sfgov.org\n\n` +
    `**Tracked entities:** ${SEARCH_TERMS.map(m).join(" ")}`,
    "SF Fillmore Report • DataSF • One-time snapshot"
  );
}

function lobbyingEmbed(lob) {
  if (lob.length === 0) return embed("🏛 1. Lobbying Activity", 0xe74c3c, "No records found.");

  const dates = lob.map(({ row }) => row.date).filter(Boolean).map((d) => d.slice(0, 10)).sort();
  const firms = [...new Set(lob.map(({ row }) => row.firmname).filter(Boolean))];
  const clients = [...new Set(lob.map(({ row }) => row.clientname).filter(Boolean))];
  const lobbyists = [...new Set(lob.map(({ row }) => row.lobbyistname).filter(Boolean))];
  const officials = [...new Set(lob.map(({ row }) => row.employeename || row.candidatename).filter(Boolean))];

  // Count per client
  const clientCounts = new Map();
  for (const { row } of lob) {
    const c = row.clientname || "Unknown";
    clientCounts.set(c, (clientCounts.get(c) || 0) + 1);
  }
  const topClients = [...clientCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);

  // Count per official
  const officialCounts = new Map();
  for (const { row } of lob) {
    const o = row.employeename || row.candidatename;
    if (o) officialCounts.set(o, (officialCounts.get(o) || 0) + 1);
  }
  const topOfficials = [...officialCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);

  const desc =
    `**${lob.length} total filings** | ${dates[0]?.slice(0,7) || "—"} → ${dates[dates.length-1]?.slice(0,7) || "—"}\n\n` +
    `**Lobbying firms (${firms.length}):** ${firms.join(", ")}\n` +
    `**Individual lobbyists (${lobbyists.length}):** ${lobbyists.join(", ")}\n\n` +
    `**Top clients by filing count:**\n${topClients.map(([c, n]) => `• ${b(c)}: ${n} filings${pct(n, lob.length)}`).join("\n")}\n\n` +
    `**Top city officials contacted (${officialCounts.size} total):**\n${topOfficials.length > 0
      ? topOfficials.map(([o, n]) => `• ${b(o)}: ${n} contact(s)`).join("\n")
      : "_No official contact records found_"}\n\n` +
    `🔗 Full filings: https://netfile.com/lobbyistpub/#sfo`;

  return embed("🏛 1. Lobbying Activity", 0xe74c3c, desc);
}

function financeEmbed(fin) {
  if (fin.length === 0) return embed("💰 2. Campaign Finance", 0x27ae60, "No records found.");

  const total = fin.reduce((s, { row }) => s + Number(row.transaction_amount_1 || 0), 0);
  const dates = fin.map(({ row }) => (row.transaction_date || row.filing_date || "")).filter(Boolean).map((d) => d.slice(0, 10)).sort();

  // By recipient
  const byRecipient = new Map();
  for (const { row, link } of fin) {
    const rec = row.filer_name || "Unknown";
    if (!byRecipient.has(rec)) byRecipient.set(rec, { total: 0, count: 0, link });
    byRecipient.get(rec).total += Number(row.transaction_amount_1 || 0);
    byRecipient.get(rec).count++;
  }

  // Top contributors
  const contribCounts = new Map();
  for (const { row } of fin) {
    const name = [row.transaction_first_name, row.transaction_last_name].filter(Boolean).join(" ") || "Unknown";
    contribCounts.set(name, (contribCounts.get(name) || 0) + Number(row.transaction_amount_1 || 0));
  }
  const topContribs = [...contribCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);

  // Employer breakdown
  const employers = [...new Set(fin.map(({ row }) => row.transaction_employer).filter(Boolean))];

  const desc =
    `**${fin.length} transactions** | **Total: $${total.toLocaleString()}**\n` +
    `${dates[0]?.slice(0,7) || "—"} → ${dates[dates.length-1]?.slice(0,7) || "—"}\n\n` +
    `**By recipient committee:**\n` +
    [...byRecipient.entries()]
      .sort((a, b) => b[1].total - a[1].total)
      .map(([rec, { total: t, count, link }]) => `• ${b(rec)}: $${t.toLocaleString()} (${count} transactions) [↗](${link})`)
      .join("\n") + "\n\n" +
    `**Top contributors by amount:**\n` +
    topContribs.map(([name, amt]) => `• ${b(name)}: $${amt.toLocaleString()}`).join("\n") + "\n\n" +
    (employers.length > 0 ? `**Employers listed:** ${employers.slice(0, 6).join(", ")}${employers.length > 6 ? ` +${employers.length - 6} more` : ""}\n\n` : "") +
    `🔗 Full data: https://sfethics.org/disclosures/campaign-finance-disclosure`;

  return embed("💰 2. Campaign Finance", 0x27ae60, desc);
}

function permitsEmbed(per) {
  if (per.length === 0) return embed("🏗 3. Building Permits", 0xf39c12,
    "No description-text matches found.\n\n_Note: The DBI dataset has no applicant/owner name fields. Only permit description text is searchable — LLC names won't appear here._\n\n🔗 Search manually: https://sfdbi.org/dbipts");

  const dates = per.map(({ row }) => row.filed_date).filter(Boolean).map((d) => d.slice(0, 10)).sort();
  const byAddr = new Map();
  for (const { row, link } of per) {
    const addr = [row.street_number, row.street_name, row.street_suffix].filter(Boolean).join(" ") || "Unknown";
    if (!byAddr.has(addr)) byAddr.set(addr, []);
    byAddr.get(addr).push({ num: row.permit_number, desc: (row.description || "").slice(0, 60), status: row.status, date: (row.filed_date || "").slice(0, 10), link });
  }

  const statusCounts = new Map();
  for (const { row } of per) {
    const s = row.status || "unknown";
    statusCounts.set(s, (statusCounts.get(s) || 0) + 1);
  }

  const desc =
    `**${per.length} permit(s)** across **${byAddr.size} address(es)**\n` +
    `${dates[0]?.slice(0,7) || "—"} → ${dates[dates.length-1]?.slice(0,7) || "—"}\n\n` +
    `**By status:** ${[...statusCounts.entries()].map(([s, n]) => `${s}: ${n}`).join(" | ")}\n\n` +
    `**Addresses with permits:**\n` +
    [...byAddr.entries()].slice(0, 10).map(([addr, permits]) => {
      const latest = permits.sort((a, b) => b.date.localeCompare(a.date))[0];
      return `• ${b(addr)} (${permits.length}) — ${latest.status} | ${latest.date} [↗](${latest.link})`;
    }).join("\n") +
    (byAddr.size > 10 ? `\n• …and ${byAddr.size - 10} more addresses` : "") + "\n\n" +
    `🔗 Full search: https://sfdbi.org/dbipts`;

  return embed("🏗 3. Building Permits", 0xf39c12, desc);
}

function networkEmbed(matches) {
  const counts = new Map(SEARCH_TERMS.map((t) => [t, 0]));
  const srcs = new Map(SEARCH_TERMS.map((t) => [t, new Set()]));
  const labels = { lobbyist_activity: "L", campaign_finance: "F", building_permits: "P" };

  for (const src of SOURCES) {
    for (const { terms } of matches[src.id]) {
      for (const t of terms) {
        counts.set(t, (counts.get(t) || 0) + 1);
        srcs.get(t)?.add(src.id);
      }
    }
  }

  const ranked = [...counts.entries()].filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1]);
  const active = ranked.filter(([, c]) => c > 0).length;
  const inactive = SEARCH_TERMS.length - active;

  const desc =
    `**${active} of ${SEARCH_TERMS.length} tracked entities** appear in public records. ` +
    (inactive > 0 ? `**${inactive} have no records yet:** ${SEARCH_TERMS.filter((t) => !counts.get(t)).map(m).join(", ")}\n\n` : "\n\n") +
    `**Record count per entity** (L=Lobbying F=Finance P=Permits):\n` +
    ranked.map(([t, c]) => {
      const sourceTags = [...(srcs.get(t) || [])].map((s) => labels[s]).join("");
      return `• ${b(t)}: ${c} [${sourceTags}]`;
    }).join("\n");

  return embed("🕸 4. Entity Network", 0x2980b9, desc);
}

function briefingEmbed(matches, runDate) {
  const lob = matches.lobbyist_activity;
  const fin = matches.campaign_finance;
  const per = matches.building_permits;

  const lobDates = lob.map(({ row }) => row.date).filter(Boolean).map((d) => d.slice(0, 10)).sort();
  const firms = [...new Set(lob.map(({ row }) => row.firmname).filter(Boolean))];
  const clients = [...new Set(lob.map(({ row }) => row.clientname).filter(Boolean))];
  const officials = [...new Set(lob.map(({ row }) => row.employeename || row.candidatename).filter(Boolean))];
  const totalMoney = fin.reduce((s, { row }) => s + Number(row.transaction_amount_1 || 0), 0);
  const recipients = [...new Set(fin.map(({ row }) => row.filer_name).filter(Boolean))];

  const lines = [];

  if (lob.length > 0) lines.push(
    `**Lobbying:** ${firms.join(" and ")} filed **${lob.length} lobbying disclosures** on behalf of ${clients.join(", ")} ` +
    `from ${lobDates[0]?.slice(0,7) || "—"} to ${lobDates[lobDates.length-1]?.slice(0,7) || "—"}. ` +
    (officials.length > 0 ? `Officials contacted: **${officials.slice(0,5).join(", ")}**${officials.length > 5 ? ` +${officials.length-5} more` : ""}.` : "No official contact records found.")
  );

  if (fin.length > 0) lines.push(
    `**Political money:** **$${totalMoney.toLocaleString()}** across **${fin.length} transactions** to ${recipients.join(", ")}.`
  );

  if (per.length > 0) lines.push(
    `**Construction:** **${per.length} permit(s)** referencing tracked terms filed at Fillmore Street addresses.`
  );

  lines.push(
    `**Property records:** No public API. Search https://recorder.sfgov.org by name for: ` +
    `Fillmore Reserve, North Room LLC, Pointed Blue LLC, Shaded Flame LLC, Temperate Lands LLC, White Birches LLC, Aegis Reserve.`
  );

  return embed(
    "📰 5. Reporter's Briefing",
    0x2c3e50,
    `_As of ${runDate}:_\n\n${lines.join("\n\n")}\n\n` +
    `---\n_One-time snapshot. Data from DataSF open data portals._`,
    `SF Fillmore Intelligence Report • ${runDate}`
  );
}

// ─── Post to Discord ──────────────────────────────────────────────────────────

async function postToDiscord(embeds) {
  if (!DISCORD_WEBHOOK_URL) {
    console.log(`[DRY RUN] ${embeds.length} embeds:`);
    embeds.forEach((e, i) => {
      const size = JSON.stringify(e).length;
      console.log(`  ${i+1}: "${e.title}" — ${size} chars ${size > 6000 ? "⚠️ OVERSIZED" : "✅"}`);
    });
    return;
  }

  // Post one embed at a time to isolate any remaining size issues
  for (let i = 0; i < embeds.length; i++) {
    const result = await postJSON(DISCORD_WEBHOOK_URL, { embeds: [embeds[i]] });
    if (result.status >= 300) {
      console.error(`❌ Discord error ${result.status} on embed ${i+1} "${embeds[i].title}":`, result.body);
    } else {
      console.log(`✅ Embed ${i+1}/${embeds.length} posted: "${embeds[i].title}"`);
    }
    await new Promise((r) => setTimeout(r, 500));
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
    coverEmbed(matches, runDate),
    lobbyingEmbed(matches.lobbyist_activity),
    financeEmbed(matches.campaign_finance),
    permitsEmbed(matches.building_permits),
    networkEmbed(matches),
    briefingEmbed(matches, runDate),
  ];

  // Log sizes before posting
  embeds.forEach((e, i) => {
    const size = JSON.stringify(e).length;
    console.log(`Embed ${i+1} "${e.title}": ${size} chars ${size > 6000 ? "⚠️ OVERSIZED" : "✅"}`);
  });

  console.log(`\n📨 Posting ${embeds.length} embeds one at a time…`);
  await postToDiscord(embeds);
  console.log("\nReport complete.");
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
