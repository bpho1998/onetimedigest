/**
 * SF Fillmore Research Report — One-time comprehensive intelligence snapshot.
 *
 * MATCHING STRATEGY (field-aware):
 *
 * LOBBYIST: match on client name or description containing subject terms.
 *   Agent terms (Lighthouse, Peterson) only count when a subject term also
 *   appears in the same record.
 *
 * CAMPAIGN FINANCE: match ONLY on contributor/filer name containing
 *   subject terms (Mehta, Fillmore Reserve, Aegis Reserve, etc.).
 *   Do NOT match on employer = Lighthouse Public Affairs — that pulls
 *   all their unrelated political work.
 *
 * BUILDING PERMITS: match on 2000–2299 Fillmore St address block.
 */

const https = require("https");

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const SINCE_DATE = process.env.SINCE_DATE || "2018-01-01";

// Subject terms — identify the actual Mehta/Fillmore entities
const SUBJECT_TERMS = [
  "Upper Fillmore Revitalization",
  "Aegis Reserve",
  "Fillmore Reserve",
  "Cody Allen",
  "Maven Properties",
  "SF Reserve Foundation",
  "Sam Singer",
  "Singer Associates",
  "Neil Mehta",
  "North Room LLC",
  "Pointed Blue LLC",
  "Shaded Flame LLC",
  "Temperate Lands LLC",
  "White Birches LLC",
];

// Agent terms — lobbyists/firms acting for Mehta interests
// Used ONLY in lobbyist source, and only when subject term also present
const AGENT_TERMS = [
  "Lighthouse Public Affairs",
  "Peterson, Rich",
];

const ALL_TERMS = [...SUBJECT_TERMS, ...AGENT_TERMS];

const FILLMORE_RANGE = { street: "fillmore", min: 2000, max: 2299 };

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

function termIn(value, terms) {
  const v = (value || "").toString().toLowerCase();
  return terms.filter((t) => v.includes(t.toLowerCase()));
}

function matchLobbyist(row) {
  // Primary: client name or description contains a subject term
  const clientHits = termIn(row.clientname, SUBJECT_TERMS);
  if (clientHits.length > 0) return clientHits;
  const descHits = termIn(row.description, SUBJECT_TERMS);
  if (descHits.length > 0) return descHits;
  // Secondary: agent term present AND subject term anywhere else in record
  const isAgent = termIn(row.firmname, AGENT_TERMS).length > 0 ||
                  termIn(row.lobbyistname, AGENT_TERMS).length > 0;
  if (isAgent) {
    const allText = [row.clientname, row.description, row.candidatename, row.employeename]
      .map((f) => (f || "").toLowerCase()).join(" ");
    const subjectHits = SUBJECT_TERMS.filter((t) => allText.includes(t.toLowerCase()));
    if (subjectHits.length > 0) return subjectHits;
  }
  return [];
}

function matchFinance(row) {
  // Only match on contributor name, filer/recipient name, or transaction description
  // containing SUBJECT terms. Do NOT match on employer = Lighthouse (unrelated work).
  const filerHits = termIn(row.filer_name, SUBJECT_TERMS);
  const contributor = [row.transaction_first_name, row.transaction_last_name].filter(Boolean).join(" ");
  const contribHits = termIn(contributor, SUBJECT_TERMS);
  const descHits = termIn(row.transaction_description, SUBJECT_TERMS);
  return [...new Set([...filerHits, ...contribHits, ...descHits])];
}

function matchPermit(row) {
  const street = (row.street_name || "").toLowerCase();
  const num = parseInt(row.street_number || "0", 10);
  if (street === FILLMORE_RANGE.street && num >= FILLMORE_RANGE.min && num <= FILLMORE_RANGE.max) {
    return [`${row.street_number} Fillmore St`];
  }
  return [];
}

// ─── Fetch ────────────────────────────────────────────────────────────────────

