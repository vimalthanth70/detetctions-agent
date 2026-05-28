/**
 * Verifier agent — DOM-checks selectors from the discover agent and asks Claude
 * to fix failed keys one at a time until all mandatory selectors pass verify.
 */

import {
  SELECTOR_KEYS,
  mandatoryKeys,
  emptyAllowed,
  verify,
  parseLlmJson,
  callClaude,
  buildSystemPrompt,
  buildFocusHtml,
  buildKeyFocusHtml,
  buildDomProbeHints,
} from "./agent-llm.mjs";

const MAX_PER_KEY_ATTEMPTS = 5;
const VERIFIER_RETRY_DELAY_MS = 12_000;
const VERIFIER_INTER_KEY_DELAY_MS = 3_000;

const KEY_SURFACES = {
  "product-form-selector": "PDP product + form",
  "home-page-cvb": "HOME hero",
  "product-page-cvb": "PDP product + form",
  "cart-drawer-cvb": "CART DRAWER",
  "cart-page-discount-code": "/cart items + totals",
  "cart-page-cvb": "/cart items + totals",
  "cart-icon": "HEADER",
  "cart-drawer-discount-code": "CART DRAWER",
};

function buildKeyFixPrompt(crawl, key, { lastRaw = "", lastReason = "", verified = {} } = {}) {
  const host = new URL(crawl.base).host;
  const hints = buildDomProbeHints(crawl);
  const locked = Object.fromEntries(
    Object.entries(verified).filter(([, v]) => v),
  );

  const lines = [
    "You are the verifier agent. The discover agent produced a selector that FAILED live DOM verification.",
    "Return a corrected theme-native CSS selector for ONE key only.",
    "",
    `Store: ${host}`,
    `Key to fix: ${key}`,
    `Surface focus: ${KEY_SURFACES[key] || key}`,
    `Has cart drawer: ${crawl.hasDrawer ? "YES" : "NO"}`,
  ];

  if (lastRaw) {
    lines.push("", "=== FAILED SELECTOR ===", `"${lastRaw}"`, `Reason: ${lastReason || "verify failed"}`);
  } else {
    lines.push("", "=== FAILED SELECTOR ===", "(empty or missing — pick a valid selector)");
  }

  if (Object.keys(locked).length) {
    lines.push("", "=== ALREADY VERIFIED (do not change) ===", JSON.stringify(locked, null, 2));
  }

  if (hints) lines.push("", "=== DOM HINTS ===", hints);

  lines.push(
    "",
    "=== HTML EXCERPTS ===",
    buildKeyFocusHtml(crawl, key),
    "",
    `Return ONLY a \`\`\`json block with this single key:`,
    `{ "${key}": "<css selector>" }`,
    "Use double quotes inside CSS attribute values. Must pass querySelectorAll count rules from detections-context-agent.md.",
  );

  return lines.join("\n");
}

function extractKeyFromParsed(parsed, key) {
  if (!parsed || typeof parsed !== "object") return "";
  const raw = parsed[key];
  return typeof raw === "string" ? raw.trim() : "";
}

/**
 * @returns {{ selectors: Record<string,string>, details: Record<string,object>, allPassed: boolean }}
 */
export async function runVerifierAgent(
  crawl,
  { initialSelectors = {}, initialDetails = {}, apiKey, model, baseUrl, emit = () => {} },
) {
  const selectors = { ...initialSelectors };
  const details = { ...initialDetails };

  const required = mandatoryKeys(crawl.hasDrawer);
  let missing = required.filter((k) => !selectors[k]);

  emit({
    type: "step",
    id: "verifier",
    status: missing.length ? "running" : "done",
    message: missing.length
      ? `Verifier: ${missing.length} key(s) need fixes — ${missing.join(", ")}`
      : "All selectors already verified",
  });

  if (!missing.length) {
    return { selectors, details, allPassed: true };
  }

  const system = buildSystemPrompt();
  let round = 0;

  while (missing.length > 0) {
    round++;
    emit({
      type: "log",
      level: "info",
      message: `Verifier round ${round}: fixing ${missing.join(", ")}`,
    });

    let fixedAny = false;
    let keyIndex = 0;

    for (const key of [...missing]) {
      if (keyIndex++ > 0) {
        await new Promise((r) => setTimeout(r, VERIFIER_INTER_KEY_DELAY_MS));
      }
      if (emptyAllowed(key, crawl.hasDrawer) && !crawl.hasDrawer) {
        selectors[key] = "";
        details[key] = { llmRaw: "", verify: { ok: true, note: "no drawer" } };
        emit?.({ type: "selector", key, value: "", llmRaw: "", verify: details[key].verify });
        fixedAny = true;
        continue;
      }

      const prior = details[key] || {};
      let lastRaw = prior.llmRaw || "";
      let lastReason = prior.verify?.reason || "missing or failed";

      for (let attempt = 1; attempt <= MAX_PER_KEY_ATTEMPTS; attempt++) {
        emit({
          type: "step",
          id: "verifier",
          status: "running",
          message: `Fixing ${key} (attempt ${attempt}/${MAX_PER_KEY_ATTEMPTS})...`,
        });

        const userMessage = buildKeyFixPrompt(crawl, key, {
          lastRaw,
          lastReason,
          verified: selectors,
        });

        emit({
          type: "log",
          level: "info",
          message: `Verifier → Claude: ${key} attempt ${attempt}`,
        });

        let llm;
        try {
          llm = await callClaude({
            apiKey,
            model,
            baseUrl,
            system,
            messages: [{ role: "user", content: userMessage }],
            emit: (e) => emit({ ...e, purpose: "verifier" }),
          });
        } catch (e) {
          emit({ type: "log", level: "error", message: `Verifier LLM error for ${key}: ${e.message}` });
          break;
        }

        const parsed = parseLlmJson(llm.text);
        const raw = extractKeyFromParsed(parsed, key);
        const v = verify(raw, key, crawl);
        details[key] = { llmRaw: raw, verify: v };

        if (v.ok && raw !== "") {
          selectors[key] = raw;
          fixedAny = true;
          emit({ type: "log", level: "info", message: `  ✓ ${key}: ${raw}` });
          emit({ type: "selector", key, value: raw, llmRaw: raw, verify: v });
          break;
        }

        lastRaw = raw;
        lastReason = v.reason || "verify failed";
        emit({
          type: "log",
          level: "warn",
          message: `  ✗ ${key}: "${raw || "(empty)"}" — ${lastReason}`,
        });
        emit({ type: "selector", key, value: "", llmRaw: raw, verify: v });

        if (attempt < MAX_PER_KEY_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, VERIFIER_RETRY_DELAY_MS));
        }
      }
    }

    missing = required.filter((k) => !selectors[k]);

    emit({
      type: "step",
      id: "verifier",
      status: missing.length ? "running" : "done",
      message: missing.length
        ? `${missing.length} key(s) still failing: ${missing.join(", ")}`
        : "All selectors verified",
    });

    if (!missing.length) break;
    if (!fixedAny) {
      emit({
        type: "log",
        level: "warn",
        message: "Verifier made no progress this round — stopping",
      });
      break;
    }
  }

  const allPassed = mandatoryKeys(crawl.hasDrawer).every((k) => {
    if (emptyAllowed(k, crawl.hasDrawer)) return selectors[k] === "";
    return !!selectors[k];
  });

  return {
    selectors,
    details,
    allPassed,
  };
}
