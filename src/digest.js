/**
 * SF Fillmore Research Report — One-time comprehensive intelligence snapshot.
 *
 * MATCHING STRATEGY:
 *
 * The key insight: we want records *about* Mehta/Fillmore, not records *from*
 * lobbyists who happen to also work on Fillmore. So matching rules differ by
 * source and field:
 *
 * LOBBYIST ACTIVITY:
 *   - Match on CLIENT name fields (clientname) → any term
 *   - Match on SUBJECT/DESCRIPTION fields (description) → property/org terms only
 *   - Do NOT match on lobbyist/firm name alone — that pulls all their clients
 *
 * CAMPAIGN FINANCE:
 *   - Match on CONTRIBUTOR name (transaction_first_name, transaction_last_name)
 *   - Match on EMPLOYER (transaction_employer)
 *   - Match on RECIPIENT/FILER (filer_name)
 *   - Do NOT match on occupation alone
 *
 * BUILDING PERMITS:
 *   - Match on DESCRIPTION text and STREET NAME
 *   - "Fillmore" in street_name will catch all Fillmore St permits
 *   - Narrow to Fillmore St address range 2000-2299 to avoid false positives
 */

const https = require("https");

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const SINCE_DATE = process.env.SINCE_DATE || "2018-01-01";

// Terms that identify the SUBJECT of a filing (client, property, org)
// Used for matching against client names, descriptions, contributor names
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

// Terms that identify a FIRM/PERSON acting on behalf of Mehta interests
// Only used for lobbyist firm/name fields when the client is also identified
const AGENT_TERMS = [
  "Lighthouse Public Affairs",
  "Peterson, Rich",
];

const ALL_TERMS = [...SUBJECT_TERMS, ...AGENT_TERMS];

// Fillmore St address range for permit matching (2000–2299 Fillmore)
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

// ─── Matching — field-aware ───────────────────────────────────────────────────

function termIn(value, terms) {
  const v = (value || "").toString().toLowerCase();
  return terms.filter((t) => v.includes(t.toLowerCase()));
}

/**
 * Lobbyist records: match if ANY subject term appears in the client name,
 * OR if an agent term appears in the firm/lobbyist name AND a subject term
 * appears anywhere in the record (confirming it's Fillmore-related work).
 */
function matchLobbyist(row) {
  // Primary: client name contains a subject term
  const clientMatches = termIn(row.clientname, SUBJECT_TERMS);
  if (clientMatches.length > 0) return clientMatches;

  // Secondary: description contains a subject term
  const descMatches = termIn(row.description, SUBJECT_TERMS);
  if (descMatches.length > 0) return descMatches;

  // Tertiary: agent (firm/lobbyist) AND some other field confirms subject
  const isAgent = termIn(row.firmname, AGENT_TERMS).length > 0 ||
                  termIn(row.lobbyistname, AGENT_TERMS).length > 0;
  if (isAgent) {
    // Only include if another field also references a subject term
    const allText = [row.clientname, row.description, row.candidatename, row.employeename]
      .map((f) => (f || "").toLowerCase()).join(" ");
    const subjectConfirm = SUBJECT_TERMS.filter((t) => allText.includes(t.toLowerCase()));
    if (subjectConfirm.length > 0) {
      return [...termIn(row.firmname, AGENT_TERMS), ...termIn(row.lobbyistname, AGENT_TERMS)];
    }
  }

  return [];
}

/**
 * Campaign finance: match contributor name, employer, or recipient/filer name.
 * Do not match on occupation alone.
 */
function matchFinance(row) {
  const contributor = [row.transaction_first_name, row.transaction_last_name].join(" ");
  return [
    ...termIn(row.filer_name, ALL_TERMS),
    ...termIn(contributor, ALL_TERMS),
    ...termIn(row.transaction_employer, ALL_TERMS),
    ...termIn(row.transaction_description, SUBJECT_TERMS),
  ].filter((v, i, a) => a.indexOf(v) === i); // dedupe
}

/**
 * Building permits: match description text OR Fillmore St address range.
 */
