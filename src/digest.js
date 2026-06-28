/**
 * SF Fillmore Research Report
 *
 * A one-time script that pulls ALL matching records across all 4 SF open
 * data sources from as far back as the datasets go, synthesizes them into
 * a comprehensive intelligence report, and posts it to Discord as a
 * structured, reporter-ready briefing.
 *
 * Run once. That's it.
 *
 * Categories:
 *   1. Lobbying Activity       — who is lobbying whom, on what, since when
 *   2. Political Money         — all contributions tied to tracked entities
 *   3. Permit & Construction   — every permit filed on tracked properties
 *   4. Property Transactions   — all recorded deeds and transfers
 *   5. Key People & Networks   — entities, firms, officials that recur
 *   6. Reporter's Briefing     — plain-language synthesis
 */

const fs    = require("fs");
const path  = require("path");
const https = require("https");

// ─── Configuration ────────────────────────────────────────────────────────────

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

// Pull everything — no date filter. DataSF datasets go back years.
// Set to a specific year like "2020-01-01" to narrow if datasets are huge.
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
    textFields: ["filer_naml", "filer_namf", "tran_naml", "tran_namf", "tran_emp", "tran_occ"],
    linkTemplate: (r) =>
      r.filing_id
        ? `https://netfile.com/pub2/api/filing/${r.filing_id}/detail?aid=sfo`
        : "https://sfethics.org/disclosures/campaign-finance-disclosure",
  },
  {
    id: "building_permits",
    label: "Building Permits",
    url: "https://data.sfgov.org/resource/i98e-djp9.json",
    dateField: "filed_date",
    textFields: ["applicant_name", "owner_name", "description", "contractor_name", "street_name"],
    linkTemplate: (r) =>
      r.permit_number
        ? `https://dbiweb02.sfgov.org/dbipts/default.aspx?permit=${r.permit_number}`
        : "https://sfdbi.org/dbipts",
  },
  {
    id: "property_transfers",
    label: "Property Transfers",
    url: "https://data.sfgov.org/resource/wv5m-vpq2.json",
    dateField: "recording_date",
    textFields: ["grantor_names", "grantee_names", "document_type", "legal_description"],
    linkTemplate: (r) =>
      r.document_number
        ? `https://recorder.sfgov.org/document-detail?documentNumber=${r.document_number}`
        : "https://sfassessor.org/recorder-information/recorded-documents",
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
        catch (e) { reject(new Error(`JSON parse error: ${e.message}\nURL: ${url}`)); }
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
  const haystack = textFields
    .map((f) => (row[f] || "").toString().toLowerCase())
    .join(" ");
  return SEARCH_TERMS.filter((t) => haystack.includes(t.toLowerCase()));
}

// ─── Data fetching — no lookback limit, paginated ─────────────────────────────

async function fetchAllMatches() {
  const results = {
    lobbyist_activity: [],
    campaign_finance: [],
    building_permits: [],
    property_transfers: [],
  };

  for (const source of SOURCES) {
    console.log(`\n📡 Fetching ALL records from ${source.id} since ${SINCE_DATE}…`);
    let offset = 0;
    const limit = 1000;
    let totalFetched = 0;

    while (true) {
      const where = encodeURIComponent(`${source.dateField} >= '${SINCE_DATE}'`);
      const order = encodeURIComponent(`${source.dateField} ASC`);
      const url = `${source.url}?$where=${where}&$order=${order}&$limit=${limit}&$offset=${offset}`;

      let rows;
      try {
        rows = await fetchJSON(url);
      } catch (err) {
        console.error(`  ❌ Error at offset ${offset}: ${err.message}`);
        break;
      }

      if (!Array.isArray(rows) || rows.length === 0) break;

      totalFetched += rows.length;

      for (const row of rows) {
        const terms = matchedTerms(row, source.textFields);
        if (terms.length > 0) {
          results[source.id].push({ row, terms, link: source.linkTemplate(row) });
        }
      }

      if (rows.length < limit) break; // last page
      offset += limit;

      // Polite pause between pages
      await new Promise((r) => setTimeout(r, 300));
    }

    console.log(`  ↳ Scanned ${totalFetched} total rows → ${results[source.id].length} matches`);
  }

  return results;
}

