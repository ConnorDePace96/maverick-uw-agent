const { getStore } = require("@netlify/blobs");

// Maverick UW Agent — analyze-status
// GET /api/analyze-status?id=<jobId>
// Reads the job record the background function wrote into the Blobs store and
// reports it to the polling front-end: { status: "processing" | "done" | "error", memo?, error? }

const STORE_NAME = "maverick-uw";

function jsonResponse(statusCode, obj) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  };
}

function getJobStore() {
  const opts = { name: STORE_NAME };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    opts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  return getStore(opts);
}

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return jsonResponse(405, { status: "error", error: "Method not allowed" });
  }
  const id = (event.queryStringParameters && event.queryStringParameters.id) || "";
  if (!id) {
    return jsonResponse(400, { status: "error", error: "Missing job id" });
  }
  try {
    const store = getJobStore();
    const record = await store.get("job:" + id, { type: "json" });
    if (!record || typeof record !== "object") {
      // Not written yet — treat as still queued/processing so the page keeps polling.
      return jsonResponse(200, { status: "processing" });
    }
    return jsonResponse(200, record);
  } catch (err) {
    return jsonResponse(200, { status: "processing" });
  }
};
