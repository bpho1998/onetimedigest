/**
 * SF Fillmore Research Report
 *
 * A one-time script that pulls ALL matching records across all 4 SF open
 * data sources and synthesizes them into a comprehensive intelligence report
 * posted to Discord as a structured, reporter-ready briefing.
 *
 * Run once manually from GitHub Actions. That's it.
 */

const fs    = require("fs");
const path  = require("path");
const https = require("https");

// ─── Configuration ────────────────────────────────────────────────────────────

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
    // Confirmed field names from DataSF lobbyist dataset
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
    // Confirmed field names from DataSF campaign finance transactions dataset
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
    // Helper to extract amount and names for display
    getAmount: (r) => Number(r.transaction_amount_1 || 0),
    getContributor: (r) =>
      [r.transaction_first_name, r.transaction_last_name].filter(Boolean).join(" ") || "Unknown",
    getRecipient: (r) => r.filer_name || "Unknown Committee",
    getDate: (r) => r.transaction_date ? r.transaction_date.slice(0, 10) : (r.filing_date ? r.filing_date.slice(0, 10) : "—"),
  },
  {
    id: "building_permits",
    label: "Building Permits",
    url: "https://data.sfgov.org/resource/i98e-djp9.json",
    dateField: "filed_date",
    // Confirmed field names — no applicant_name or owner_name in this dataset
    textFields: ["description", "street_name"],
    linkTemplate: (r) =>
      r.permit_number
        ? `https://dbiweb02.sfgov.org/dbipts/default.aspx?permit=${r.permit_number}`
        : "https://sfdbi.org/dbipts",
  },
  {
    id: "property_transfers",
    label: "Property Transfers",
    // SF Assessor Recorded Documents — confirmed dataset
    // Note: wv5m-vpq2 had 0 rows; using the correct Assessor dataset
    url: "https://data.sfgov.org/resource/wv5m-vpq2.json",
    dateField: "recorded_datetime",
    textFields: ["grantor_names", "grantee_names", "document_type_description", "legal_description"],
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

// ─── Data fetching — paginated, no lookback limit ─────────────────────────────

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

      if (rows.length < limit) break;
      offset += limit;
      await new Promise((r) => setTimeout(r, 300));
    }

    console.log(`  ↳ Scanned ${totalFetched} total rows → ${results[source.id].length} matches`);
  }

  return results;
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

// Discord hard limits: embed description 4096 chars, field value 1024 chars
// We stay well under by truncating at 3800 and splitting into multiple embeds
function truncate(str, max = 3800) {
  if (str.length <= max) return str;
  return str.slice(0, max - 4) + "\n…";
}

function bold(s) { return `**${s}**`; }
function mono(s) { return `\`${s}\``; }

// Split a long text block into multiple embed descriptions of max `maxLen` chars
function splitIntoEmbeds(title, color, fullText, maxLen = 3800) {
  if (fullText.length <= maxLen) {
    return [{ title, color, description: fullText }];
  }
  const chunks = [];
  let remaining = fullText;
  let part = 1;
  while (remaining.length > 0) {
    const chunk = remaining.slice(0, maxLen);
    // Try to break at a newline
    const lastNewline = chunk.lastIndexOf("\n");
    const breakAt = lastNewline > maxLen * 0.7 ? lastNewline : maxLen;
    chunks.push(remaining.slice(0, breakAt));
    remaining = remaining.slice(breakAt).trimStart();
    part++;
  }
  return chunks.map((text, i) => ({
    title: chunks.length > 1 ? `${title} (${i + 1}/${chunks.length})` : title,
    color,
    description: text,
  }));
}

// ─── Section builders ─────────────────────────────────────────────────────────