// ─── Synthesis helpers ────────────────────────────────────────────────────────

function truncate(str, max = 3900) {
  return str.length > max ? str.slice(0, max - 3) + "…" : str;
}

function bold(s) { return `**${s}**`; }
function mono(s) { return `\`${s}\``; }

// ─── Section builders ─────────────────────────────────────────────────────────

function buildCoverEmbed(matches, runDate) {
  const totals = {
    lobbying: matches.lobbyist_activity.length,
    finance: matches.campaign_finance.length,
    permits: matches.building_permits.length,
    transfers: matches.property_transfers.length,
  };
  const total = Object.values(totals).reduce((a, b) => a + b, 0);

  // Earliest date found across all sources
  const allDates = [
    ...matches.lobbyist_activity.map(({ row }) => row.date),
    ...matches.campaign_finance.map(({ row }) => row.filing_date),
    ...matches.building_permits.map(({ row }) => row.filed_date),
    ...matches.property_transfers.map(({ row }) => row.recording_date),
  ].filter(Boolean).map((d) => d.slice(0, 10)).sort();

  const earliest = allDates[0] || "—";
  const latest = allDates[allDates.length - 1] || "—";

  return {
    title: `🔍 Fillmore/Mehta Comprehensive Intelligence Report`,
    color: 0x1a1a2e,
    description:
      `A full-record synthesis of all public filings related to Neil Mehta, ` +
      `the Upper Fillmore Revitalization Project, and associated entities.\n\n` +
      `**Report generated:** ${runDate}\n` +
      `**Records span:** ${earliest} → ${latest}\n` +
      `**Total matched records:** ${total}\n\n` +
      `> 🏛 Lobbying filings: **${totals.lobbying}**\n` +
      `> 💰 Campaign finance transactions: **${totals.finance}**\n` +
      `> 🏗 Building permits: **${totals.permits}**\n` +
      `> 🏠 Property recordings: **${totals.transfers}**\n\n` +
      `**Tracked entities (${SEARCH_TERMS.length}):**\n` +
      SEARCH_TERMS.map(mono).join(" • "),
    footer: { text: "SF Fillmore Report • DataSF open data • One-time snapshot" },
    timestamp: new Date().toISOString(),
  };
}

