/**
 * SF Fillmore Research Report
 *
 * A one-time script that pulls ALL matching records across SF open data
 * sources and posts a comprehensive reporter-ready intelligence briefing
 * to Discord.
 *
 * SOURCES AND THEIR ACTUAL STATUS:
 *   ✅ SF Ethics — Lobbyist Activity (s4ub-8j3t) — works, 4500+ matches
 *   ✅ SF Ethics — Campaign Finance Transactions (pitq-e56w) — works
 *   ⚠️  SF DBI — Building Permits (i98e-djp9) — no name fields; searches
 *      description text only (will catch Clay Theater, Fillmore St refs)
 *   ❌ SF Assessor — Recorded Documents — not available via public API;
 *      the Recorder uses a proprietary system. Removed from this bot.
 *      Use https://recorder.sfgov.org to search manually by name.
 *
 * DISCORD LIMITS:
 *   Each embed: max 6000 total chars across all fields
 *   Each message: max 10 embeds
 *   We summarize rather than list every record to stay within limits.
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
    label: "Lobbyist Activity",
    url: "https://data.sfgov.org/resource/s4ub-8j3t.json",
    dateField: "date",
    textFields: ["lobbyistname", "firmname", "clientname", "description", "employeename", "candidatename"],
    linkTemplate: (r) =>
      r.fromfiling
        ? `https://netfile.com/app/lobbyist/filing/${r.fromfiling}/report`
        : "https://netfile.com/lobbyistpub/#sfo",
  },
  {
    id: "campaign_finance",
    label: "Campaign Finance",
    url: "https://data.sfgov.org/resource/pitq-e56w.json",
    dateField: "filing_date",
    textFields: [
      "filer_name",
      "transaction_first_name",
      "transaction_last_name",
      "transaction_employer",
      "transaction_occupation",
      "transaction_description",
    ],
    linkTemplate: (r) =>
      r.filing_id_number
        ? `https://netfile.com/pub2/api/filing/${r.filing_id_number}/detail?aid=sfo`
        : "https://sfethics.org/disclosures/campaign-finance-disclosure",
  },
  {
    id: "building_permits",
    label: "Building Permits",
    url: "https://data.sfgov.org/resource/i98e-djp9.json",
    dateField: "filed_date",
    // Only description and street_name are text-searchable in this dataset.
    // Matches will be permits mentioning Fillmore, Clay Theater, etc. in the
    // work description — not LLC names (those aren't stored in this dataset).
    textFields: ["description", "street_name"],
    linkTemplate: (r) =>
      r.permit_number
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
        catch (e) { reject(new Error(`JSON parse error for ${url}: ${e.message}`)); }
      });
    }).on("error", reject);
  });
}

function postJSON(url, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve({ status: res.statusCode, body: d }));
      }
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

// ─── Fetching ─────────────────────────────────────────────────────────────────

async function fetchAllMatches() {
  const results = { lobbyist_activity: [], campaign_finance: [], building_permits: [] };

  for (const source of SOURCES) {
    console.log(`\n📡 Fetching ${source.id} since ${SINCE_DATE}…`);
    let offset = 0;
    const limit = 1000;
    let totalFetched = 0;

    while (true) {
      const where = encodeURIComponent(`${source.dateField} >= '${SINCE_DATE}'`);
      const order = encodeURIComponent(`${source.dateField} ASC`);
      const url = `${source.url}?$where=${where}&$order=${order}&$limit=${limit}&$offset=${offset}`;

      let rows;
      try { rows = await fetchJSON(url); }
      catch (err) { console.error(`  ❌ offset ${offset}: ${err.message}`); break; }

      if (!Array.isArray(rows) || rows.length === 0) break;
      totalFetched += rows.length;

      for (const row of rows) {
        const terms = matchedTerms(row, source.textFields);
        if (terms.length > 0) {
          results[source.id].push({ row, terms, link: source.linkTemplate(row) });
        }
      }

      if (rows.length < limit) break;
      offset += limit;
      await new Promise((r) => setTimeout(r, 300));
    }
    console.log(`  ↳ Scanned ${totalFetched} rows → ${results[source.id].length} matches`);
  }

  return results;
}

// ─── Discord helpers ──────────────────────────────────────────────────────────

// Stay well under Discord's 6000 total char per embed limit
function safeEmbed(title, color, description, footer) {
  const MAX = 3800;
  const desc = description.length > MAX
    ? description.slice(0, MAX - 3) + "…"
    : description;
  const e = { title, color, description: desc };
  if (footer) e.footer = { text: footer };
  return e;
}

// Split a long body into multiple embeds if needed
function multiEmbed(title, color, body, footer) {
  const MAX = 3800;
  if (body.length <= MAX) return [safeEmbed(title, color, body, footer)];

  const embeds = [];
  let remaining = body;
  let part = 1;
  while (remaining.length > 0) {
    const slice = remaining.slice(0, MAX);
    const cut = slice.lastIndexOf("\n") > MAX * 0.6 ? slice.lastIndexOf("\n") : MAX;
    const chunk = remaining.slice(0, cut);
    remaining = remaining.slice(cut).trimStart();
    const isLast = remaining.length === 0;
    const partTitle = body.length > MAX ? `${title} (${part})` : title;
    embeds.push(safeEmbed(partTitle, color, chunk, isLast ? footer : undefined));
    part++;
  }
  return embeds;
}

function bold(s) { return `**${s}**`; }
function mono(s) { return `\`${s}\``; }

// ─── Section: Cover ───────────────────────────────────────────────────────────

function buildCover(matches, runDate) {
  const lob = matches.lobbyist_activity.length;
  const fin = matches.campaign_finance.length;
  const per = matches.building_permits.length;

  const allDates = [
    ...matches.lobbyist_activity.map(({ row }) => row.date),
    ...matches.campaign_finance.map(({ row }) => row.filing_date || row.transaction_date),
    ...matches.building_permits.map(({ row }) => row.filed_date),
  ].filter(Boolean).map((d) => d.slice(0, 10)).sort();

  return [safeEmbed(
    "🔍 Fillmore/Mehta Intelligence Report",
    0x1a1a2e,
    `Full-record synthesis of all public filings related to Neil Mehta, the Upper Fillmore Revitalization Project, and associated entities.\n\n` +
    `**Generated:** ${runDate}\n` +
    `**Records span:** ${allDates[0] || "—"} → ${allDates[allDates.length - 1] || "—"}\n\n` +
    `> 🏛 Lobbying filings: **${lob}**\n` +
    `> 💰 Campaign finance transactions: **${fin}**\n` +
    `> 🏗 Building permit matches: **${per}**\n` +
    `> 🏠 Property recordings: _Not available via public API — search manually at_ https://recorder.sfgov.org\n\n` +
    `**Tracked entities:**\n${SEARCH_TERMS.map(mono).join(" • ")}`,
    "SF Fillmore Report • DataSF open data • One-time snapshot"
  )];
}

// ─── Section: Lobbying ────────────────────────────────────────────────────────

function buildLobbying(lobbyistMatches) {
  if (lobbyistMatches.length === 0) {
    return [safeEmbed("🏛 1. Lobbying Activity", 0xe74c3c, "No lobbying records found.")];
  }

  // Group: firm → lobbyist → client → filings
  const byFirm = new Map();
  const officialsMap = new Map();

  for (const { row, link } of lobbyistMatches) {
    const firm = row.firmname || "Independent";
    const lobbyist = row.lobbyistname || "Unknown";
    const client = row.clientname || "Unknown Client";
    const date = row.date ? row.date.slice(0, 10) : "—";
    const official = row.employeename || row.candidatename;
    const desc = row.description || "";

    if (!byFirm.has(firm)) byFirm.set(firm, new Map());
    if (!byFirm.get(firm).has(lobbyist)) byFirm.get(firm).set(lobbyist, new Map());
    if (!byFirm.get(firm).get(lobbyist).has(client)) {
      byFirm.get(firm).get(lobbyist).set(client, { count: 0, dates: [], officials: new Set(), descs: new Set(), links: [] });
    }
    const entry = byFirm.get(firm).get(lobbyist).get(client);
    entry.count++;
    entry.dates.push(date);
    if (official) entry.officials.add(official);
    if (desc) entry.descs.add(desc.slice(0, 60));
    entry.links.push(link);

    if (official) {
      if (!officialsMap.has(official)) officialsMap.set(official, { count: 0, clients: new Set() });
      officialsMap.get(official).count++;
      officialsMap.get(official).clients.add(client);
    }
  }

  const dates = lobbyistMatches.map(({ row }) => row.date).filter(Boolean).map((d) => d.slice(0, 10)).sort();

  // Build summary text — one line per client, not per filing
  let body = `**${lobbyistMatches.length} total filings** | ${dates[0] || "—"} → ${dates[dates.length - 1] || "—"}\n\n`;

  for (const [firm, lobbyists] of byFirm) {
    body += `### ${firm}\n`;
    for (const [lobbyist, clients] of lobbyists) {
      body += `**${lobbyist}**\n`;
      for (const [client, data] of clients) {
        const sortedDates = data.dates.sort();
        const first = sortedDates[0];
        const last = sortedDates[sortedDates.length - 1];
        const officialsStr = data.officials.size > 0 ? ` | Officials: ${[...data.officials].join(", ")}` : "";
        const exampleLink = data.links[0];
        body += `  ↳ **${client}** — ${data.count} filing(s) | ${first} → ${last}${officialsStr} [↗](${exampleLink})\n`;
        // Show up to 2 unique subject descriptions
        [...data.descs].slice(0, 2).forEach((d) => { body += `     _"${d}"_\n`; });
      }
      body += "\n";
    }
  }

  const embeds = multiEmbed("🏛 1. Lobbying Activity", 0xe74c3c, body);

  // Officials sub-section
  if (officialsMap.size > 0) {
    let oBody = `**${officialsMap.size} city official(s) contacted across all filings:**\n\n`;
    [...officialsMap.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .forEach(([name, { count, clients }]) => {
        oBody += `• **${name}** — ${count} contact(s) on behalf of ${[...clients].join(", ")}\n`;
      });
    embeds.push(...multiEmbed("🏛 1b. City Officials Contacted", 0xc0392b, oBody));
  }

  return embeds;
}

// ─── Section: Campaign Finance ────────────────────────────────────────────────

function buildFinance(financeMatches) {
  if (financeMatches.length === 0) {
    return [safeEmbed("💰 2. Campaign Finance", 0x27ae60, "No campaign finance records found.")];
  }

  const rows = financeMatches.map(({ row, link }) => ({
    contributor: [row.transaction_first_name, row.transaction_last_name].filter(Boolean).join(" ") || "Unknown",
    employer: row.transaction_employer || "—",
    recipient: row.filer_name || "Unknown Committee",
    amount: Number(row.transaction_amount_1 || 0),
    date: row.transaction_date ? row.transaction_date.slice(0, 10) : (row.filing_date ? row.filing_date.slice(0, 10) : "—"),
    link,
  })).sort((a, b) => b.amount - a.amount);

  const total = rows.reduce((s, r) => s + r.amount, 0);
  const dates = rows.map((r) => r.date).filter((d) => d !== "—").sort();

  // Group by recipient
  const byRecipient = new Map();
  for (const r of rows) {
    if (!byRecipient.has(r.recipient)) byRecipient.set(r.recipient, []);
    byRecipient.get(r.recipient).push(r);
  }

  let body =
    `**${rows.length} transaction(s)** | **Total: $${total.toLocaleString()}** | ` +
    `${dates[0] || "—"} → ${dates[dates.length - 1] || "—"}\n\n`;

  for (const [recipient, contribs] of [...byRecipient.entries()]
    .sort((a, b) => b[1].reduce((s, r) => s + r.amount, 0) - a[1].reduce((s, r) => s + r.amount, 0))) {
    const subtotal = contribs.reduce((s, r) => s + r.amount, 0);
    body += `**→ ${recipient}** — $${subtotal.toLocaleString()} (${contribs.length} transaction(s))\n`;
    for (const { contributor, employer, amount, date, link } of contribs.slice(0, 8)) {
      body += `  • ${date} | **${contributor}**`;
      if (employer !== "—") body += ` (${employer})`;
      body += ` | $${amount.toLocaleString()} [↗](${link})\n`;
    }
    if (contribs.length > 8) body += `  • …and ${contribs.length - 8} more\n`;
    body += "\n";
  }

  return multiEmbed("💰 2. Campaign Finance", 0x27ae60, body);
}

// ─── Section: Building Permits ────────────────────────────────────────────────

function buildPermits(permitMatches) {
  if (permitMatches.length === 0) {
    return [safeEmbed("🏗 3. Building Permits", 0xf39c12,
      "No building permit records matched.\n\n_Note: The DBI dataset does not include applicant or owner names — only permit description text is searchable. Matches here reflect permits with tracked terms in the work description._")];
  }

  const byAddress = new Map();
  for (const { row, terms, link } of permitMatches) {
    const address = [row.street_number, row.street_name, row.street_suffix].filter(Boolean).join(" ") || "Unknown";
    if (!byAddress.has(address)) byAddress.set(address, []);
    byAddress.get(address).push({
      permitNum: row.permit_number || "—",
      desc: (row.description || "—").slice(0, 100),
      status: row.status || "—",
      date: row.filed_date ? row.filed_date.slice(0, 10) : "—",
      cost: row.estimated_cost ? `$${Number(row.estimated_cost).toLocaleString()}` : null,
      terms,
      link,
    });
  }

  const dates = permitMatches.map(({ row }) => row.filed_date).filter(Boolean).map((d) => d.slice(0, 10)).sort();
  let body = `**${permitMatches.length} permit(s)** across **${byAddress.size} address(es)** | ${dates[0] || "—"} → ${dates[dates.length - 1] || "—"}\n\n`;

  for (const [address, permits] of byAddress) {
    body += `📍 **${address}** (${permits.length})\n`;
    for (const { permitNum, desc, status, date, cost, link } of permits.sort((a, b) => b.date.localeCompare(a.date))) {
      body += `  • ${mono(permitNum)} | **${status}** | ${date}`;
      if (cost) body += ` | ${cost}`;
      body += `\n    ${desc} [↗](${link})\n`;
    }
    body += "\n";
  }

  return multiEmbed("🏗 3. Building Permits", 0xf39c12, body);
}

// ─── Section: Entity Network ──────────────────────────────────────────────────

function buildNetwork(matches) {
  const termCounts = new Map(SEARCH_TERMS.map((t) => [t, 0]));
  const termSources = new Map(SEARCH_TERMS.map((t) => [t, new Set()]));

  for (const source of SOURCES) {
    for (const { terms } of matches[source.id]) {
      for (const t of terms) {
        termCounts.set(t, (termCounts.get(t) || 0) + 1);
        termSources.get(t)?.add(source.id);
      }
    }
  }

  const labels = { lobbyist_activity: "Lobbying", campaign_finance: "Finance", building_permits: "Permits" };
  const firms = [...new Set(matches.lobbyist_activity.map(({ row }) => row.firmname).filter(Boolean))];
  const clients = [...new Set(matches.lobbyist_activity.map(({ row }) => row.clientname).filter(Boolean))];
  const recipients = [...new Set(matches.campaign_finance.map(({ row }) => row.filer_name).filter(Boolean))];

  let body = `**How often each tracked entity appears across all public records:**\n\n`;
  [...termCounts.entries()].filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1]).forEach(([term, count]) => {
    const srcs = [...(termSources.get(term) || [])].map((s) => labels[s]).join(", ");
    body += `• **${term}**: **${count}** record(s) [${srcs || "—"}]\n`;
  });

  if (firms.length > 0) { body += `\n**Lobbying firms active for tracked entities:**\n`; firms.forEach((f) => { body += `• ${f}\n`; }); }
  if (clients.length > 0) { body += `\n**Clients listed in lobbying filings:**\n`; clients.forEach((c) => { body += `• ${c}\n`; }); }
  if (recipients.length > 0) { body += `\n**Campaign committees receiving tracked contributions:**\n`; recipients.forEach((r) => { body += `• ${r}\n`; }); }

  return multiEmbed("🕸 4. Entity Network Map", 0x2980b9, body);
}

// ─── Section: Reporter's Briefing ────────────────────────────────────────────

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
      `**Lobbying:** ${firms.join(" and ")} ${firms.length === 1 ? "has" : "have"} filed **${lob.length} lobbying disclosure(s)** with the SF Ethics Commission on behalf of ${clients.join(", ")}. ` +
      `Activity spans ${lobDates[0] || "—"} to ${lobDates[lobDates.length - 1] || "—"}. ` +
      (officials.length > 0
        ? `City officials contacted include: **${officials.slice(0, 6).join(", ")}**${officials.length > 6 ? ` and ${officials.length - 6} others` : ""}.`
        : "No city official contact records found in the dataset.")
    );
  }
  if (fin.length > 0) {
    lines.push(
      `**Political money:** Tracked entities are linked to **$${totalMoney.toLocaleString()}** across **${fin.length} campaign finance transaction(s)**, ` +
      `flowing to ${recipients.length > 0 ? recipients.join(", ") : "unknown committees"}.`
    );
  }
  if (per.length > 0) {
    lines.push(
      `**Construction:** **${per.length} building permit(s)** reference tracked terms in work descriptions, ` +
      `across ${addresses.length > 0 ? addresses.slice(0, 4).join("; ") + (addresses.length > 4 ? " and others" : "") : "tracked addresses"}.`
    );
  }
  lines.push(
    `**Property records:** The SF Assessor-Recorder does not expose recorded deeds via a public API. ` +
    `To search grantor/grantee records for the tracked LLCs, use the Recorder's public search tool at https://recorder.sfgov.org — ` +
    `search by name for: Fillmore Reserve, North Room LLC, Pointed Blue LLC, Shaded Flame LLC, Temperate Lands LLC, White Birches LLC, Aegis Reserve.`
  );

  return [safeEmbed(
    "📰 5. Reporter's Briefing",
    0x2c3e50,
    `_Comprehensive plain-language synthesis as of ${runDate}:_\n\n` +
    lines.join("\n\n") +
    `\n\n---\n_One-time snapshot. All data from DataSF. Filing links go directly to source records._`,
    `SF Fillmore Intelligence Report • ${runDate}`
  )];
}

// ─── Post to Discord ──────────────────────────────────────────────────────────

async function postToDiscord(embeds) {
  if (!DISCORD_WEBHOOK_URL) {
    console.log(`\n[DRY RUN] Would post ${embeds.length} embeds.`);
    embeds.forEach((e, i) => {
      const len = JSON.stringify(e).length;
      console.log(`  Embed ${i + 1}: "${e.title}" — ${len} chars`);
    });
    return;
  }

  const BATCH = 10;
  for (let i = 0; i < embeds.length; i += BATCH) {
    const batch = embeds.slice(i, i + BATCH);
    const result = await postJSON(DISCORD_WEBHOOK_URL, { embeds: batch });
    if (result.status >= 300) {
      console.error(`Discord error ${result.status} on batch ${Math.floor(i / BATCH) + 1}:`, result.body);
    } else {
      console.log(`✅ Posted batch ${Math.floor(i / BATCH) + 1} of ${Math.ceil(embeds.length / BATCH)}`);
    }
    if (i + BATCH < embeds.length) await new Promise((r) => setTimeout(r, 1500));
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const runDate = new Date().toISOString().slice(0, 10);
  console.log("═".repeat(60));
  console.log("SF Fillmore Comprehensive Research Report");
  console.log(`  Generated: ${runDate} | Since: ${SINCE_DATE} | Webhook: ${!!DISCORD_WEBHOOK_URL}`);
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

  console.log(`📨 Posting ${embeds.length} embeds…`);
  await postToDiscord(embeds);
  console.log("\n" + "═".repeat(60));
  console.log("Report complete.");
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
