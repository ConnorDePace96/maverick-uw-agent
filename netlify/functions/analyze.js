const Anthropic = require("@anthropic-ai/sdk");

// Maverick UW Agent — analyze function
// Receives a merged loan PDF (base64) plus context, asks Claude to underwrite it,
// and returns a structured credit memo the front-end can render directly.

const MODEL = "claude-sonnet-4-20250514";

const VERDICTS = ["Approve", "Approve with Conditions", "Needs More Info", "Decline"];

function jsonResponse(statusCode, obj) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  };
}

function buildSystemPrompt({ investor, program, useInvestor, houseRules, nuances }) {
  let p = "";
  p += "You are Maverick's senior underwriting agent. You review a merged loan file ";
  p += "(1003, appraisal, title, insurance, bank statements) and produce a disciplined, ";
  p += "conservative credit memo for a " + (investor || "non-QM") + " " + (program || "DSCR") + " loan.\n\n";

  p += "Underwrite against three layers, in this priority order:\n";
  p += "1. HOUSE RULES (binding, override everything else where stricter).\n";
  p += "2. INVESTOR MATRIX (the program guidelines for the selected investor/program).\n";
  p += "3. LEARNED NUANCES (tagged one-liners from prior deals).\n\n";

  if (useInvestor) {
    p += "INVESTOR MATRIX GUIDANCE:\n";
    p += "Evaluate the file against the standard underwriting dimensions for this investor/program: ";
    p += "DSCR, LTV/CLTV, FICO, reserves, property type/condition, occupancy, prepayment, ";
    p += "income/asset documentation, title/insurance adequacy, and appraisal support. ";
    p += "Do NOT invent specific numeric thresholds you are not certain about; if a hard cutoff ";
    p += "is unknown, flag it as an item to confirm against the live matrix rather than fabricating a number.\n\n";
  } else {
    p += "INVESTOR MATRIX: disabled for this run. Do not apply investor-specific cutoffs.\n\n";
  }

  if (houseRules && String(houseRules).trim()) {
    p += "HOUSE RULES (binding — treat any pasted matrix as authoritative and verbatim):\n";
    p += String(houseRules).trim() + "\n\n";
  }

  if (nuances && String(nuances).trim()) {
    p += "LEARNED NUANCES (apply as soft guidance):\n";
    p += String(nuances).trim() + "\n\n";
  }

  p += "Return ONLY a single JSON object (no markdown, no prose outside JSON) with EXACTLY this shape:\n";
  p += "{\n";
  p += '  "verdict": one of ' + JSON.stringify(VERDICTS) + ",\n";
  p += '  "borrower": string,\n';
  p += '  "loanNumber": string,\n';
  p += '  "investor": string,\n';
  p += '  "program": string,\n';
  p += '  "summary": string (2-4 sentence executive summary),\n';
  p += '  "metrics": [ { "label": string, "value": string } ],\n';
  p += '  "categories": [ { "name": string, "status": "Pass"|"Caution"|"Fail"|"Unknown", "detail": string } ],\n';
  p += '  "houseFindings": [ { "rule": string, "status": "Pass"|"Caution"|"Fail"|"Unknown", "detail": string } ],\n';
  p += '  "conditions": [ string ],\n';
  p += '  "dealNotes": string\n';
  p += "}\n";
  p += "If the file is unreadable or missing critical sections, use verdict \"Needs More Info\" ";
  p += "and explain what is missing in summary + conditions. Never fabricate borrower data.";
  return p;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Method not allowed" });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return jsonResponse(500, {
      error: "Server is missing ANTHROPIC_API_KEY. Set it in Netlify site environment variables.",
    });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (e) {
    return jsonResponse(400, { error: "Invalid JSON body" });
  }

  const {
    pdf,
    investor = "",
    program = "",
    borrower = "",
    loanNumber = "",
    contextNotes = "",
    useInvestor = true,
    houseRules = "",
    nuances = "",
  } = payload;

  if (!pdf || typeof pdf !== "string") {
    return jsonResponse(400, { error: "No PDF provided. Drop a merged loan file and try again." });
  }

  // Strip a data URL prefix if present (e.g. "data:application/pdf;base64,")
  const base64 = pdf.includes(",") ? pdf.split(",").pop() : pdf;

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const userBlocks = [
    {
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: base64 },
    },
    {
      type: "text",
      text:
        "Underwrite this merged loan file.\n" +
        "Investor: " + (investor || "(unspecified)") + "\n" +
        "Program: " + (program || "(unspecified)") + "\n" +
        "Borrower / Entity hint: " + (borrower || "(none)") + "\n" +
        "Loan number hint: " + (loanNumber || "(none)") + "\n" +
        "Deal context: " + (contextNotes || "(none)") + "\n\n" +
        "Produce the JSON credit memo described in the system prompt.",
    },
  ];

  let raw = "";
  try {
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: buildSystemPrompt({ investor, program, useInvestor, houseRules, nuances }),
      messages: [{ role: "user", content: userBlocks }],
    });
    raw = (msg.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
  } catch (err) {
    return jsonResponse(502, {
      error: "Anthropic API call failed: " + (err && err.message ? err.message : String(err)),
    });
  }

  // Pull the JSON object out of the model response defensively.
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
    return jsonResponse(200, {
      verdict: "Needs More Info",
      borrower: borrower || "Unknown",
      loanNumber: loanNumber || "",
      investor: investor || "",
      program: program || "",
      summary: "The underwriting model returned a response that could not be parsed into a memo. Re-run the file; if it persists, the document may be too large or unreadable.",
      metrics: [],
      categories: [],
      houseFindings: [],
      conditions: ["Re-run the analysis with a clearer or smaller merged PDF."],
      dealNotes: raw.slice(0, 1500),
    });
  }

  // Normalize so the front-end render never crashes on missing fields.
  const safe = {
    verdict: VERDICTS.includes(memo.verdict) ? memo.verdict : (memo.verdict || "Needs More Info"),
    borrower: memo.borrower || borrower || "Unknown",
    loanNumber: memo.loanNumber || loanNumber || "",
    investor: memo.investor || investor || "",
    program: memo.program || program || "",
    summary: memo.summary || "",
    metrics: Array.isArray(memo.metrics) ? memo.metrics : [],
    categories: Array.isArray(memo.categories) ? memo.categories : [],
    houseFindings: Array.isArray(memo.houseFindings) ? memo.houseFindings : [],
    conditions: Array.isArray(memo.conditions) ? memo.conditions : [],
    dealNotes: memo.dealNotes || "",
  };

  return jsonResponse(200, safe);
};