async function fetchAndMatch() {
  const results = { lobbyist_activity: [], campaign_finance: [], building_permits: [] };

  // Lobbyist
  console.log("\n📡 Fetching lobbyist_activity…");
  await paginate(
    "https://data.sfgov.org/resource/s4ub-8j3t.json", "date",
    (row) => {
      const terms = matchLobbyist(row);
      if (terms.length > 0) results.lobbyist_activity.push({
        row, terms,
        link: row.fromfiling
          ? `https://netfile.com/app/lobbyist/filing/${row.fromfiling}/report`
          : "https://netfile.com/lobbyistpub/#sfo",
      });
    }
  );
  console.log(`  ↳ ${results.lobbyist_activity.length} matches`);

  // Campaign finance
  console.log("\n📡 Fetching campaign_finance…");
  await paginate(
    "https://data.sfgov.org/resource/pitq-e56w.json", "filing_date",
    (row) => {
      const terms = matchFinance(row);
      if (terms.length > 0) results.campaign_finance.push({
        row, terms,
        link: row.filing_id_number
          ? `https://netfile.com/pub2/api/filing/${row.filing_id_number}/detail?aid=sfo`
          : "https://sfethics.org/disclosures/campaign-finance-disclosure",
      });
    }
  );
  console.log(`  ↳ ${results.campaign_finance.length} matches`);

  // Building permits
  console.log("\n📡 Fetching building_permits…");
  await paginate(
    "https://data.sfgov.org/resource/i98e-djp9.json", "filed_date",
    (row) => {
      const terms = matchPermit(row);
      if (terms.length > 0) results.building_permits.push({
        row, terms,
        link: row.permit_number
          ? `https://dbiweb02.sfgov.org/dbipts/default.aspx?permit=${row.permit_number}`
          : "https://sfdbi.org/dbipts",
      });
    }
  );
  console.log(`  ↳ ${results.building_permits.length} matches`);

  return results;
}