function buildLobbyingEmbed(lobbyistMatches) {
  if (lobbyistMatches.length === 0) {
    return [{
      title: "🏛 1. Lobbying Activity",
      color: 0xe74c3c,
      description: "No lobbying records found matching tracked entities.",
    }];
  }

  // Group by firm → lobbyist → client → activities
  const byFirm = new Map();
  for (const { row, terms, link } of lobbyistMatches) {
    const firm = row.firmname || "Independent";
    const lobbyist = row.lobbyistname || "Unknown";
    const client = row.clientname || "Unknown Client";
    const desc = row.description || "—";
    const date = row.date ? row.date.slice(0, 10) : "—";
    const official = row.employeename || row.candidatename || null;

    const key = firm;
    if (!byFirm.has(key)) byFirm.set(key, { firm, lobbyists: new Map() });
    const firmEntry = byFirm.get(key);
    if (!firmEntry.lobbyists.has(lobbyist)) firmEntry.lobbyists.set(lobbyist, new Map());
    const lobbyistEntry = firmEntry.lobbyists.get(lobbyist);
    if (!lobbyistEntry.has(client)) lobbyistEntry.set(client, []);
    lobbyistEntry.get(client).push({ desc, date, official, terms, link });
  }

  // Collect all officials ever contacted
  const officialsContacted = new Map();
  for (const { row, link } of lobbyistMatches) {
    const name = row.employeename || row.candidatename;
    if (name && name.trim()) {
      if (!officialsContacted.has(name)) {
        officialsContacted.set(name, { count: 0, clients: new Set(), links: [] });
      }
      const e = officialsContacted.get(name);
      e.count++;
      if (row.clientname) e.clients.add(row.clientname);
      e.links.push(link);
    }
  }

  // Date range of lobbying
  const dates = lobbyistMatches
    .map(({ row }) => row.date).filter(Boolean).map((d) => d.slice(0, 10)).sort();
  const firstFiling = dates[0] || "—";
  const lastFiling = dates[dates.length - 1] || "—";

  let desc =
    `**${lobbyistMatches.length} total lobbying disclosure(s)** spanning ` +
    `${firstFiling} → ${lastFiling}\n\n`;

  for (const { firm, lobbyists } of byFirm.values()) {
    desc += `### ${firm}\n`;
    for (const [lobbyist, clients] of lobbyists) {
      desc += `**Lobbyist:** ${lobbyist}\n`;
      for (const [client, activities] of clients) {
        desc += `↳ **Client:** ${client} — ${activities.length} filing(s)\n`;
        // Show up to 5 most recent activities
        const sorted = activities.sort((a, b) => b.date.localeCompare(a.date));
        for (const { date, desc: actDesc, official, link } of sorted.slice(0, 5)) {
          desc += `  • ${date}`;
          if (official) desc += ` | Official contacted: ${bold(official)}`;
          if (actDesc !== "—") desc += ` | ${actDesc.slice(0, 80)}`;
          desc += ` [↗](${link})\n`;
        }
        if (activities.length > 5) {
          desc += `  • …and ${activities.length - 5} earlier filing(s)\n`;
        }
      }
      desc += "\n";
    }
  }

  const embeds = [{
    title: "🏛 1. Lobbying Activity",
    color: 0xe74c3c,
    description: truncate(desc),
  }];

  // Officials sub-embed if there are any
  if (officialsContacted.size > 0) {
    let oDesc = `**${officialsContacted.size} city official(s) contacted** across all lobbying filings:\n\n`;
    const sorted = [...officialsContacted.entries()]
      .sort((a, b) => b[1].count - a[1].count);
    for (const [name, { count, clients }] of sorted) {
      oDesc += `• ${bold(name)} — contacted ${count} time(s)`;
      if (clients.size > 0) oDesc += ` on behalf of ${[...clients].join(", ")}`;
      oDesc += "\n";
    }
    embeds.push({
      title: "🏛 1b. City Officials Contacted",
      color: 0xc0392b,
      description: truncate(oDesc),
    });
  }

  return embeds;
}

function buildFinanceEmbed(financeMatches) {
  if (financeMatches.length === 0) {
    return [{
      title: "💰 2. Campaign Finance",
      color: 0x27ae60,
      description: "No campaign finance records found matching tracked entities.",
    }];
  }

  const contributions = financeMatches.map(({ row, terms, link }) => ({
    contributor: [row.tran_namf, row.tran_naml].filter(Boolean).join(" ") || "Unknown",
    employer: row.tran_emp || "—",
    recipient: row.filer_naml || "Unknown Committee",
    amount: Number(row.tran_amt1 || 0),
    date: row.filing_date ? row.filing_date.slice(0, 10) : "—",
    formType: row.form_type || "—",
    terms,
    link,
  })).sort((a, b) => b.amount - a.amount);

  const totalAmount = contributions.reduce((s, r) => s + r.amount, 0);

  // Group by recipient committee
  const byRecipient = new Map();
  for (const c of contributions) {
    if (!byRecipient.has(c.recipient)) byRecipient.set(c.recipient, []);
    byRecipient.get(c.recipient).push(c);
  }

  const dates = contributions.map((c) => c.date).filter(Boolean).sort();

  let desc =
    `**${contributions.length} transaction(s)** | ` +
    `**Total tracked: $${totalAmount.toLocaleString()}** | ` +
    `${dates[0] || "—"} → ${dates[dates.length - 1] || "—"}\n\n`;

  // By recipient
  desc += `**Breakdown by recipient committee:**\n`;
  for (const [recipient, contribs] of [...byRecipient.entries()]
    .sort((a, b) => b[1].reduce((s, r) => s + r.amount, 0) - a[1].reduce((s, r) => s + r.amount, 0))) {
    const subtotal = contribs.reduce((s, r) => s + r.amount, 0);
    desc += `\n**→ ${recipient}** — $${subtotal.toLocaleString()} across ${contribs.length} transaction(s)\n`;
    for (const { contributor, employer, amount, date, link } of contribs.slice(0, 6)) {
      desc += `  • ${date} | ${bold(contributor)}`;
      if (employer !== "—") desc += ` (${employer})`;
      desc += ` | $${amount.toLocaleString()} [↗](${link})\n`;
    }
    if (contribs.length > 6) desc += `  • …and ${contribs.length - 6} more\n`;
  }

  return [{
    title: "💰 2. Campaign Finance",
    color: 0x27ae60,
    description: truncate(desc),
  }];
}

