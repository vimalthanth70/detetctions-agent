/**
 * Detections-agent HTTP server.
 *
 *   node scripts/server.mjs           # listens on 0.0.0.0:3000
 *   PORT=4000 node scripts/server.mjs
 *
 * Routes
 *   GET  /              -> public/index.html
 *   GET  /public/*      -> static assets
 *   POST /api/discover  -> NDJSON stream of progress events
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { extname, join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runLlmAgent } from "../lib/agent-llm.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = join(ROOT, "public");
const PORT = Number(process.env.PORT || 3002);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "Cache-Control": "no-store", ...headers });
  res.end(body);
}

async function readJsonBody(req, max = 1024 * 256) {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > max) {
        reject(new Error("Body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolveBody(text ? JSON.parse(text) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function safeJoin(base, relative) {
  const target = resolve(base, "." + relative);
  if (!target.startsWith(base)) return null;
  return target;
}

async function serveStatic(req, res, urlPath) {
  let filePath;
  if (urlPath === "/" || urlPath === "") {
    filePath = join(PUBLIC_DIR, "index.html");
  } else {
    filePath = safeJoin(PUBLIC_DIR, urlPath);
  }
  if (!filePath || !existsSync(filePath) || !statSync(filePath).isFile()) {
    return send(res, 404, "Not found", {
      "Content-Type": "text/plain; charset=utf-8",
    });
  }
  const ext = extname(filePath).toLowerCase();
  const data = await readFile(filePath);
  send(res, 200, data, {
    "Content-Type": MIME[ext] || "application/octet-stream",
  });
}

function writeNdjson(res, payload) {
  res.write(JSON.stringify(payload) + "\n");
}

async function handleDiscover(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    return send(res, 400, JSON.stringify({ error: "Invalid JSON body" }), {
      "Content-Type": "application/json",
    });
  }
  const storeUrl = String(body?.storeUrl || "").trim();
  const password = String(body?.password || "").trim();
  const apiKey = String(body?.apiKey || "").trim();
  const model = String(body?.model || "").trim();
  const feedback = String(body?.feedback || body?.agentMessage || body?.message || "").trim();
  const previousSelectors =
    body?.previousSelectors && typeof body.previousSelectors === "object"
      ? body.previousSelectors
      : null;
  const learnFromFeedbackFlag = body?.learnFromFeedback !== false;

  if (!storeUrl) {
    return send(res, 400, JSON.stringify({ error: "storeUrl is required" }), {
      "Content-Type": "application/json",
    });
  }

  const effectiveKey = apiKey || process.env.ANTHROPIC_API_KEY || "";
  if (!effectiveKey) {
    return send(
      res,
      400,
      JSON.stringify({
        error:
          "Anthropic API key required. Provide `apiKey` in the request body or set ANTHROPIC_API_KEY.",
      }),
      { "Content-Type": "application/json" },
    );
  }

  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
    "Transfer-Encoding": "chunked",
    Connection: "keep-alive",
  });

  const emit = (event) => {
    if (res.writableEnded) return;
    writeNdjson(res, { ...event, ts: Date.now() });
  };

  emit({
    type: "agent-start",
    engine: "llm",
    storeUrl,
    hasPassword: !!password,
    hasFeedback: !!feedback,
    hasPreviousSelectors: !!previousSelectors,
    willLearn: !!feedback && learnFromFeedbackFlag,
    model: model || process.env.ANTHROPIC_MODEL || "claude-opus-4-6",
  });

  try {
    await runLlmAgent(storeUrl, password, emit, {
      apiKey: effectiveKey,
      model: model || undefined,
      feedback: feedback || undefined,
      previousSelectors,
      learnFromFeedback: learnFromFeedbackFlag,
    });
    emit({ type: "agent-done", engine: "llm" });
  } catch (e) {
    emit({
      type: "agent-error",
      engine: "llm",
      message: e?.message || String(e),
      statusCode: e?.statusCode || 500,
    });
  } finally {
    res.end();
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  const path = url.pathname;

  // CORS: allow same-origin browsers; permissive for local dev
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return send(res, 204, "");

  if (req.method === "POST" && path === "/api/discover") {
    return handleDiscover(req, res);
  }

  if (req.method === "GET") {
    if (path.startsWith("/public/")) {
      return serveStatic(req, res, path.slice("/public".length));
    }
    return serveStatic(req, res, path);
  }

  send(res, 405, "Method not allowed", { "Content-Type": "text/plain" });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`detections-agent server listening on http://localhost:${PORT}`);
});