function matchPermit(row) {
  const descMatches = termIn(row.description, SUBJECT_TERMS);
  if (descMatches.length > 0) return descMatches;

  // Check if address is on Fillmore St in the relevant block range
  const street = (row.street_name || "").toLowerCase();
  const num = parseInt(row.street_number || "0", 10);
  if (street === FILLMORE_RANGE.street && num >= FILLMORE_RANGE.min && num <= FILLMORE_RANGE.max) {
    return ["Fillmore St 2000-2299 block"];
  }

  return [];
}

// ─── Fetch ────────────────────────────────────────────────────────────────────

async function fetchAndMatch() {
  const results = { lobbyist_activity: [], campaign_finance: [], building_permits: [] };

  // Lobbyist activity
  console.log("\n📡 Fetching lobbyist_activity…");
  {
    let offset = 0, total = 0;
    const url_base = "https://data.sfgov.org/resource/s4ub-8j3t.json";
    while (true) {
      const where = encodeURIComponent(`date >= '${SINCE_DATE}'`);
      const url = `${url_base}?$where=${where}&$order=${encodeURIComponent("date ASC")}&$limit=1000&$offset=${offset}`;
      let rows;
      try { rows = await fetchJSON(url); } catch (e) { console.error(`  ❌ ${e.message}`); break; }
      if (!Array.isArray(rows) || rows.length === 0) break;
      total += rows.length;
      for (const row of rows) {
        const terms = matchLobbyist(row);
        if (terms.length > 0) {
          const link = row.fromfiling
            ? `https://netfile.com/app/lobbyist/filing/${row.fromfiling}/report`
            : "https://netfile.com/lobbyistpub/#sfo";
          results.lobbyist_activity.push({ row, terms, link });
        }
      }
      if (rows.length < 1000) break;
      offset += 1000;
      await new Promise((r) => setTimeout(r, 300));
    }
    console.log(`  ↳ ${total} rows → ${results.lobbyist_activity.length} matches`);
  }

  // Campaign finance
  console.log("\n📡 Fetching campaign_finance…");
  {
    let offset = 0, total = 0;
    const url_base = "https://data.sfgov.org/resource/pitq-e56w.json";
    while (true) {
      const where = encodeURIComponent(`filing_date >= '${SINCE_DATE}'`);
      const url = `${url_base}?$where=${where}&$order=${encodeURIComponent("filing_date ASC")}&$limit=1000&$offset=${offset}`;
      let rows;
      try { rows = await fetchJSON(url); } catch (e) { console.error(`  ❌ ${e.message}`); break; }
      if (!Array.isArray(rows) || rows.length === 0) break;
      total += rows.length;
      for (const row of rows) {
        const terms = matchFinance(row);
        if (terms.length > 0) {
          const link = row.filing_id_number
            ? `https://netfile.com/pub2/api/filing/${row.filing_id_number}/detail?aid=sfo`
            : "https://sfethics.org/disclosures/campaign-finance-disclosure";
          results.campaign_finance.push({ row, terms, link });
        }
      }
      if (rows.length < 1000) break;
      offset += 1000;
      await new Promise((r) => setTimeout(r, 300));
    }
    console.log(`  ↳ ${total} rows → ${results.campaign_finance.length} matches`);
  }

  // Building permits
  console.log("\n📡 Fetching building_permits…");
  {
    let offset = 0, total = 0;
    const url_base = "https://data.sfgov.org/resource/i98e-djp9.json";
    while (true) {
      const where = encodeURIComponent(`filed_date >= '${SINCE_DATE}'`);
      const url = `${url_base}?$where=${where}&$order=${encodeURIComponent("filed_date ASC")}&$limit=1000&$offset=${offset}`;
      let rows;
      try { rows = await fetchJSON(url); } catch (e) { console.error(`  ❌ ${e.message}`); break; }
      if (!Array.isArray(rows) || rows.length === 0) break;
      total += rows.length;
      for (const row of rows) {
        const terms = matchPermit(row);
        if (terms.length > 0) {
          const link = row.permit_number
            ? `https://dbiweb02.sfgov.org/dbipts/default.aspx?permit=${row.permit_number}`
            : "https://sfdbi.org/dbipts";
          results.building_permits.push({ row, terms, link });
        }
      }
      if (rows.length < 1000) break;
      offset += 1000;
      await new Promise((r) => setTimeout(r, 300));
    }
    console.log(`  ↳ ${total} rows → ${results.building_permits.length} matches`);
  }

  return results;
}