function buildPermitsEmbed(permitMatches) {
  if (permitMatches.length === 0) {
    return [{
      title: "🏗 3. Permit & Construction Activity",
      color: 0xf39c12,
      description: "No building permit records found matching tracked entities.",
    }];
  }

  // Group by address
  const byAddress = new Map();
  for (const { row, terms, link } of permitMatches) {
    const address = [row.street_number, row.street_name, row.street_suffix]
      .filter(Boolean).join(" ") || "Unknown Address";
    if (!byAddress.has(address)) byAddress.set(address, []);
    byAddress.get(address).push({
      permitNum: row.permit_number || "—",
      desc: (row.description || "—").slice(0, 120),
      applicant: row.applicant_name || row.owner_name || "—",
      status: row.status || "—",
      date: row.filed_date ? row.filed_date.slice(0, 10) : "—",
      completedDate: row.completed_date ? row.completed_date.slice(0, 10) : null,
      estimatedCost: row.estimated_cost ? `$${Number(row.estimated_cost).toLocaleString()}` : null,
      terms,
      link,
    });
  }

  const dates = permitMatches
    .map(({ row }) => row.filed_date).filter(Boolean).map((d) => d.slice(0, 10)).sort();

  let desc =
    `**${permitMatches.length} permit record(s)** across **${byAddress.size} address(es)** | ` +
    `${dates[0] || "—"} → ${dates[dates.length - 1] || "—"}\n\n`;

  for (const [address, permits] of byAddress) {
    desc += `📍 **${address}** — ${permits.length} permit(s)\n`;
    const sorted = permits.sort((a, b) => b.date.localeCompare(a.date));
    for (const { permitNum, desc: pDesc, applicant, status, date, completedDate, estimatedCost, link } of sorted) {
      desc += `  • ${mono(permitNum)} | ${bold(status)} | Filed: ${date}`;
      if (completedDate) desc += ` | Completed: ${completedDate}`;
      if (estimatedCost) desc += ` | Est. cost: ${estimatedCost}`;
      desc += `\n    Applicant: ${applicant}\n`;
      desc += `    Work: ${pDesc} [↗](${link})\n`;
    }
    desc += "\n";
  }

  return [{
    title: "🏗 3. Permit & Construction Activity",
    color: 0xf39c12,
    description: truncate(desc),
  }];
}

function buildTransfersEmbed(transferMatches) {
  if (transferMatches.length === 0) {
    return [{
      title: "🏠 4. Property Transactions",
      color: 0x9b59b6,
      description: "No property transfer records found matching tracked entities.",
    }];
  }

  const transfers = transferMatches.map(({ row, terms, link }) => ({
    docType: row.document_type || "—",
    buyer: row.grantee_names || "—",
    seller: row.grantor_names || "—",
    date: row.recording_date ? row.recording_date.slice(0, 10) : "—",
    docNumber: row.document_number || "—",
    legalDesc: (row.legal_description || "").slice(0, 100),
    terms,
    link,
  })).sort((a, b) => b.date.localeCompare(a.date));

  // Group by document type
  const byType = new Map();
  for (const t of transfers) {
    if (!byType.has(t.docType)) byType.set(t.docType, []);
    byType.get(t.docType).push(t);
  }

  let desc =
    `**${transfers.length} recorded document(s)** | ` +
    `${transfers[transfers.length - 1]?.date || "—"} → ${transfers[0]?.date || "—"}\n\n`;

  for (const [docType, docs] of byType) {
    desc += `**${docType}** (${docs.length})\n`;
    for (const { buyer, seller, date, docNumber, link } of docs) {
      desc += `  • ${date} | Doc: ${mono(docNumber)}\n`;
      desc += `    Grantor: ${seller}\n`;
      desc += `    Grantee: ${buyer} [↗](${link})\n`;
    }
    desc += "\n";
  }

  return [{
    title: "🏠 4. Property Transactions",
    color: 0x9b59b6,
    description: truncate(desc),
  }];
}