async function paginate(baseUrl, dateField, onRow) {
  let offset = 0, total = 0;
  while (true) {
    const where = encodeURIComponent(`${dateField} >= '${SINCE_DATE}'`);
    const order = encodeURIComponent(`${dateField} ASC`);
    const url = `${baseUrl}?$where=${where}&$order=${order}&$limit=1000&$offset=${offset}`;
    let rows;
    try { rows = await fetchJSON(url); } catch (e) { console.error(`  ❌ ${e.message}`); break; }
    if (!Array.isArray(rows) || rows.length === 0) break;
    total += rows.length;
    rows.forEach(onRow);
    if (rows.length < 1000) break;
    offset += 1000;
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log(`  ↳ ${total} rows scanned`);
}

// ─── Embed helpers ────────────────────────────────────────────────────────────

// Truncate at a clean newline boundary, never mid-sentence
function smartTruncate(text, max) {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf("\n", max - 10);
  return (cut > max * 0.6 ? text.slice(0, cut) : text.slice(0, max - 3)) + "…";
}

function embed(title, color, description, footerText) {
  const d = smartTruncate(description, 2000);
  const e = { title: title.slice(0, 100), color, description: d };
  if (footerText) e.footer = { text: footerText.slice(0, 200) };
  return e;
}

const b = (s) => `**${s}**`;
const m = (s) => `\`${s}\``;

// ─── Cover ────────────────────────────────────────────────────────────────────

function coverEmbed(matches, runDate) {
  const lob = matches.lobbyist_activity.length;
  const fin = matches.campaign_finance.length;
  const per = matches.building_permits.length;
  const allDates = [
    ...matches.lobbyist_activity.map(({ row }) => row.date),
    ...matches.campaign_finance.map(({ row }) => row.filing_date),
    ...matches.building_permits.map(({ row }) => row.filed_date),
  ].filter(Boolean).map((d) => d.slice(0, 10)).sort();

  return embed(
    "🔍 Fillmore/Mehta Intelligence Report",
    0x1a1a2e,
    `Full-record synthesis of all public SF filings related to Neil Mehta and the Upper Fillmore Revitalization Project.\n\n` +
    `**Generated:** ${runDate} | **Span:** ${allDates[0] || "—"} → ${allDates[allDates.length - 1] || "—"}\n\n` +
    `**🏛 Lobbying filings:** ${lob}\n` +
    `**💰 Campaign finance:** ${fin} transactions\n` +
    `**🏗 Permit matches:** ${per}\n` +
    `**🏠 Property recordings:** No public API — search https://recorder.sfgov.org\n\n` +
    `**Tracked entities:**\n${ALL_TERMS.map(m).join(" ")}`,
    "SF Fillmore Report • DataSF • One-time snapshot"
  );
}

// ─── Lobbying ─────────────────────────────────────────────────────────────────

function lobbyingEmbed(lob) {
  if (lob.length === 0) return embed("🏛 1. Lobbying Activity", 0xe74c3c,
    "No lobbying records found where the client or subject matter references tracked entities.\n\n🔗 https://netfile.com/lobbyistpub/#sfo");

  const dates = lob.map(({ row }) => row.date).filter(Boolean).map((d) => d.slice(0, 10)).sort();
  const firms = [...new Set(lob.map(({ row }) => row.firmname).filter(Boolean))];
  const lobbyists = [...new Set(lob.map(({ row }) => row.lobbyistname).filter(Boolean))];

  // Group by client
  const byClient = new Map();
  for (const { row, link } of lob) {
    const client = row.clientname || "Unknown";
    if (!byClient.has(client)) byClient.set(client, { count: 0, firms: new Set(), first: "9999", last: "0000", officials: new Set(), link });
    const e = byClient.get(client);
    e.count++;
    if (row.firmname) e.firms.add(row.firmname);
    const date = (row.date || "").slice(0, 10);
    if (date < e.first) e.first = date;
    if (date > e.last) e.last = date;
    const off = row.employeename || row.candidatename;
    if (off && off.length > 3 && !off.match(/LLC|INC|^\d|MEASURE|PROP/i)) e.officials.add(off);
  }

  let desc =
    `**${lob.length} filings** | ${dates[0]?.slice(0,7)} → ${dates[dates.length-1]?.slice(0,7)}\n` +
    `**Firms:** ${firms.join(", ")}\n` +
    `**Lobbyists:** ${lobbyists.join(", ")}\n\n` +
    `**By client:**\n`;

  for (const [client, { count, firms: f, first, last, officials, link }] of
    [...byClient.entries()].sort((a, b) => b[1].count - a[1].count)) {
    desc += `• ${b(client)}: ${count} filings (${first.slice(0,7)} → ${last.slice(0,7)}) [↗](${link})\n`;
    desc += `  via ${[...f].join(", ")}\n`;
    if (officials.size > 0) {
      desc += `  _Officials: ${[...officials].slice(0,4).join(", ")}${officials.size > 4 ? ` +${officials.size-4}` : ""}_\n`;
    }
  }

  desc += `\n🔗 https://netfile.com/lobbyistpub/#sfo`;
  return embed("🏛 1. Lobbying Activity", 0xe74c3c, desc);
}

// ─── Campaign Finance ─────────────────────────────────────────────────────────

function financeEmbed(fin) {
  if (fin.length === 0) return embed("💰 2. Campaign Finance", 0x27ae60,
    "No campaign finance records found where a tracked entity is the contributor or recipient.\n\n🔗 https://sfethics.org/disclosures/campaign-finance-disclosure");

  const total = fin.reduce((s, { row }) => s + Number(row.transaction_amount_1 || 0), 0);
  const dates = fin.map(({ row }) => (row.transaction_date || row.filing_date || ""))
    .filter(Boolean).map((d) => d.slice(0, 10)).sort();

  // Group by recipient
  const byRecipient = new Map();
  for (const { row, link } of fin) {
    const rec = row.filer_name || "Unknown";
    if (!byRecipient.has(rec)) byRecipient.set(rec, { total: 0, count: 0, link, items: [] });
    const amt = Number(row.transaction_amount_1 || 0);
    const contrib = [row.transaction_first_name, row.transaction_last_name].filter(Boolean).join(" ") || "Unknown";
    const date = (row.transaction_date || row.filing_date || "").slice(0, 10);
    byRecipient.get(rec).total += amt;
    byRecipient.get(rec).count++;
    byRecipient.get(rec).items.push({ contrib, amt, date, link });
  }

  // Sort recipients by total, cap at 8
  const sortedRecipients = [...byRecipient.entries()]
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, 8);

  let desc =
    `**${fin.length} transactions** | **Total: $${total.toLocaleString()}**\n` +
    `${dates[0]?.slice(0,7) || "—"} → ${dates[dates.length-1]?.slice(0,7) || "—"}\n\n` +
    `**By recipient (top 8 by amount):**\n`;

  for (const [rec, { total: t, count, link, items }] of sortedRecipients) {
    desc += `• ${b(rec)}: $${t.toLocaleString()} (${count}) [↗](${link})\n`;
    // Show top 2 contributors to each recipient
    const topItems = items.sort((a, b) => b.amt - a.amt).slice(0, 2);
    for (const { contrib, amt, date } of topItems) {
      desc += `  _${contrib}: $${amt.toLocaleString()} on ${date}_\n`;
    }
  }

  const remaining = byRecipient.size - 8;
  if (remaining > 0) desc += `• …and ${remaining} more recipients\n`;
  desc += `\n🔗 https://sfethics.org/disclosures/campaign-finance-disclosure`;

  return embed("💰 2. Campaign Finance", 0x27ae60, desc);
}

