const Anthropic = require("@anthropic-ai/sdk");
const { getStore } = require("@netlify/blobs");

// Maverick UW Agent — analyze-background (Netlify Background Function)
// The "-background" suffix gives this a 15-minute execution limit, so it can
// read a full loan PDF and write a complete credit memo without timing out.
// It writes its result into the "maverick-uw" Blobs store under "job:<id>",
// which the front-end polls via /api/analyze-status.

const MODEL = "claude-sonnet-4-20250514";
const STORE_NAME = "maverick-uw";
const VERDICTS = ["Approve", "Approve with Conditions", "Needs More Info", "Decline"];

function getJobStore() {
  const opts = { name: STORE_NAME };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    opts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  return getStore(opts);
}

function buildSystemPrompt({ investor, program, useInvestor, houseRules, nuances }) {
  let p = "";
  p += "You are Maverick's senior underwriting agent. You review a merged loan file ";
  p += "(1003, appraisal, title, insurance, bank statements) and produce a disciplined, ";
  p += "conservative credit memo for a " + (investor || "non-QM") + " " + (program || "DSCR") + " loan.\n\n";
  p += "Underwrite against three layers, in priority order:\n";
  p += "1. HOUSE RULES (binding, override everything else where stricter).\n";
  p += "2. INVESTOR MATRIX (program guidelines for the selected investor/program).\n";
  p += "3. LEARNED NUANCES (tagged one-liners from prior deals).\n\n";
  if (useInvestor) {
    p += "INVESTOR MATRIX GUIDANCE: Evaluate DSCR, LTV/CLTV, FICO, reserves, property type/condition, ";
    p += "occupancy, prepayment, income/asset documentation, title/insurance adequacy, and appraisal support. ";
    p += "Do NOT invent specific numeric thresholds you are unsure of; flag unknown cutoffs to confirm against the live matrix.\n\n";
  } else {
    p += "INVESTOR MATRIX: disabled for this run.\n\n";
  }
  if (houseRules && String(houseRules).trim()) {
    p += "HOUSE RULES (binding — treat any pasted matrix as authoritative and verbatim):\n" + String(houseRules).trim() + "\n\n";
  }
  if (nuances && String(nuances).trim()) {
    p += "LEARNED NUANCES (soft guidance):\n" + String(nuances).trim() + "\n\n";
  }
  p += "Return ONLY a single JSON object (no markdown) with EXACTLY this shape:\n";
  p += "{ \"verdict\": one of " + JSON.stringify(VERDICTS) + ", \"borrower\": string, \"loanNumber\": string, ";
  p += "\"investor\": string, \"program\": string, \"summary\": string, ";
  p += "\"metrics\": [ { \"label\": string, \"value\": string } ], ";
  p += "\"categories\": [ { \"name\": string, \"status\": \"Pass\"|\"Caution\"|\"Fail\"|\"Unknown\", \"detail\": string } ], ";
  p += "\"houseFindings\": [ { \"rule\": string, \"status\": \"Pass\"|\"Caution\"|\"Fail\"|\"Unknown\", \"detail\": string } ], ";
  p += "\"conditions\": [ string ], \"dealNotes\": string }\n";
  p += "If the file is unreadable or missing critical sections, use verdict \"Needs More Info\". Never fabricate borrower data.";
  return p;
}

function parseMemo(raw, payload) {
  let memo;
  try {
    let jsonText = raw;
    const fence = raw.match(/\u0060\u0060\u0060(?:json)?\s*([\s\S]*?)\u0060\u0060\u0060/);
    if (fence) jsonText = fence[1];
    const first = jsonText.indexOf("{");
    const last = jsonText.lastIndexOf("}");
    if (first !== -1 && last !== -1) jsonText = jsonText.slice(first, last + 1);
    memo = JSON.parse(jsonText);
  } catch (e) {
    return {
      verdict: "Needs More Info",
      borrower: payload.borrower || "Unknown",
      loanNumber: payload.loanNumber || "",
      investor: payload.investor || "",
      program: payload.program || "",
      summary: "The underwriting model returned a response that could not be parsed into a memo. Re-run the file.",
      metrics: [], categories: [], houseFindings: [],
      conditions: ["Re-run the analysis with a clearer or smaller merged PDF."],
      dealNotes: raw.slice(0, 1500),
    };
  }
  return {
    verdict: VERDICTS.includes(memo.verdict) ? memo.verdict : (memo.verdict || "Needs More Info"),
    borrower: memo.borrower || payload.borrower || "Unknown",
    loanNumber: memo.loanNumber || payload.loanNumber || "",
    investor: memo.investor || payload.investor || "",
    program: memo.program || payload.program || "",
    summary: memo.summary || "",
    metrics: Array.isArray(memo.metrics) ? memo.metrics : [],
    categories: Array.isArray(memo.categories) ? memo.categories : [],
    houseFindings: Array.isArray(memo.houseFindings) ? memo.houseFindings : [],
    conditions: Array.isArray(memo.conditions) ? memo.conditions : [],
    dealNotes: memo.dealNotes || "",
  };
}

exports.handler = async (event) => {
  // Background functions get the same POST body; they cannot return data to the
  // caller, so all results/errors are written to the Blobs store under job:<id>.
  let payload = {};
  try { payload = JSON.parse(event.body || "{}"); } catch (e) {}
  const jobId = payload.jobId;
  if (!jobId) return { statusCode: 202 };

  const store = getJobStore();

  async function write(record) {
    try { await store.setJSON("job:" + jobId, record); } catch (e) {}
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    await write({ status: "error", error: "Server is missing ANTHROPIC_API_KEY." });
    return { statusCode: 202 };
  }

  const pdf = payload.pdf;
  if (!pdf || typeof pdf !== "string") {
    await write({ status: "error", error: "No PDF provided." });
    return { statusCode: 202 };
  }
  const base64 = pdf.includes(",") ? pdf.split(",").pop() : pdf;

  await write({ status: "processing" });

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const userBlocks = [
    { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } },
    { type: "text", text:
        "Underwrite this merged loan file.\n" +
        "Investor: " + (payload.investor || "(unspecified)") + "\n" +
        "Program: " + (payload.program || "(unspecified)") + "\n" +
        "Borrower / Entity hint: " + (payload.borrower || "(none)") + "\n" +
        "Loan number hint: " + (payload.loanNumber || "(none)") + "\n" +
        "Deal context: " + (payload.contextNotes || "(none)") + "\n\n" +
        "Produce the JSON credit memo described in the system prompt." },
  ];

  try {
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: buildSystemPrompt({
        investor: payload.investor || "",
        program: payload.program || "",
        useInvestor: payload.useInvestor !== false,
        houseRules: payload.houseRules || "",
        nuances: payload.nuances || "",
      }),
      messages: [{ role: "user", content: userBlocks }],
    });
    const raw = (msg.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    const memo = parseMemo(raw, payload);
    await write({ status: "done", memo: memo });
  } catch (err) {
    await write({ status: "error", error: "Anthropic API call failed: " + (err && err.message ? err.message : String(err)) });
  }

  return { statusCode: 202 };
};