function buildNetworkEmbed(matches) {
  // Count how many times each tracked term appears across all sources
  const termCounts = new Map(SEARCH_TERMS.map((t) => [t, 0]));
  for (const source of SOURCES) {
    for (const { terms } of matches[source.id]) {
      for (const t of terms) termCounts.set(t, (termCounts.get(t) || 0) + 1);
    }
  }

  // Which terms appear across multiple source types (cross-source presence = more significant)
  const termSources = new Map(SEARCH_TERMS.map((t) => [t, new Set()]));
  for (const source of SOURCES) {
    for (const { terms } of matches[source.id]) {
      for (const t of terms) termSources.get(t)?.add(source.id);
    }
  }

  // Unique lobbyist firms
  const firms = [...new Set(
    matches.lobbyist_activity.map(({ row }) => row.firmname).filter(Boolean)
  )];

  // Unique clients
  const clients = [...new Set(
    matches.lobbyist_activity.map(({ row }) => row.clientname).filter(Boolean)
  )];

  // Unique campaign recipients
  const recipients = [...new Set(
    matches.campaign_finance.map(({ row }) => row.filer_naml).filter(Boolean)
  )];

  let desc = `**Entity frequency across all public records:**\n\n`;

  const sorted = [...termCounts.entries()]
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1]);

  for (const [term, count] of sorted) {
    const sources = [...(termSources.get(term) || [])];
    const sourceLabels = sources.map((s) => ({
      lobbyist_activity: "Lobbying",
      campaign_finance: "Finance",
      building_permits: "Permits",
      property_transfers: "Property",
    }[s])).join(", ");
    desc += `• ${bold(term)}: **${count}** record(s) in [${sourceLabels || "—"}]\n`;
  }

  if (sorted.length === 0) desc += "_No terms matched any records._\n";

  if (firms.length > 0) {
    desc += `\n**Lobbying firms active on behalf of tracked entities:**\n`;
    firms.forEach((f) => { desc += `• ${f}\n`; });
  }

  if (clients.length > 0) {
    desc += `\n**Clients listed in lobbying filings:**\n`;
    clients.forEach((c) => { desc += `• ${c}\n`; });
  }

  if (recipients.length > 0) {
    desc += `\n**Campaign committees receiving tracked contributions:**\n`;
    recipients.forEach((r) => { desc += `• ${r}\n`; });
  }

  return [{
    title: "🕸 5. Key Entities & Network Map",
    color: 0x2980b9,
    description: truncate(desc),
  }];
}

