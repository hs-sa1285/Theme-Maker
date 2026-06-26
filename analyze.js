// Throughline — serverless analysis endpoint for Vercel.
//
// This file lives at /api/analyze.js. Vercel turns anything in the /api folder
// into a live endpoint, so the browser can call it at  https://yoursite/api/analyze
//
// The API KEY NEVER GOES IN THIS FILE. It is read from an environment variable
// you set in the Vercel dashboard (Settings -> Environment Variables). See README.
//
// Default provider is OpenRouter (free Qwen). To switch to Claude later, set
// LLM_PROVIDER=anthropic and add ANTHROPIC_KEY. The front end never changes.

// ---- config from environment ----
const PROVIDER       = (process.env.LLM_PROVIDER || "openrouter").toLowerCase();
const OPENROUTER_KEY = process.env.OPENROUTER_KEY || process.env.OPENROUTER_API_KEY || "";
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "qwen/qwen3.6-plus:free";
const ANTHROPIC_KEY  = process.env.ANTHROPIC_KEY || process.env.ANTHROPIC_API_KEY || "";
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
const SITE_TITLE     = process.env.SITE_TITLE || "Throughline";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || ""; // optional, e.g. https://throughline.yourdomain.com

// ---- best-effort per-IP rate limit (per warm instance only) ----
// Serverless instances are short-lived and there can be many, so this is a soft
// guard, not a real limit. For a hard cap, use Vercel KV / Upstash (see README).
const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 12;
const bucket = global.__tl_bucket || (global.__tl_bucket = {});
function rateLimited(ip) {
  const now = Date.now();
  let b = bucket[ip];
  if (!b || now - b.start > WINDOW_MS) b = { count: 0, start: now };
  b.count += 1;
  bucket[ip] = b;
  return b.count > MAX_PER_WINDOW;
}

function clientIp(req) {
  const xf = req.headers["x-forwarded-for"];
  if (xf) return String(xf).split(",")[0].trim();
  return req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "unknown";
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch (e) { return {}; } }
  return await new Promise(function (resolve) {
    let data = "";
    req.on("data", function (c) { data += c; });
    req.on("end", function () { try { resolve(JSON.parse(data || "{}")); } catch (e) { resolve({}); } });
    req.on("error", function () { resolve({}); });
  });
}

// ---- provider calls. Both return the model's raw text (the front end parses the JSON). ----
async function callOpenRouter(system, user, referer) {
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + OPENROUTER_KEY,
      "Content-Type": "application/json",
      "HTTP-Referer": referer || "",
      "X-Title": SITE_TITLE
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ],
      // warm enough that the model reasons and invents its own ideas, not just fills a template
      temperature: 0.7,
      max_tokens: 1600
    })
  });
  if (!r.ok) {
    const detail = await r.text().catch(function () { return ""; });
    const err = new Error("openrouter " + r.status);
    err.status = r.status; err.detail = detail;
    throw err;
  }
  const data = await r.json();
  const txt = data && data.choices && data.choices[0] && data.choices[0].message
    ? (data.choices[0].message.content || "") : "";
  return txt;
}

async function callAnthropic(system, user) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 1600,
      temperature: 0.7,
      system: system,
      messages: [{ role: "user", content: user }]
    })
  });
  if (!r.ok) {
    const detail = await r.text().catch(function () { return ""; });
    const err = new Error("anthropic " + r.status);
    err.status = r.status; err.detail = detail;
    throw err;
  }
  const data = await r.json();
  const txt = Array.isArray(data.content)
    ? data.content.map(function (b) { return b && b.type === "text" ? b.text : ""; }).join("\n")
    : "";
  return txt;
}

module.exports = async function (req, res) {
  // 1. method guard
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    return res.end(JSON.stringify({ error: "method not allowed" }));
  }

  // 2. optional origin check (only blocks when an origin is present and clearly foreign)
  const origin = req.headers.origin || "";
  if (origin) {
    let foreign = false;
    if (ALLOWED_ORIGIN) {
      foreign = origin.replace(/\/$/, "") !== ALLOWED_ORIGIN.replace(/\/$/, "");
    } else if (req.headers.host) {
      try { foreign = new URL(origin).host !== req.headers.host; } catch (e) { foreign = false; }
    }
    if (foreign) {
      res.statusCode = 403;
      return res.end(JSON.stringify({ error: "forbidden origin" }));
    }
  }

  // 3. soft rate limit
  if (rateLimited(clientIp(req))) {
    res.statusCode = 429;
    return res.end(JSON.stringify({ error: "rate limited, slow down" }));
  }

  // 4. read prompt
  const body = await readBody(req);
  const system = typeof body.system === "string" ? body.system : "";
  const user = typeof body.user === "string" ? body.user : "";
  if (!system || !user) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: "missing system or user" }));
  }

  // 5. provider dispatch. On any failure we return 502 so the page falls back to its built-in engine.
  try {
    let text;
    if (PROVIDER === "anthropic") {
      if (!ANTHROPIC_KEY) throw new Error("ANTHROPIC_KEY not set");
      text = await callAnthropic(system, user);
    } else {
      if (!OPENROUTER_KEY) throw new Error("OPENROUTER_KEY not set");
      const referer = origin || (req.headers.host ? "https://" + req.headers.host : "");
      text = await callOpenRouter(system, user, referer);
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    // The front end accepts { content: "<model text>" } and extracts the JSON itself.
    return res.end(JSON.stringify({ content: text }));
  } catch (e) {
    res.statusCode = (e && e.status) ? e.status : 502;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ error: String(e && e.message || "upstream error") }));
  }
};
