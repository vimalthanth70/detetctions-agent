/**
 * Learn from user feedback — update detections-context-agent.md with
 * generalizable rules the discovery agent should follow on future runs.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const CONTEXT_DOC_PATH = resolve(__dirname, "..", "detections-context-agent.md");

const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_BASE_URL = "https://api.anthropic.com";

function parseMarkdownFromResponse(text) {
  if (!text) return null;
  const fenced = [...text.matchAll(/```(?:markdown|md)?\s*([\s\S]*?)```/g)];
  if (fenced.length) return fenced[fenced.length - 1][1].trim();
  const trimmed = text.trim();
  if (trimmed.startsWith("#")) return trimmed;
  return null;
}

function validateDoc(nextDoc, previousDoc) {
  if (!nextDoc || nextDoc.length < 400) return "updated doc too short";
  if (!/product-form-selector/.test(nextDoc)) return "missing selector key documentation";
  if (!/Hard rules|## Keys/.test(nextDoc)) return "missing core sections";
  if (previousDoc && nextDoc.length < previousDoc.length * 0.45) {
    return "updated doc looks truncated — refusing to write";
  }
  return null;
}

async function callClaudeLearn({ apiKey, model, baseUrl, system, userMessage, emit }) {
  const url = `${baseUrl.replace(/\/$/, "")}/v1/messages`;
  emit?.({
    type: "llm-request",
    model,
    url,
    purpose: "learn",
    userBytes: (system?.length || 0) + (userMessage?.length || 0),
  });
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 8192,
      system,
      messages: [{ role: "user", content: userMessage }],
    }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const message = json?.error?.message || `Anthropic API error (HTTP ${res.status})`;
    throw new Error(message);
  }
  const text = (json.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  emit?.({
    type: "llm-response",
    purpose: "learn",
    inputTokens: json.usage?.input_tokens,
    outputTokens: json.usage?.output_tokens,
    bytes: text.length,
  });
  return text;
}

/**
 * @returns {{ updated: boolean, summary?: string }}
 */
export async function learnFromFeedback({
  feedback,
  storeUrl = "",
  previousSelectors = null,
  apiKey,
  model = DEFAULT_MODEL,
  baseUrl = DEFAULT_BASE_URL,
  emit = () => {},
} = {}) {
  const note = String(feedback || "").trim();
  if (!note) return { updated: false };

  const currentDoc = readFileSync(CONTEXT_DOC_PATH, "utf8");

  const system = [
    "You maintain detections-context-agent.md — the rule book for a Shopify selector discovery agent.",
    "Given user feedback from a run, update the markdown with GENERALIZABLE rules future runs should follow.",
    "Do NOT add store-specific myshopify URLs or one-off selector strings as permanent rules unless they illustrate a theme pattern (e.g. mini-cart, Focal, Pureness).",
    "Integrate feedback into the existing sections (Keys 1–8, Hard rules, Drawer detection) — refine wording, add bullet points, or short sub-notes.",
    "Keep the same overall structure and all eight key definitions. Do not delete valid existing rules.",
    "Return the COMPLETE updated file wrapped in a single ```markdown fence.",
  ].join("\n");

  const userParts = [
    `Store context: ${storeUrl || "(unspecified)"}`,
    "",
    "=== USER FEEDBACK ===",
    note,
  ];
  if (previousSelectors && typeof previousSelectors === "object") {
    userParts.push("", "=== PREVIOUS SELECTORS (what was wrong) ===", JSON.stringify(previousSelectors, null, 2));
  }
  userParts.push("", "=== CURRENT detections-context-agent.md ===", currentDoc);

  emit({ type: "log", level: "info", message: "Asking Claude to update detections-context-agent.md from feedback..." });

  const text = await callClaudeLearn({
    apiKey,
    model,
    baseUrl,
    system,
    userMessage: userParts.join("\n"),
    emit,
  });

  const nextDoc = parseMarkdownFromResponse(text);
  if (!nextDoc) {
    throw new Error("Could not parse updated markdown from learn response.");
  }

  const invalid = validateDoc(nextDoc, currentDoc);
  if (invalid) {
    throw new Error(`Refusing to write context doc: ${invalid}`);
  }

  writeFileSync(CONTEXT_DOC_PATH, nextDoc.endsWith("\n") ? nextDoc : `${nextDoc}\n`, "utf8");

  const summary = text.split("\n").find((l) => l.trim() && !l.startsWith("```"))?.slice(0, 200);
  emit({
    type: "context-updated",
    path: "detections-context-agent.md",
    bytes: nextDoc.length,
    summary: summary || "Rules doc updated",
  });
  emit({ type: "log", level: "info", message: `Updated detections-context-agent.md (${nextDoc.length} bytes)` });

  return { updated: true, summary };
}