function buildBriefingEmbed(matches, runDate) {
  const lobbyCount = matches.lobbyist_activity.length;
  const financeCount = matches.campaign_finance.length;
  const permitCount = matches.building_permits.length;
  const transferCount = matches.property_transfers.length;

  const firms = [...new Set(
    matches.lobbyist_activity.map(({ row }) => row.firmname).filter(Boolean)
  )];
  const clients = [...new Set(
    matches.lobbyist_activity.map(({ row }) => row.clientname).filter(Boolean)
  )];
  const officialsSet = new Set(
    matches.lobbyist_activity
      .map(({ row }) => row.employeename || row.candidatename)
      .filter(Boolean)
  );
  const totalMoney = matches.campaign_finance
    .reduce((s, { row }) => s + Number(row.tran_amt1 || 0), 0);
  const recipients = [...new Set(
    matches.campaign_finance.map(({ row }) => row.filer_naml).filter(Boolean)
  )];
  const permitAddresses = [...new Set(
    matches.building_permits.map(({ row }) =>
      [row.street_number, row.street_name].filter(Boolean).join(" ")
    ).filter(Boolean)
  )];

  const lines = [];

  if (lobbyCount > 0) {
    lines.push(
      `**Lobbying:** ${firms.join(" and ")} ha${firms.length === 1 ? "s" : "ve"} filed ` +
      `**${lobbyCount} lobbying disclosure(s)** with the SF Ethics Commission on behalf of ` +
      `${clients.join(", ")}. ` +
      (officialsSet.size > 0
        ? `City officials contacted include: ${[...officialsSet].join(", ")}.`
        : "No city official contact records found.")
    );
  }

  if (financeCount > 0) {
    lines.push(
      `**Political money:** Tracked entities are associated with **$${totalMoney.toLocaleString()}** ` +
      `across **${financeCount} campaign finance transaction(s)**, flowing to ` +
      `${recipients.length > 0 ? recipients.join(", ") : "unknown committees"}.`
    );
  }

  if (permitCount > 0) {
    lines.push(
      `**Construction:** **${permitCount} building permit(s)** have been filed at ` +
      `${permitAddresses.length > 0
        ? permitAddresses.slice(0, 5).join("; ") + (permitAddresses.length > 5 ? " and others" : "")
        : "tracked addresses"}.`
    );
  }

  if (transferCount > 0) {
    lines.push(
      `**Property:** **${transferCount} recorded document(s)** — deeds, transfers, and other ` +
      `instruments — involving tracked entities appear in the SF Assessor-Recorder's database.`
    );
  }

  if (lines.length === 0) {
    lines.push("No records matched across any of the four data sources for the tracked entities.");
  }

  return [{
    title: "📰 6. Reporter's Briefing",
    color: 0x2c3e50,
    description:
      `_Comprehensive plain-language synthesis as of ${runDate}:_\n\n` +
      lines.join("\n\n") +
      `\n\n---\n_This is a one-time snapshot report. All source data is from DataSF open data portals. ` +
      `Individual filing links point directly to source records._`,
    footer: {
      text: `SF Fillmore Intelligence Report • Generated ${runDate}`,
    },
  }];
}

// ─── Discord posting ──────────────────────────────────────────────────────────

async function postToDiscord(embeds) {
  if (!DISCORD_WEBHOOK_URL) {
    console.log("\n[DRY RUN] Would post", embeds.length, "embeds to Discord.");
    console.log(JSON.stringify(embeds, null, 2));
    return;
  }

  const BATCH_SIZE = 10;
  for (let i = 0; i < embeds.length; i += BATCH_SIZE) {
    const batch = embeds.slice(i, i + BATCH_SIZE);
    const result = await postJSON(DISCORD_WEBHOOK_URL, { embeds: batch });
    if (result.status >= 300) {
      console.error(`Discord error ${result.status}:`, result.body);
    } else {
      console.log(`✅ Posted embed batch ${Math.floor(i / BATCH_SIZE) + 1} of ${Math.ceil(embeds.length / BATCH_SIZE)}`);
    }
    if (i + BATCH_SIZE < embeds.length) {
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const runDate = new Date().toISOString().slice(0, 10);

  console.log("═".repeat(60));
  console.log("SF Fillmore Comprehensive Research Report");
  console.log(`  Generated:  ${runDate}`);
  console.log(`  Since:      ${SINCE_DATE}`);
  console.log(`  Webhook:    ${!!DISCORD_WEBHOOK_URL}`);
  console.log(`  Terms (${SEARCH_TERMS.length}):`, SEARCH_TERMS);
  console.log("═".repeat(60));

  const matches = await fetchAllMatches();

  const total =
    matches.lobbyist_activity.length +
    matches.campaign_finance.length +
    matches.building_permits.length +
    matches.property_transfers.length;

  console.log(`\n✅ Total matches across all sources: ${total}`);

  const embeds = [
    buildCoverEmbed(matches, runDate),
    ...buildLobbyingEmbed(matches.lobbyist_activity),
    ...buildFinanceEmbed(matches.campaign_finance),
    ...buildPermitsEmbed(matches.building_permits),
    ...buildTransfersEmbed(matches.property_transfers),
    ...buildNetworkEmbed(matches),
    ...buildBriefingEmbed(matches, runDate),
  ];

  console.log(`\n📨 Posting ${embeds.length} embeds to Discord…`);
  await postToDiscord(embeds);

  console.log("\n" + "═".repeat(60));
  console.log("Report complete.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
