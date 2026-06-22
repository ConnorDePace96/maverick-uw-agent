const { getStore } = require("@netlify/blobs");

// Maverick UW Agent — memory function
// GET  /api/memory      -> returns { houseRules, nuances } from the cloud store
// POST /api/memory      -> persists { houseRules, nuances } to the cloud store
// Falls back gracefully so the front-end can run "local only" if Blobs is unavailable.

const STORE_NAME = "maverick-uw";
const KEY = "memory";

function jsonResponse(statusCode, obj) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  };
}

function getMemoryStore() {
  // In Netlify production, getStore works with no extra config. When env vars
  // are present (manual setups), pass them through so it still binds.
  const opts = { name: STORE_NAME };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    opts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  return getStore(opts);
}

exports.handler = async (event) => {
  if (event.httpMethod === "GET") {
    try {
      const store = getMemoryStore();
      const data = await store.get(KEY, { type: "json" });
      const safe = data && typeof data === "object" ? data : {};
      return jsonResponse(200, {
        houseRules: typeof safe.houseRules === "string" ? safe.houseRules : "",
        nuances: typeof safe.nuances === "string" ? safe.nuances : "",
      });
    } catch (err) {
      // Cloud store not reachable — return empty so the app falls back to local.
      return jsonResponse(200, { houseRules: "", nuances: "" });
    }
  }

  if (event.httpMethod === "POST") {
    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch (e) {
      return jsonResponse(400, { error: "Invalid JSON body" });
    }
    const record = {
      houseRules: typeof body.houseRules === "string" ? body.houseRules : "",
      nuances: typeof body.nuances === "string" ? body.nuances : "",
    };
    try {
      const store = getMemoryStore();
      await store.setJSON(KEY, record);
      return jsonResponse(200, { ok: true, saved: true });
    } catch (err) {
      return jsonResponse(200, {
        ok: false,
        saved: false,
        error: "Cloud store unavailable; changes are saved locally only.",
      });
    }
  }

  return jsonResponse(405, { error: "Method not allowed" });
};