// ─── Embed builder ────────────────────────────────────────────────────────────

function embed(title, color, description, footerText) {
  const MAX = 2000;
  const d = description.length > MAX ? description.slice(0, MAX - 1) + "…" : description;
  const e = { title: title.slice(0, 100), color, description: d };
  if (footerText) e.footer = { text: footerText.slice(0, 200) };
  return e;
}

const b = (s) => `**${s}**`;
const m = (s) => `\`${s}\``;

// ─── Section: Cover ───────────────────────────────────────────────────────────

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
    `**Tracked entities:** ${ALL_TERMS.map(m).join(" ")}`,
    "SF Fillmore Report • DataSF • One-time snapshot"
  );
}

// ─── Section: Lobbying ────────────────────────────────────────────────────────

function lobbyingEmbed(lob) {
  if (lob.length === 0) return embed("🏛 1. Lobbying Activity", 0xe74c3c,
    "No lobbying records found where the client or subject matter references tracked entities.\n\n🔗 https://netfile.com/lobbyistpub/#sfo");

  const dates = lob.map(({ row }) => row.date).filter(Boolean).map((d) => d.slice(0, 10)).sort();

  // Group by client
  const byClient = new Map();
  for (const { row, link } of lob) {
    const client = row.clientname || "Unknown";
    const firm = row.firmname || "—";
    const lobbyist = row.lobbyistname || "—";
    const date = (row.date || "").slice(0, 10);
    if (!byClient.has(client)) byClient.set(client, { count: 0, firms: new Set(), lobbyists: new Set(), first: date, last: date, officials: new Set(), link });
    const e = byClient.get(client);
    e.count++;
    e.firms.add(firm);
    e.lobbyists.add(lobbyist);
    if (date < e.first) e.first = date;
    if (date > e.last) e.last = date;
    const off = row.employeename || row.candidatename;
    // Filter out obviously non-official values
    if (off && off.length > 3 && !off.includes("LLC") && !off.includes("INC") && !/^\d/.test(off)) {
      e.officials.add(off);
    }
  }

  const firms = [...new Set(lob.map(({ row }) => row.firmname).filter(Boolean))];
  const lobbyists = [...new Set(lob.map(({ row }) => row.lobbyistname).filter(Boolean))];

  let desc =
    `**${lob.length} filings** | ${dates[0]?.slice(0,7) || "—"} → ${dates[dates.length-1]?.slice(0,7) || "—"}\n` +
    `**Firms:** ${firms.join(", ")}\n` +
    `**Lobbyists:** ${lobbyists.join(", ")}\n\n` +
    `**By client:**\n`;

  for (const [client, { count, firms: f, first, last, officials, link }] of
    [...byClient.entries()].sort((a, b) => b[1].count - a[1].count)) {
    desc += `• ${b(client)}: ${count} filings (${first.slice(0,7)}→${last.slice(0,7)}) via ${[...f].join(", ")} [↗](${link})\n`;
    if (officials.size > 0) {
      desc += `  _Officials contacted: ${[...officials].slice(0,4).join(", ")}${officials.size > 4 ? ` +${officials.size-4} more` : ""}_\n`;
    }
  }

  desc += `\n🔗 Full filings: https://netfile.com/lobbyistpub/#sfo`;
  return embed("🏛 1. Lobbying Activity", 0xe74c3c, desc);
}

// ─── Section: Campaign Finance ────────────────────────────────────────────────

