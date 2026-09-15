const fs = require("fs");
const src = fs.readFileSync(process.argv[2], "utf8");
let i = 0, line = 1, st = [], mode = null;
const open = "({[", close = ")}]", match = { ")": "(", "}": "{", "]": "[" };
while (i < src.length) {
  const c = src[i], n = src[i + 1];
  if (mode === "//") { if (c === "\n") { mode = null; line++; } i++; continue; }
  if (mode === "/*") { if (c === "*" && n === "/") { mode = null; i += 2; continue; } if (c === "\n") line++; i++; continue; }
  if (mode) {
    if (c === "\\") { i += 2; continue; }
    if (c === mode) { mode = null; i++; continue; }
    if (c === "\n") line++;
    i++; continue;
  }
  if (c === "/" && n === "/") { mode = "//"; i += 2; continue; }
  if (c === "/" && n === "*") { mode = "/*"; i += 2; continue; }
  if (c === '"' || c === "'" || c === "`") { mode = c; i++; continue; }
  if (c === "\n") { line++; i++; continue; }
  if (open.indexOf(c) >= 0) st.push({ c, line });
  else if (close.indexOf(c) >= 0) {
    const t = st.pop();
    if (!t || t.c !== match[c]) { console.log("MISMATCH line " + line + " char " + c + (t ? " (opened " + t.c + " at line " + t.line + ")" : " (stack empty)")); process.exit(1); }
  }
  i++;
}
if (st.length) { const t = st[st.length - 1]; console.log("UNCLOSED " + t.c + " from line " + t.line + " depth=" + st.length); process.exit(1); }
console.log("brackets balanced OK / lines=" + line);
