export function escapeSelector(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

export function formatOutputJs(entries) {
  const lines = Object.entries(entries).map(([key, selector]) => {
    return `  '${key}': '${escapeSelector(selector)}',`;
  });
  return `export default {\n${lines.join("\n")}\n};`;
}