function financeEmbed(fin) {
  if (fin.length === 0) return embed("💰 2. Campaign Finance", 0x27ae60,
    "No campaign finance records found.\n\n🔗 https://sfethics.org/disclosures/campaign-finance-disclosure");

  const total = fin.reduce((s, { row }) => s + Number(row.transaction_amount_1 || 0), 0);
  const dates = fin.map(({ row }) => (row.transaction_date || row.filing_date || "")).filter(Boolean).map((d) => d.slice(0, 10)).sort();

  // By recipient
  const byRecipient = new Map();
  for (const { row, link } of fin) {
    const rec = row.filer_name || "Unknown";
    if (!byRecipient.has(rec)) byRecipient.set(rec, { total: 0, count: 0, link, contribs: [] });
    const amt = Number(row.transaction_amount_1 || 0);
    byRecipient.get(rec).total += amt;
    byRecipient.get(rec).count++;
    const name = [row.transaction_first_name, row.transaction_last_name].filter(Boolean).join(" ") || "Unknown";
    byRecipient.get(rec).contribs.push({ name, employer: row.transaction_employer || "", amount: amt,
      date: (row.transaction_date || row.filing_date || "").slice(0, 10) });
  }

  let desc =
    `**${fin.length} transactions** | **Total: $${total.toLocaleString()}**\n` +
    `${dates[0]?.slice(0,7) || "—"} → ${dates[dates.length-1]?.slice(0,7) || "—"}\n\n` +
    `**By recipient committee:**\n`;

  for (const [rec, { total: t, count, link, contribs }] of
    [...byRecipient.entries()].sort((a, b) => b[1].total - a[1].total)) {
    desc += `• ${b(rec)}: $${t.toLocaleString()} (${count}) [↗](${link})\n`;
    // Show top contributors to this committee
    const top = contribs.sort((a, b) => b.amount - a.amount).slice(0, 3);
    for (const { name, employer, amount, date } of top) {
      desc += `  _${name}${employer ? ` (${employer})` : ""}: $${amount.toLocaleString()} on ${date}_\n`;
    }
  }

  desc += `\n🔗 https://sfethics.org/disclosures/campaign-finance-disclosure`;
  return embed("💰 2. Campaign Finance", 0x27ae60, desc);
}

// ─── Section: Building Permits ────────────────────────────────────────────────

function permitsEmbed(per) {
  if (per.length === 0) return embed("🏗 3. Building Permits", 0xf39c12,
    "No permit matches found on the 2000–2299 Fillmore St block or in permit descriptions.\n\n" +
    "_Note: DBI dataset has no applicant/owner name fields — LLC names are not searchable here._\n\n" +
    "🔗 Search manually: https://sfdbi.org/dbipts");

  const dates = per.map(({ row }) => row.filed_date).filter(Boolean).map((d) => d.slice(0, 10)).sort();
  const statusCounts = new Map();
  for (const { row } of per) {
    const s = row.status || "unknown";
    statusCounts.set(s, (statusCounts.get(s) || 0) + 1);
  }

  // Sort by date descending
  const sorted = per.sort((a, b) => (b.row.filed_date || "").localeCompare(a.row.filed_date || ""));

  let desc =
    `**${per.length} permit(s)** on 2000–2299 Fillmore St block\n` +
    `${dates[0]?.slice(0,7) || "—"} → ${dates[dates.length-1]?.slice(0,7) || "—"}\n` +
    `**Status:** ${[...statusCounts.entries()].map(([s, n]) => `${s}: ${n}`).join(" | ")}\n\n` +
    `**Most recent permits:**\n`;

  for (const { row, link } of sorted.slice(0, 12)) {
    const addr = [row.street_number, row.street_name].filter(Boolean).join(" ");
    const date = (row.filed_date || "").slice(0, 10);
    const cost = row.estimated_cost ? ` $${Number(row.estimated_cost).toLocaleString()}` : "";
    const workDesc = (row.description || "—").slice(0, 70);
    desc += `• ${b(addr)} | ${row.status || "—"} | ${date}${cost} [↗](${link})\n  _${workDesc}_\n`;
  }
  if (per.length > 12) desc += `• …and ${per.length - 12} more\n`;
  desc += `\n🔗 https://sfdbi.org/dbipts`;

  return embed("🏗 3. Building Permits", 0xf39c12, desc);
}

// ─── Section: Entity Network ──────────────────────────────────────────────────