// ─── Building Permits ─────────────────────────────────────────────────────────

function permitsEmbed(per) {
  if (per.length === 0) return embed("🏗 3. Building Permits", 0xf39c12,
    "No permit matches found on the 2000–2299 Fillmore St block.\n\n🔗 https://sfdbi.org/dbipts");

  const dates = per.map(({ row }) => row.filed_date).filter(Boolean).map((d) => d.slice(0, 10)).sort();

  const statusCounts = new Map();
  for (const { row } of per) {
    const s = row.status || "unknown";
    statusCounts.set(s, (statusCounts.get(s) || 0) + 1);
  }

  const totalCost = per.reduce((s, { row }) => s + Number(row.estimated_cost || 0), 0);

  const sorted = [...per].sort((a, b) =>
    (b.row.filed_date || "").localeCompare(a.row.filed_date || ""));

  let desc =
    `**${per.length} permit(s)** on 2000–2299 Fillmore St | ${dates[0]?.slice(0,7)} → ${dates[dates.length-1]?.slice(0,7)}\n` +
    `**Est. total value:** $${totalCost.toLocaleString()}\n` +
    `**Status breakdown:** ${[...statusCounts.entries()].map(([s, n]) => `${s}: ${n}`).join(" | ")}\n\n` +
    `**Most recent 10 permits:**\n`;

  for (const { row, link } of sorted.slice(0, 10)) {
    const addr = row.street_number ? `${row.street_number} Fillmore` : "Fillmore";
    const date = (row.filed_date || "").slice(0, 10);
    const cost = row.estimated_cost ? ` $${Number(row.estimated_cost).toLocaleString()}` : "";
    const workDesc = (row.description || "—").slice(0, 65);
    desc += `• ${b(addr)} | ${row.status || "—"} | ${date}${cost} [↗](${link})\n`;
    desc += `  _${workDesc}_\n`;
  }
  if (per.length > 10) desc += `• …and ${per.length - 10} more permits\n`;
  desc += `\n🔗 https://sfdbi.org/dbipts`;

  return embed("🏗 3. Building Permits", 0xf39c12, desc);
}

// ─── Entity Network ───────────────────────────────────────────────────────────

function networkEmbed(matches) {
  const counts = new Map(ALL_TERMS.map((t) => [t, 0]));
  const srcs = new Map(ALL_TERMS.map((t) => [t, new Set()]));
  const labels = { lobbyist_activity: "L", campaign_finance: "F", building_permits: "P" };

  for (const [srcId, records] of Object.entries(matches)) {
    for (const { terms } of records) {
      for (const t of terms) {
        if (counts.has(t)) {
          counts.set(t, (counts.get(t) || 0) + 1);
          srcs.get(t)?.add(srcId);
        }
      }
    }
  }

  const ranked = [...counts.entries()].filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1]);
  const inactive = ALL_TERMS.filter((t) => !counts.get(t));

  let desc =
    `**${ranked.length} of ${ALL_TERMS.length}** tracked entities appear in public records.\n\n` +
    `**Record count** (L=Lobbying F=Finance P=Permits):\n` +
    ranked.map(([t, c]) => `• ${b(t)}: ${c} [${[...(srcs.get(t)||[])].map((s) => labels[s]).sort().join("")}]`).join("\n");

  if (inactive.length > 0) {
    desc += `\n\n**No records yet:**\n${inactive.map(m).join(" ")}`;
  }

  return embed("🕸 4. Entity Network", 0x2980b9, desc);
}

// ─── Reporter's Briefing ──────────────────────────────────────────────────────

