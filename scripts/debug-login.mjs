const base = process.argv[2] || "https://vimal-sanity.myshopify.com/";
const password = process.argv[3] || "root";
const jar = new Map();

function applySetCookies(res) {
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

async function http(url, init = {}, redirect = "follow") {
  const headers = new Headers(init.headers || {});
  if (jar.size) headers.set("Cookie", [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; "));
  headers.set(
    "User-Agent",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120.0.0.0 Safari/537.36",
  );
  const res = await fetch(url, { ...init, headers, redirect });
  applySetCookies(res);
  const text = await res.text();
  return {
    status: res.status,
    url: res.url,
    location: res.headers.get("location"),
    cookies: [...jar.keys()],
    text,
  };
}

function isProtected(html) {
  const lower = html.toLowerCase();
  return (
    lower.includes("password protected") ||
    lower.includes("enter store password") ||
    /<form[^>]+action=["']\/password["']/i.test(html)
  );
}

const gate = await http(new URL("/password", base).href);
const token = gate.text.match(/name="authenticity_token"\s+value="([^"]+)"/)?.[1];
console.log("token", !!token, "gate cookies", gate.cookies);

const postManual = await http(new URL("/password", base).href, {
  method: "POST",
  headers: {
    "Content-Type": "application/x-www-form-urlencoded",
    Referer: new URL("/password", base).href,
    Origin: new URL(base).origin,
  },
  body: new URLSearchParams({ authenticity_token: token, password }).toString(),
}, "manual");
console.log("POST manual", postManual.status, "->", postManual.location, "cookies", postManual.cookies);

if (postManual.location) {
  const follow = await http(new URL(postManual.location, base).href);
  console.log("follow protected?", isProtected(follow.text), "url", follow.url);
}

const postFollow = await http(new URL("/password", base).href, {
  method: "POST",
  headers: {
    "Content-Type": "application/x-www-form-urlencoded",
    Referer: new URL("/password", base).href,
    Origin: new URL(base).origin,
  },
  body: new URLSearchParams({ authenticity_token: token, password }).toString(),
});
console.log("POST follow protected?", isProtected(postFollow.text), "url", postFollow.url);