function networkEmbed(matches) {
  const counts = new Map(ALL_TERMS.map((t) => [t, 0]));
  const srcs = new Map(ALL_TERMS.map((t) => [t, new Set()]));
  const labels = { lobbyist_activity: "L", campaign_finance: "F", building_permits: "P" };

  const sourceMap = {
    lobbyist_activity: matches.lobbyist_activity,
    campaign_finance: matches.campaign_finance,
    building_permits: matches.building_permits,
  };

  for (const [srcId, records] of Object.entries(sourceMap)) {
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
    `**Record count (L=Lobbying F=Finance P=Permits):**\n` +
    ranked.map(([t, c]) => {
      const s = [...(srcs.get(t) || [])].map((x) => labels[x]).sort().join("");
      return `• ${b(t)}: ${c} [${s}]`;
    }).join("\n");

  if (inactive.length > 0) {
    desc += `\n\n**No records yet for:**\n${inactive.map(m).join(" ")}`;
  }

  return embed("🕸 4. Entity Network", 0x2980b9, desc);
}

// ─── Section: Reporter Briefing ───────────────────────────────────────────────

function briefingEmbed(matches, runDate) {
  const lob = matches.lobbyist_activity;
  const fin = matches.campaign_finance;
  const per = matches.building_permits;

  const lobDates = lob.map(({ row }) => row.date).filter(Boolean).map((d) => d.slice(0, 10)).sort();
  const firms = [...new Set(lob.map(({ row }) => row.firmname).filter(Boolean))];
  const lobbyists = [...new Set(lob.map(({ row }) => row.lobbyistname).filter(Boolean))];
  const clients = [...new Set(lob.map(({ row }) => row.clientname).filter(Boolean))];

  // Officials — filter noise
  const officials = [...new Set(
    lob.map(({ row }) => row.employeename || row.candidatename)
      .filter((o) => o && o.length > 3 && !o.includes("LLC") && !o.includes("INC") && !/^\d/.test(o))
  )];

  const totalMoney = fin.reduce((s, { row }) => s + Number(row.transaction_amount_1 || 0), 0);
  const recipients = [...new Set(fin.map(({ row }) => row.filer_name).filter(Boolean))];

  const lines = [];

  if (lob.length > 0) {
    lines.push(
      `**Lobbying:** ${firms.join(" and ")} (${lobbyists.join(", ")}) filed **${lob.length} lobbying disclosures** ` +
      `on behalf of ${clients.join(", ")} from ${lobDates[0]?.slice(0,7) || "—"} to ${lobDates[lobDates.length-1]?.slice(0,7) || "—"}. ` +
      (officials.length > 0
        ? `City officials contacted include **${officials.slice(0,5).join(", ")}**${officials.length > 5 ? ` and ${officials.length-5} others` : ""}.`
        : "No city official contact records in this dataset.")
    );
  } else {
    lines.push("**Lobbying:** No lobbying records found for tracked clients or subject matter.");
  }

  if (fin.length > 0) {
    lines.push(
      `**Political money:** **$${totalMoney.toLocaleString()}** across **${fin.length} transactions** ` +
      `flowing to: ${recipients.join(", ")}.`
    );
  } else {
    lines.push("**Political money:** No campaign finance records found for tracked entities.");
  }

  if (per.length > 0) {
    lines.push(`**Construction:** **${per.length} building permit(s)** filed on the 2000–2299 Fillmore St block.`);
  } else {
    lines.push("**Construction:** No permit matches on the 2000–2299 Fillmore St block.");
  }

  lines.push(
    `**Property records:** The SF Recorder has no public API. Search https://recorder.sfgov.org by name for: ` +
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
  console.log(`\n✅ Total targeted matches: ${total}`);

  const embeds = [
    coverEmbed(matches, runDate),
    lobbyingEmbed(matches.lobbyist_activity),
    financeEmbed(matches.campaign_finance),
    permitsEmbed(matches.building_permits),
    networkEmbed(matches),
    briefingEmbed(matches, runDate),
  ];

  console.log(`\n📨 Posting ${embeds.length} embeds…`);
  await postToDiscord(embeds);
  console.log("\nReport complete.");
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