function buildCoverEmbed(matches, runDate) {
  const totals = {
    lobbying: matches.lobbyist_activity.length,
    finance: matches.campaign_finance.length,
    permits: matches.building_permits.length,
    transfers: matches.property_transfers.length,
  };
  const total = Object.values(totals).reduce((a, b) => a + b, 0);

  const allDates = [
    ...matches.lobbyist_activity.map(({ row }) => row.date),
    ...matches.campaign_finance.map(({ row }) => row.filing_date),
    ...matches.building_permits.map(({ row }) => row.filed_date),
    ...matches.property_transfers.map(({ row }) => row.recorded_datetime),
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

function buildLobbyingEmbeds(lobbyistMatches) {
  if (lobbyistMatches.length === 0) {
    return [{ title: "🏛 1. Lobbying Activity", color: 0xe74c3c,
      description: "No lobbying records found." }];
  }

  const byFirm = new Map();
  for (const { row, terms, link } of lobbyistMatches) {
    const firm = row.firmname || "Independent";
    const lobbyist = row.lobbyistname || "Unknown";
    const client = row.clientname || "Unknown Client";
    const desc = row.description || "—";
    const date = row.date ? row.date.slice(0, 10) : "—";
    const official = row.employeename || row.candidatename || null;

    if (!byFirm.has(firm)) byFirm.set(firm, new Map());
    const firmEntry = byFirm.get(firm);
    if (!firmEntry.has(lobbyist)) firmEntry.set(lobbyist, new Map());
    const lobbyistEntry = firmEntry.get(lobbyist);
    if (!lobbyistEntry.has(client)) lobbyistEntry.set(client, []);
    lobbyistEntry.get(client).push({ desc, date, official, terms, link });
  }

  const officialsContacted = new Map();
  for (const { row } of lobbyistMatches) {
    const name = row.employeename || row.candidatename;
    if (name && name.trim()) {
      if (!officialsContacted.has(name)) {
        officialsContacted.set(name, { count: 0, clients: new Set() });
      }
      officialsContacted.get(name).count++;
      if (row.clientname) officialsContacted.get(name).clients.add(row.clientname);
    }
  }

  const dates = lobbyistMatches.map(({ row }) => row.date).filter(Boolean)
    .map((d) => d.slice(0, 10)).sort();

  let desc =
    `**${lobbyistMatches.length} total lobbying disclosure(s)** | ` +
    `${dates[0] || "—"} → ${dates[dates.length - 1] || "—"}\n\n`;

  for (const [firm, lobbyists] of byFirm) {
    desc += `### ${firm}\n`;
    for (const [lobbyist, clients] of lobbyists) {
      desc += `**${lobbyist}**\n`;
      for (const [client, activities] of clients) {
        desc += `↳ Client: **${client}** — ${activities.length} filing(s)\n`;
        const sorted = activities.sort((a, b) => b.date.localeCompare(a.date));
        for (const { date, desc: actDesc, official, link } of sorted.slice(0, 4)) {
          desc += `  • ${date}`;
          if (official) desc += ` | Official: **${official}**`;
          if (actDesc !== "—") desc += ` | ${actDesc.slice(0, 70)}`;
          desc += ` [↗](${link})\n`;
        }
        if (activities.length > 4) desc += `  • …and ${activities.length - 4} more\n`;
      }
      desc += "\n";
    }
  }

  const embeds = splitIntoEmbeds("🏛 1. Lobbying Activity", 0xe74c3c, desc);

  if (officialsContacted.size > 0) {
    let oDesc = `**${officialsContacted.size} city official(s) contacted:**\n\n`;
    [...officialsContacted.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .forEach(([name, { count, clients }]) => {
        oDesc += `• **${name}** — ${count} contact(s)`;
        if (clients.size > 0) oDesc += ` on behalf of ${[...clients].join(", ")}`;
        oDesc += "\n";
      });
    embeds.push(...splitIntoEmbeds("🏛 1b. City Officials Contacted", 0xc0392b, oDesc));
  }

  return embeds;
}

function buildFinanceEmbeds(financeMatches, source) {
  if (financeMatches.length === 0) {
    return [{ title: "💰 2. Campaign Finance", color: 0x27ae60,
      description: "No campaign finance records found." }];
  }

  const contributions = financeMatches.map(({ row, terms, link }) => ({
    contributor: source.getContributor(row),
    employer: row.transaction_employer || "—",
    recipient: source.getRecipient(row),
    amount: source.getAmount(row),
    date: source.getDate(row),
    terms,
    link,
  })).sort((a, b) => b.amount - a.amount);

  const totalAmount = contributions.reduce((s, r) => s + r.amount, 0);

  const byRecipient = new Map();
  for (const c of contributions) {
    if (!byRecipient.has(c.recipient)) byRecipient.set(c.recipient, []);
    byRecipient.get(c.recipient).push(c);
  }

  const dates = contributions.map((c) => c.date).filter((d) => d !== "—").sort();

  let desc =
    `**${contributions.length} transaction(s)** | ` +
    `**Total: $${totalAmount.toLocaleString()}** | ` +
    `${dates[0] || "—"} → ${dates[dates.length - 1] || "—"}\n\n`;

  for (const [recipient, contribs] of [...byRecipient.entries()]
    .sort((a, b) =>
      b[1].reduce((s, r) => s + r.amount, 0) - a[1].reduce((s, r) => s + r.amount, 0))) {
    const subtotal = contribs.reduce((s, r) => s + r.amount, 0);
    desc += `**→ ${recipient}** — $${subtotal.toLocaleString()} (${contribs.length} transaction(s))\n`;
    for (const { contributor, employer, amount, date, link } of contribs.slice(0, 5)) {
      desc += `  • ${date} | **${contributor}**`;
      if (employer !== "—") desc += ` (${employer})`;
      desc += ` | $${amount.toLocaleString()} [↗](${link})\n`;
    }
    if (contribs.length > 5) desc += `  • …and ${contribs.length - 5} more\n`;
    desc += "\n";
  }

  return splitIntoEmbeds("💰 2. Campaign Finance", 0x27ae60, desc);
}

function buildPermitsEmbeds(permitMatches) {
  if (permitMatches.length === 0) {
    return [{ title: "🏗 3. Building Permits", color: 0xf39c12,
      description: "No building permit records found." }];
  }

  const byAddress = new Map();
  for (const { row, terms, link } of permitMatches) {
    const address = [row.street_number, row.street_name, row.street_suffix]
      .filter(Boolean).join(" ") || "Unknown Address";
    if (!byAddress.has(address)) byAddress.set(address, []);
    byAddress.get(address).push({
      permitNum: row.permit_number || "—",
      desc: (row.description || "—").slice(0, 100),
      status: row.status || "—",
      date: row.filed_date ? row.filed_date.slice(0, 10) : "—",
      completedDate: row.completed_date ? row.completed_date.slice(0, 10) : null,
      estimatedCost: row.estimated_cost ? `$${Number(row.estimated_cost).toLocaleString()}` : null,
      terms,
      link,
    });
  }

  const dates = permitMatches.map(({ row }) => row.filed_date)
    .filter(Boolean).map((d) => d.slice(0, 10)).sort();

  let desc =
    `**${permitMatches.length} permit(s)** across **${byAddress.size} address(es)** | ` +
    `${dates[0] || "—"} → ${dates[dates.length - 1] || "—"}\n\n`;

  for (const [address, permits] of byAddress) {
    desc += `📍 **${address}** (${permits.length} permit(s))\n`;
    for (const { permitNum, desc: pDesc, status, date, completedDate, estimatedCost, link } of
      permits.sort((a, b) => b.date.localeCompare(a.date))) {
      desc += `  • ${mono(permitNum)} | **${status}** | ${date}`;
      if (completedDate) desc += ` → ${completedDate}`;
      if (estimatedCost) desc += ` | ${estimatedCost}`;
      desc += `\n    ${pDesc} [↗](${link})\n`;
    }
    desc += "\n";
  }

  return splitIntoEmbeds("🏗 3. Building Permits", 0xf39c12, desc);
}

function buildTransfersEmbeds(transferMatches) {
  if (transferMatches.length === 0) {
    return [{ title: "🏠 4. Property Transactions", color: 0x9b59b6,
      description: "No property transfer records found." }];
  }

  const transfers = transferMatches.map(({ row, terms, link }) => ({
    docType: row.document_type_description || row.document_type || "—",
    buyer: row.grantee_names || "—",
    seller: row.grantor_names || "—",
    date: row.recorded_datetime ? row.recorded_datetime.slice(0, 10) : "—",
    docNumber: row.document_number || "—",
    terms,
    link,
  })).sort((a, b) => b.date.localeCompare(a.date));

  let desc = `**${transfers.length} recorded document(s)**\n\n`;

  const byType = new Map();
  for (const t of transfers) {
    if (!byType.has(t.docType)) byType.set(t.docType, []);
    byType.get(t.docType).push(t);
  }

  for (const [docType, docs] of byType) {
    desc += `**${docType}** (${docs.length})\n`;
    for (const { buyer, seller, date, docNumber, link } of docs) {
      desc += `  • ${date} | Doc: ${mono(docNumber)}\n`;
      desc += `    Grantor: ${seller}\n`;
      desc += `    Grantee: ${buyer} [↗](${link})\n`;
    }
    desc += "\n";
  }

  return splitIntoEmbeds("🏠 4. Property Transactions", 0x9b59b6, desc);
}

function buildNetworkEmbeds(matches) {
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

  const sourceLabel = {
    lobbyist_activity: "Lobbying",
    campaign_finance: "Finance",
    building_permits: "Permits",
    property_transfers: "Property",
  };

  const firms = [...new Set(matches.lobbyist_activity.map(({ row }) => row.firmname).filter(Boolean))];
  const clients = [...new Set(matches.lobbyist_activity.map(({ row }) => row.clientname).filter(Boolean))];
  const recipients = [...new Set(matches.campaign_finance.map(({ row }) => row.filer_name).filter(Boolean))];

  let desc = `**Entity frequency across all public records:**\n\n`;

  [...termCounts.entries()]
    .filter(([, c]) => c > 0)
    .sort((a, b) => b[1] - a[1])
    .forEach(([term, count]) => {
      const sources = [...(termSources.get(term) || [])].map((s) => sourceLabel[s]).join(", ");
      desc += `• **${term}**: **${count}** record(s) [${sources || "—"}]\n`;
    });

  if (firms.length > 0) {
    desc += `\n**Lobbying firms active for tracked entities:**\n`;
    firms.forEach((f) => { desc += `• ${f}\n`; });
  }
  if (clients.length > 0) {
    desc += `\n**Clients in lobbying filings:**\n`;
    clients.forEach((c) => { desc += `• ${c}\n`; });
  }
  if (recipients.length > 0) {
    desc += `\n**Campaign committees receiving tracked contributions:**\n`;
    recipients.forEach((r) => { desc += `• ${r}\n`; });
  }

  return splitIntoEmbeds("🕸 5. Entity Network Map", 0x2980b9, desc);
}

function buildBriefingEmbed(matches, runDate) {
  const financeSource = SOURCES.find((s) => s.id === "campaign_finance");
  const lobbyCount = matches.lobbyist_activity.length;
  const financeCount = matches.campaign_finance.length;
  const permitCount = matches.building_permits.length;
  const transferCount = matches.property_transfers.length;

  const firms = [...new Set(matches.lobbyist_activity.map(({ row }) => row.firmname).filter(Boolean))];
  const clients = [...new Set(matches.lobbyist_activity.map(({ row }) => row.clientname).filter(Boolean))];
  const officials = [...new Set(
    matches.lobbyist_activity.map(({ row }) => row.employeename || row.candidatename).filter(Boolean)
  )];
  const totalMoney = matches.campaign_finance.reduce((s, { row }) =>
    s + Number(row.transaction_amount_1 || 0), 0);
  const recipients = [...new Set(matches.campaign_finance.map(({ row }) => row.filer_name).filter(Boolean))];
  const permitAddresses = [...new Set(
    matches.building_permits.map(({ row }) =>
      [row.street_number, row.street_name].filter(Boolean).join(" ")).filter(Boolean)
  )];

  const lines = [];

  if (lobbyCount > 0) {
    lines.push(
      `**Lobbying:** ${firms.length > 0 ? firms.join(" and ") : "Unknown firm(s)"} filed ` +
      `**${lobbyCount} lobbying disclosure(s)** on behalf of ${clients.join(", ") || "unknown clients"}. ` +
      (officials.length > 0
        ? `City officials contacted include: ${officials.slice(0, 5).join(", ")}${officials.length > 5 ? " and others" : ""}.`
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
      `**Construction:** **${permitCount} building permit(s)** filed at ` +
      `${permitAddresses.length > 0
        ? permitAddresses.slice(0, 5).join("; ") + (permitAddresses.length > 5 ? " and others" : "")
        : "tracked addresses"}.`
    );
  }
  if (transferCount > 0) {
    lines.push(
      `**Property:** **${transferCount} recorded document(s)** involving tracked entities ` +
      `appear in the SF Assessor-Recorder database.`
    );
  }
  if (lines.length === 0) {
    lines.push("No records matched across any of the four data sources.");
  }

  return [{
    title: "📰 6. Reporter's Briefing",
    color: 0x2c3e50,
    description:
      `_Comprehensive plain-language synthesis as of ${runDate}:_\n\n` +
      lines.join("\n\n") +
      `\n\n---\n_One-time snapshot. All data from DataSF open data. ` +
      `Individual filing links go directly to source records._`,
    footer: { text: `SF Fillmore Intelligence Report • Generated ${runDate}` },
  }];
}

// ─── Discord posting ──────────────────────────────────────────────────────────

async function postToDiscord(embeds) {
  if (!DISCORD_WEBHOOK_URL) {
    console.log("\n[DRY RUN] Would post", embeds.length, "embeds to Discord.");
    return;
  }

  const BATCH_SIZE = 10;
  for (let i = 0; i < embeds.length; i += BATCH_SIZE) {
    const batch = embeds.slice(i, i + BATCH_SIZE);
    const result = await postJSON(DISCORD_WEBHOOK_URL, { embeds: batch });
    if (result.status >= 300) {
      console.error(`Discord error ${result.status} on batch ${Math.floor(i/BATCH_SIZE)+1}:`, result.body);
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

  const financeSource = SOURCES.find((s) => s.id === "campaign_finance");

  const embeds = [
    buildCoverEmbed(matches, runDate),
    ...buildLobbyingEmbeds(matches.lobbyist_activity),
    ...buildFinanceEmbeds(matches.campaign_finance, financeSource),
    ...buildPermitsEmbeds(matches.building_permits),
    ...buildTransfersEmbeds(matches.property_transfers),
    ...buildNetworkEmbeds(matches),
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
