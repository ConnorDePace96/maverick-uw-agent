// Maverick UW Agent — analyze (dispatcher)
// This lightweight, synchronous function CANNOT do the long Claude call itself
// (Netlify's standard functions time out at ~10s, and underwriting a full loan
// PDF takes far longer). Instead it queues the work onto the background function
// analyze-background (15-minute limit) and immediately returns a jobId. The
// front-end then polls /api/analyze-status?id=<jobId> for the finished memo.

function jsonResponse(statusCode, obj) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  };
}

function makeJobId() {
  return (
    Date.now().toString(36) +
    "-" +
    Math.random().toString(36).slice(2, 10)
  );
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
  if (!payload.pdf || typeof payload.pdf !== "string") {
    return jsonResponse(400, { error: "No PDF provided. Drop a merged loan file and try again." });
  }

  const jobId = makeJobId();
  payload.jobId = jobId;

  const proto = (event.headers && (event.headers["x-forwarded-proto"] || event.headers["X-Forwarded-Proto"])) || "https";
  const host = (event.headers && (event.headers.host || event.headers.Host)) || "";
  const bgUrl = proto + "://" + host + "/.netlify/functions/analyze-background";

  try {
    await fetch(bgUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return jsonResponse(202, { jobId: jobId, note: "Job queued (trigger response unavailable)." });
  }

  return jsonResponse(202, { jobId: jobId });
};
