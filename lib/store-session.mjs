export function applySetCookies(jar, res) {
  const lines =
    typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : res.headers.get("set-cookie")
        ? [res.headers.get("set-cookie")]
        : [];
  for (const line of lines) {
    const part = String(line).split(";")[0].trim();
    const eq = part.indexOf("=");
    if (eq > 0) jar.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
}

export function isPasswordProtected(html) {
  const lower = html.toLowerCase();
  return (
    lower.includes("password protected") ||
    lower.includes("enter store password") ||
    /<form[^>]+action=["']\/password["']/i.test(html)
  );
}

function extractToken(html) {
  const m = html.match(/name="authenticity_token"\s+value="([^"]+)"/);
  return m ? m[1] : null;
}

function extractPasswordError(html) {
  const m = html.match(/class="error-message"[^>]*>([^<]+)/i);
  return m ? m[1].trim() : null;
}

/** Shopify password POST must use redirect: manual so session cookies apply before following. */
export async function loginStore(base, password, fetchWithCookies) {
  const passwordUrl = new URL("/password", base).href;
  const gate = await fetchWithCookies(passwordUrl);
  const token = extractToken(gate.html);
  if (!token) throw new Error("Could not read password form on storefront.");

  const result = await fetchWithCookies(passwordUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: passwordUrl,
      Origin: new URL(base).origin,
    },
    body: new URLSearchParams({ authenticity_token: token, password }).toString(),
    redirect: "manual",
  });

  if (extractPasswordError(result.html)) {
    const err = new Error("Password incorrect. Please check the store password.");
    err.statusCode = 401;
    throw err;
  }

  let home;
  if (result.status >= 300 && result.status < 400 && result.location) {
    home = await fetchWithCookies(new URL(result.location, base).href);
  } else if (!isPasswordProtected(result.html)) {
    home = result;
  } else {
    home = await fetchWithCookies(base);
  }

  if (isPasswordProtected(home.html)) {
    const err = new Error("Store is still password protected after login.");
    err.statusCode = 401;
    throw err;
  }

  return home;
}

export async function openStoreHome(base, password, fetchWithCookies) {
  if (password) {
    return loginStore(base, password, fetchWithCookies);
  }

  const home = await fetchWithCookies(base);
  if (isPasswordProtected(home.html)) {
    const err = new Error("Store is password protected. Password is required.");
    err.statusCode = 400;
    throw err;
  }

  return home;
}