function briefingEmbed(matches, runDate) {
  const lob = matches.lobbyist_activity;
  const fin = matches.campaign_finance;
  const per = matches.building_permits;

  const lobDates = lob.map(({ row }) => row.date).filter(Boolean).map((d) => d.slice(0, 10)).sort();
  const firms = [...new Set(lob.map(({ row }) => row.firmname).filter(Boolean))];
  const lobbyists = [...new Set(lob.map(({ row }) => row.lobbyistname).filter(Boolean))];
  const clients = [...new Set(lob.map(({ row }) => row.clientname).filter(Boolean))];
  const officials = [...new Set(
    lob.map(({ row }) => row.employeename || row.candidatename)
      .filter((o) => o && o.length > 3 && !o.match(/LLC|INC|^\d|MEASURE|PROP/i))
  )];

  const totalMoney = fin.reduce((s, { row }) => s + Number(row.transaction_amount_1 || 0), 0);

  // Top 5 recipients only for briefing
  const recipientTotals = new Map();
  for (const { row } of fin) {
    const rec = row.filer_name || "Unknown";
    recipientTotals.set(rec, (recipientTotals.get(rec) || 0) + Number(row.transaction_amount_1 || 0));
  }
  const topRecipients = [...recipientTotals.entries()]
    .sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([r, t]) => `${r} ($${t.toLocaleString()})`);
  const extraRecipients = recipientTotals.size - 5;

  const totalPermitCost = per.reduce((s, { row }) => s + Number(row.estimated_cost || 0), 0);

  const lines = [];

  if (lob.length > 0) {
    lines.push(
      `**Lobbying:** ${firms.join(" and ")} (${lobbyists.join(", ")}) filed **${lob.length} lobbying disclosures** ` +
      `on behalf of ${clients.join(", ")} ` +
      `from ${lobDates[0]?.slice(0,7) || "—"} to ${lobDates[lobDates.length-1]?.slice(0,7) || "—"}. ` +
      (officials.length > 0
        ? `City officials contacted: **${officials.slice(0,5).join(", ")}**${officials.length > 5 ? ` (+${officials.length-5} more)` : ""}.`
        : "No official contact records in dataset.")
    );
  } else {
    lines.push("**Lobbying:** No records found for tracked clients.");
  }

  if (fin.length > 0) {
    lines.push(
      `**Political money:** **$${totalMoney.toLocaleString()}** across **${fin.length} transactions**. ` +
      `Top recipients: ${topRecipients.join("; ")}${extraRecipients > 0 ? `; +${extraRecipients} more` : ""}.`
    );
  } else {
    lines.push("**Political money:** No records found for tracked entities as contributor or recipient.");
  }

  if (per.length > 0) {
    lines.push(
      `**Construction:** **${per.length} building permit(s)** on the 2000–2299 Fillmore St block, ` +
      `with estimated total value of **$${totalPermitCost.toLocaleString()}**.`
    );
  } else {
    lines.push("**Construction:** No permits found on the 2000–2299 Fillmore St block.");
  }

  lines.push(
    `**Property records:** No public API. Search https://recorder.sfgov.org by name for: ` +
    `Fillmore Reserve, North Room LLC, Pointed Blue LLC, Shaded Flame LLC, Temperate Lands LLC, White Birches LLC, Aegis Reserve.`
  );

  return embed(
    "📰 5. Reporter's Briefing",
    0x2c3e50,
    `_As of ${runDate}:_\n\n${lines.join("\n\n")}\n\n` +
    `---\n_One-time snapshot. All data from DataSF open data portals._`,
    `SF Fillmore Intelligence Report • ${runDate}`
  );
}

// ─── Post to Discord ──────────────────────────────────────────────────────────

async function postToDiscord(embeds) {
  if (!DISCORD_WEBHOOK_URL) {
    console.log(`[DRY RUN] ${embeds.length} embeds:`);
    embeds.forEach((e, i) => console.log(`  ${i+1}: "${e.title}" — ${JSON.stringify(e).length} chars`));
    return;
  }
  for (let i = 0; i < embeds.length; i++) {
    const size = JSON.stringify(embeds[i]).length;
    console.log(`Posting embed ${i+1}/${embeds.length}: "${embeds[i].title}" (${size} chars)`);
    const result = await postJSON(DISCORD_WEBHOOK_URL, { embeds: [embeds[i]] });
    if (result.status >= 300) {
      console.error(`❌ Discord error ${result.status}:`, result.body);
    } else {
      console.log(`✅ Posted`);
    }
    await new Promise((r) => setTimeout(r, 600));
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const runDate = new Date().toISOString().slice(0, 10);
  console.log("═".repeat(60));
  console.log(`SF Fillmore Report | ${runDate} | Since: ${SINCE_DATE} | Webhook: ${!!DISCORD_WEBHOOK_URL}`);
  console.log("═".repeat(60));

  const matches = await fetchAndMatch();
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

  embeds.forEach((e, i) => {
    const size = JSON.stringify(e).length;
    console.log(`Embed ${i+1} "${e.title}": ${size} chars ${size > 6000 ? "⚠️ TOO BIG" : "✅"}`);
  });

  console.log(`\n📨 Posting ${embeds.length} embeds…`);
  await postToDiscord(embeds);
  console.log("\nReport complete.");
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
