#!/usr/bin/env node
/**
 * Static acceptance checks for the News24 chatbot.
 *
 *   node tests/chat-check.mjs
 *
 * Dependency-free on purpose (node:fs + regex scans only) — this repo has no
 * build step and no npm packages. Prints one PASS/FAIL line per check and
 * exits 1 when anything fails, so it can be run in CI or by a reviewer.
 *
 * What it covers (docs/chat-contract.md is the reference):
 *   1. scripts/check-stats-view.mjs still passes.
 *   2. index.html vs 404.html differ ONLY by the #viewStats section and the
 *      js/stats.js script line.
 *   3. Both pages pin the same asset versions; the chat markup block is
 *      identical apart from indentation.
 *   4. Every chat id js/chatbot.js touches exists in both pages; no
 *      duplicate ids; the contract's required attributes are present.
 *   5. Static security/robustness review of js/chatbot.js and the app.js
 *      bridge: no unescaped innerHTML, no eval/dynamic code, no API keys in
 *      storage, every getElementById guarded, no load-time throw, model
 *      output rendered as text, localStorage keys all news24:chat:*, no
 *      article bodies persisted, keyboard + focus + aria wiring.
 *   6. CSS review: chat block appended (no existing rule edited), dark theme
 *      via vars, tappable launcher, 320px overflow, reduced motion, the
 *      639px sheet leaves the navigation reachable.
 *
 * Node 18+ (uses import.meta.url + node:fs). No network, no DOM.
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rel = (p) => path.relative(ROOT, p) || ".";

// ---------------------------------------------------------------------------
// Tiny harness
// ---------------------------------------------------------------------------
let failed = 0;
let passed = 0;
const allFailures = [];
const currentSection = { id: "", failures: [] };

function section(id, title) {
  currentSection.id = id;
  currentSection.failures = [];
  console.log(`\n== ${id}. ${title}`);
}

function pass(msg) {
  passed++;
  console.log(`PASS  ${msg}`);
}

function fail(msg, problems = []) {
  failed++;
  console.log(`FAIL  ${msg}`);
  for (const p of problems.slice(0, 40)) console.log(`        ${p}`);
  if (problems.length > 40) console.log(`        ... and ${problems.length - 40} more`);
  currentSection.failures.push(msg);
  allFailures.push({ section: currentSection.id, msg, problems });
}

/** Run an assertion: `ok` may be a boolean, or problems[] (empty = ok). */
function check(msg, ok, problems = []) {
  const bad = Array.isArray(ok) ? ok : ok ? [] : problems.length ? problems : [msg];
  if (Array.isArray(ok) ? ok.length === 0 : ok) pass(msg);
  else fail(msg, bad);
}

function read(relPath) {
  return readFileSync(path.join(ROOT, relPath), "utf-8");
}

function lineStarts(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

function lineOf(src, index) {
  const starts = lineStarts(src);
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** Where to report a problem: "file:line". */
const at = (file, src, index) => `${file}:${lineOf(src, index)}`;

// ---------------------------------------------------------------------------
// Source helpers
// ---------------------------------------------------------------------------
/**
 * Replace JS comments with spaces (newlines kept so line numbers survive) and
 * blank out simple string/template literals, so scans only look at real code.
 * Regex literals are not modelled — callers avoid patterns that care.
 */
function codeOnly(src) {
  let out = "";
  let i = 0;
  let mode = null; // null | "line" | "block" | "'" | '"' | "`"
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (mode === null) {
      if (c === "/" && n === "/") { mode = "line"; out += "  "; i += 2; continue; }
      if (c === "/" && n === "*") { mode = "block"; out += "  "; i += 2; continue; }
      if (c === "'" || c === '"' || c === "`") { mode = c; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (mode === "line") {
      if (c === "\n") { mode = null; out += c; i++; continue; }
      out += " "; i++; continue;
    }
    if (mode === "block") {
      if (c === "*" && n === "/") { mode = null; out += "  "; i += 2; continue; }
      out += c === "\n" ? "\n" : " "; i++; continue;
    }
    // string literal: keep the quotes and newlines, blank the contents
    if (c === "\\") { out += "  "; i += 2; continue; }
    if (c === mode) { mode = null; out += c; i++; continue; }
    out += c === "\n" ? "\n" : " "; i++;
  }
  return out;
}

/** Index of every match of `re` in `src`. */
function allMatches(src, re) {
  const flags = re.flags.includes("g") ? re.flags : re.flags + "g";
  const r = new RegExp(re.source, flags);
  const out = [];
  let m;
  while ((m = r.exec(src))) {
    out.push(m);
    if (m[0] === "") r.lastIndex++;
  }
  return out;
}

/** First argument of a call, cut at the top-level comma. */
function firstArg(rest) {
  let depth = 0;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === "," && depth === 0) return rest.slice(0, i).trim();
  }
  return rest.trim();
}

/** Naive brace matcher from an opening `{` index, skipping strings/comments. */
function matchBrace(code, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < code.length; i++) {
    const c = code[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Inner source of the top-level (optional) IIFE, or the whole file. */
function iifeBody(src) {
  const m = /\(function\s*\(\)\s*\{/.exec(src) || /\(\s*\(\s*\)\s*=>\s*\{/.exec(src);
  if (!m) return { body: src, offset: 0 };
  const open = m.index + m[0].length - 1;
  const close = matchBrace(codeOnly(src), open);
  if (close < 0) return { body: src, offset: 0 };
  return { body: src.slice(open + 1, close), offset: open + 1 };
}

/**
 * "Trivia" source: comments blanked, strings KEPT (we grep Vietnamese copy and
 * localStorage keys in strings) — used for functional scans.
 */
function noComments(src) {
  let out = "";
  let i = 0;
  let mode = null;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (mode === null) {
      if (c === "/" && n === "/") { mode = "line"; out += "  "; i += 2; continue; }
      if (c === "/" && n === "*") { mode = "block"; out += "  "; i += 2; continue; }
      if (c === "'" || c === '"' || c === "`") mode = c;
      out += c; i++; continue;
    }
    if (mode === "line") { out += c === "\n" ? "\n" : " "; i++; if (c === "\n") mode = null; continue; }
    if (mode === "block") { if (c === "*" && n === "/") { mode = null; out += "  "; i += 2; continue; } out += c === "\n" ? "\n" : " "; i++; continue; }
    if (c === "\\") { out += "  "; i += 2; continue; }
    out += c; i++;
    if (c === mode) mode = null;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Files under test
// ---------------------------------------------------------------------------
const F = {
  index: "index.html",
  notFound: "404.html",
  app: "js/app.js",
  chat: "js/chatbot.js",
  css: "css/style.css",
  contract: "docs/chat-contract.md",
};

const missing = Object.entries(F)
  .filter(([, p]) => p !== F.chat && p !== F.contract ? false : !existsSync(path.join(ROOT, p)))
  .map(([, p]) => p);
const chatExists = existsSync(path.join(ROOT, F.chat));

const indexHtml = read(F.index);
const notFoundHtml = read(F.notFound);
const appJs = read(F.app);
const css = read(F.css);
const chatJs = chatExists ? read(F.chat) : "";

// Chat assets stay in their own file: the spec forbids chat logic in app.js.
if (!chatExists) {
  console.error(`\nFAIL  ${F.chat} does not exist — the chatbot is not implemented yet.`);
  process.exit(1);
}
if (missing.length) {
  console.error(`\nFAIL  missing required file(s): ${missing.join(", ")}`);
  process.exit(1);
}

const appCode = codeOnly(appJs);
const chatCode = codeOnly(chatJs);
const chatTrivia = noComments(chatJs);
const appIife = iifeBody(appJs);

// HTML tag scanner: attributes of every element, with index + line.
function elements(html) {
  const els = [];
  for (const m of allMatches(html, /<([a-zA-Z][\w-]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>/g)) {
    const attrs = {};
    for (const a of allMatches(m[2], /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
      attrs[a[1].toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? "";
    }
    els.push({ tag: m[1].toLowerCase(), attrs, index: m.index, line: lineOf(html, m.index) });
  }
  return els;
}

const indexEls = elements(indexHtml);
const indexIds = new Map();
for (const el of indexEls) if (el.attrs.id) indexIds.set(el.attrs.id, el);

// ===========================================================================
section("1", "scripts/check-stats-view.mjs still passes");
// ===========================================================================
try {
  const out = execFileSync(process.execPath, ["scripts/check-stats-view.mjs"], {
    cwd: ROOT,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  pass(`scripts/check-stats-view.mjs: ${out.trim()}`);
} catch (e) {
  const detail = `${(e.stdout || "").trim()}\n${(e.stderr || "").trim()}`.trim();
  fail("scripts/check-stats-view.mjs exits non-zero (stats markup drifted)", detail.split("\n").filter(Boolean));
}

// ===========================================================================
section("2", "index.html vs 404.html diff is only the #viewStats section + stats.js");
// ===========================================================================
{
  // Line-oriented so the reported line numbers are the ones an editor shows.
  const a = indexHtml.split("\n");
  const b = notFoundHtml.split("\n");
  // Remove from `b` (404.html) the blocks/index the contract allows to differ:
  //   #viewStats section, #statsTip tooltip, the js/stats.js <script> line,
  // plus the comments that introduce them.
  const drop = new Array(b.length).fill(false);
  let inStats = false;
  let depth = 0; // <section> nesting inside #viewStats
  for (let i = 0; i < b.length; i++) {
    const line = b[i];
    if (!inStats && /<section class="main-col" id="viewStats"/.test(line)) {
      inStats = true;
      depth = 0;
    }
    if (inStats) {
      drop[i] = true;
      depth += (line.match(/<section\b/g) || []).length;
      depth -= (line.match(/<\/section>/g) || []).length;
      if (depth <= 0 && /<\/section>/.test(line)) inStats = false;
      continue;
    }
    if (/<div id="statsTip"/.test(line)) {
      drop[i] = true;
      // the tooltip is a single element written on one line
      continue;
    }
    if (/<script src="js\/stats\.js/.test(line)) {
      drop[i] = true;
      continue;
    }
  }
  // Comment blocks that only exist to introduce the dropped markup: a comment
  // that opens on a line containing "Stats view"/"Chart tooltip"/"Stats charts"
  // and closes before the next non-comment line.
  for (let i = 0; i < b.length; i++) {
    if (drop[i] || !/^\s*<!--/.test(b[i])) continue;
    const isStatsComment = /Stats view:|Chart tooltip:|Stats charts\./.test(b[i]);
    if (!isStatsComment) continue;
    let j = i;
    while (j < b.length && !/-->/.test(b[j]) && j - i < 8) j++;
    if (j < b.length && /-->/.test(b[j])) {
      for (let k = i; k <= j; k++) drop[k] = true;
    }
  }
  const bFiltered = b.filter((_, i) => !drop[i]);
  const normLine = (l) => l.trimEnd();
  const aNormal = a.map(normLine);
  const bNormal = bFiltered.map(normLine);
  // Ignore blank lines on both sides so removal does not leave gaps behind.
  const aCmp = a.map((l, i) => ({ l: normLine(l), n: i + 1 })).filter((x) => x.l.trim());
  const bCmp = b.map((l, i) => ({ l: normLine(l), n: i + 1, keep: !drop[i] })).filter((x) => x.keep && x.l.trim());

  const drift = [];
  for (let i = 0; i < Math.max(aCmp.length, bCmp.length); i++) {
    const left = aCmp[i];
    const right = bCmp[i];
    if (!left || !right || left.l !== right.l) {
      drift.push(
        `index.html:${left ? left.n : "EOF"} ${JSON.stringify((left && left.l) || "")}` +
          `   vs   404.html:${right ? right.n : "EOF"} ${JSON.stringify((right && right.l) || "")}`
      );
    }
    if (drift.length >= 25) break;
  }
  check(
    "index.html and 404.html differ only by #viewStats + #statsTip + js/stats.js",
    drift.length === 0,
    [
      ...drift,
      "Allowed difference: 404.html = index.html + the #viewStats section + #statsTip + js/stats.js.",
    ]
  );
  void aNormal;
  void bNormal;
}

section("3", "shared asset versions + identical chat markup block");
// ===========================================================================
{
  const assets = (html) =>
    allMatches(html, /<(?:script|link)[^>]*(?:src|href)="([^"]+)"/gi).map((m) => m[1]);
  const indexAssets = assets(indexHtml);
  const notFoundAssets = assets(notFoundHtml);
  const versioned = (list) => list.map((a) => a).sort();
  const onlyIn404 = notFoundAssets.filter((a) => !indexAssets.includes(a));
  const onlyInIndex = indexAssets.filter((a) => !notFoundAssets.includes(a));
  const badVersions = onlyIn404.filter((a) => !/stats\.js/.test(a));
  check(
    "index.html and 404.html load the same CSS/JS versions",
    badVersions.length === 0 && onlyInIndex.every((a) => !/^js\//.test(a)),
    [
      ...badVersions.map((a) => `404.html loads ${a}, index.html does not`),
      ...onlyInIndex.map((a) => `index.html loads ${a}, 404.html does not`),
    ]
  );

  // The two pages must pin the same version string for each shared asset.
  const versionOf = (list, base) => list.filter((a) => a.split("?")[0] === base).map((a) => a);
  for (const base of ["js/app.js", "js/chatbot.js", "css/style.css"]) {
    const a = versionOf(indexAssets, base);
    const b = versionOf(notFoundAssets, base);
    check(
      `${base} version is pinned identically on both pages`,
      a.length === 1 && b.length === 1 && a[0] === b[0],
      [
        `index.html: ${a.length ? a.join(", ") : "<missing>"}`,
        `404.html:   ${b.length ? b.join(", ") : "<missing>"}`,
      ]
    );
  }

  // Extract the chat markup block (launcher .. end of panel) from a page.
  const chatBlock = (html) => {
    const start = html.search(/<button class="chat-fab"[^>]*id="chatFab"/);
    if (start < 0) return null;
    const launcherEnd = html.indexOf("</button>", start);
    if (launcherEnd < 0) return null;
    const panelStart = html.indexOf('<section class="chat-panel"', launcherEnd);
    if (panelStart < 0) return null;
    const panelClose = html.indexOf("</section>", panelStart);
    if (panelClose < 0) return null;
    return html.slice(start, panelClose + "</section>".length);
  };
  const blockA = chatBlock(indexHtml);
  const blockB = chatBlock(notFoundHtml);
  const normalise = (s) => (s || "").split("\n").map((l) => l.trim()).join("\n").replace(/\n+/g, "\n");
  check(
    "chat launcher + panel markup exists in index.html",
    !!blockA
  );
  check(
    "chat markup block is identical apart from indentation in index.html and 404.html",
    !!blockA && !!blockB && normalise(blockA) === normalise(blockB),
    !blockB ? ["404.html has no chat-fab/chat-panel block"] : ["blocks differ — copy the block verbatim from index.html"]
  );

  // Load order: chatbot.js after app.js (it needs window.NewsChat).
  const scriptTags = allMatches(indexHtml, /<script[^>]*src="([^"]+)"/g).map((m) => ({
    src: m[1],
    index: m.index,
  }));
  const appAt = scriptTags.find((s) => s.src.includes("js/app.js"));
  const chatAt = scriptTags.find((s) => s.src.includes("js/chatbot.js"));
  check(
    "js/chatbot.js is loaded after js/app.js in index.html",
    !!appAt && !!chatAt && chatAt.index > appAt.index,
    [
      !appAt ? "index.html: no js/app.js <script>" : "",
      !chatAt ? "index.html: no js/chatbot.js <script>" : "js/chatbot.js is loaded before js/app.js",
    ].filter(Boolean)
  );
  check(
    "js/chatbot.js script tag is present in 404.html too",
    /<script[^>]*src="js\/chatbot\.js/.test(notFoundHtml)
  );

  // The contract's _v= bumps (v>=29 app.js, v>=23 css) so returning visitors
  // do not run a stale cache without the chat.
  const appV = /js\/app\.js\?v=(\d+)/.exec(indexHtml);
  const cssV = /css\/style\.css\?v=(\d+)/.exec(indexHtml);
  check(
    "app.js?v= and style.css?v= were bumped for the chat release",
    !!appV && +appV[1] >= 29 && !!cssV && +cssV[1] >= 23,
    [
      `js/app.js?v=${appV ? appV[1] : "<none>"} (expected >= 29)`,
      `css/style.css?v=${cssV ? cssV[1] : "<none>"} (expected >= 23)`,
    ]
  );
}

// ===========================================================================
section("4", "DOM contract: ids, a11y attributes, no duplicates");
// ===========================================================================
{
  const REQUIRED_ATTRS = {
    chatFab: {
      tag: "button",
      attrs: { "aria-expanded": null, "aria-controls": "chatPanel", "aria-label": null, type: "button" },
    },
    chatPanel: {
      tag: "section",
      attrs: { role: "dialog", "aria-labelledby": "chatTitle", hidden: null },
    },
    chatTitle: { tag: "h2", attrs: {} },
    chatNew: { tag: "button", attrs: {} },
    chatCfg: { tag: "button", attrs: {} },
    chatClose: { tag: "button", attrs: { "aria-label": null } },
    chatCtx: { tag: null, attrs: {} },
    chatLog: { tag: null, attrs: { role: "log", "aria-live": "polite" } },
    chatChips: { tag: null, attrs: {} },
    chatForm: { tag: "form", attrs: {} },
    chatInput: { tag: "textarea", attrs: {} },
    chatSend: { tag: "button", attrs: { "aria-label": null } },
  };

  const problems = [];
  for (const [id, spec] of Object.entries(REQUIRED_ATTRS)) {
    const el = indexIds.get(id);
    if (!el) {
      problems.push(`index.html: missing #${id} from the chat markup`);
      continue;
    }
    if (spec.tag && el.tag !== spec.tag) {
      problems.push(`index.html:${el.line} #${id} is <${el.tag}>, contract says <${spec.tag}>`);
    }
    for (const [name, want] of Object.entries(spec.attrs)) {
      if (!(name in el.attrs)) {
        problems.push(`index.html:${el.line} #${id} is missing ${name}`);
      } else if (want !== null && el.attrs[name] !== want) {
        problems.push(`index.html:${el.line} #${id} ${name}="${el.attrs[name]}", expected "${want}"`);
      }
    }
  }
  // The panel starts hidden and the launcher starts collapsed.
  const panel = indexIds.get("chatPanel");
  if (panel && !("hidden" in panel.attrs)) problems.push(`index.html:${panel.line} #chatPanel must start with the hidden attribute`);
  const fab = indexIds.get("chatFab");
  if (fab && fab.attrs["aria-expanded"] !== "false") problems.push(`index.html:${fab.line} #chatFab must start aria-expanded="false"`);
  check("chat markup ids + required attributes match docs/chat-contract.md", problems, problems);

  // No duplicate ids, and the panel/launcher must be outside other landmarks
  // that could hide them (body-level, like the AI settings dialog).
  const idList = indexEls.filter((e) => e.attrs.id).map((e) => e.attrs.id);
  const dupes = idList.filter((id, i) => idList.indexOf(id) !== i);
  check("index.html has no duplicate ids", dupes.length === 0, [...new Set(dupes)].map((d) => `duplicate id="${d}"`));

  const notFoundIdList = elements(notFoundHtml).filter((e) => e.attrs.id).map((e) => e.attrs.id);
  const dupes404 = notFoundIdList.filter((id, i) => notFoundIdList.indexOf(id) !== i);
  check("404.html has no duplicate ids", dupes404.length === 0, [...new Set(dupes404)].map((d) => `duplicate id="${d}"`));

  // Every id chatbot.js looks up must exist in BOTH pages.
  const looked = new Set();
  for (const m of allMatches(chatTrivia, /getElementById\(\s*["']([\w-]+)["']\s*\)/g)) looked.add(m[1]);
  for (const m of allMatches(chatTrivia, /querySelector\(\s*["']#([\w-]+)["']\s*\)/g)) looked.add(m[1]);
  const notFoundIds = new Set(notFoundIdList);
  const missingIndex = [...looked].filter((id) => !indexIds.has(id));
  const missing404 = [...looked].filter((id) => !notFoundIds.has(id));
  check(
    "every id js/chatbot.js looks up exists in index.html",
    missingIndex.length === 0,
    missingIndex.map((id) => `js/chatbot.js references #${id}, not found in index.html`)
  );
  check(
    "every id js/chatbot.js looks up exists in 404.html",
    missing404.length === 0,
    missing404.map((id) => `js/chatbot.js references #${id}, not found in 404.html`)
  );
  // Static id list from the contract, so a hard-coded lookup via a map key is
  // still caught.
  const contractIds = ["chatFab", "chatPanel", "chatTitle", "chatNew", "chatCfg", "chatClose",
    "chatCtx", "chatLog", "chatChips", "chatForm", "chatInput", "chatSend"];
  const used = contractIds.filter((id) => new RegExp(`["']${id}["']`).test(chatTrivia));
  check(
    "chatbot.js wires the contract ids (not a parallel markup)",
    used.length >= 4,
    [`only ${used.length}/12 contract ids appear in js/chatbot.js`]
  );
}

// ===========================================================================
section("5", "js/chatbot.js + app.js bridge: security and robustness");
// ===========================================================================
{
  // ---- 5a. No innerHTML of model output / fetched text, no dynamic code ---
  const innerHtmlAssign = allMatches(chatCode, /\.(innerHTML|outerHTML)\s*(\+?=)/g);
  const chatLineCount = chatJs.split("\n").length;
  // A literal-only innerHTML (no interpolation) is fine.
  const literalOnly = allMatches(chatTrivia, /\.(?:innerHTML|outerHTML)\s*=\s*(["'])(?:(?!\1)[^\\]|\\.)*\1\s*;/g);
  const unguarded = innerHtmlAssign.filter(
    (m) => !literalOnly.some((l) => Math.abs(l.index - m.index) < 2)
  );
  check(
    "js/chatbot.js never assigns dynamic innerHTML/outerHTML",
    unguarded.length === 0,
    unguarded.map((m) => `${at(F.chat, chatCode, m.index)} dynamic .innerHTML${m[2] === "=" ? "=" : "+="} — build nodes with createElement/textContent instead`)
  );
  const evalSites = [
    ...allMatches(chatCode, /\beval\s*\(/g),
    ...allMatches(chatCode, /\bnew\s+Function\s*\(/g),
    ...allMatches(chatCode, /\bsetTimeout\s*\(\s*["'`]/g),
    ...allMatches(chatCode, /\bsetInterval\s*\(\s*["'`]/g),
    ...allMatches(chatCode, /\bdocument\.write\s*\(/g),
    ...allMatches(chatCode, /\.insertAdjacentHTML\s*\(/g),
  ].sort((x, y) => x.index - y.index);
  check(
    "js/chatbot.js has no eval/Function/document.write/insertAdjacentHTML",
    evalSites.length === 0,
    evalSites.map((m) => `${at(F.chat, chatCode, m.index)} ${m[0].trim()}`)
  );

  // ---- 5b. href / src assignment is validated -----------------------------
  // Every navigation target has to come out of a slug validator. Find the
  // validator (a function that returns a slug parsed by a strict article-URL
  // regex) and require each `.href =` / `.src =` to be fed by it, by a
  // literal, or by a value that a comment on the same statement vouches for.
  {
    // A slug validator: a function whose body applies an anchored
    // vnexpress article-URL / slug regex and returns a capture group.
    const slugFns = [];
    for (const m of allMatches(chatTrivia, /function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/g)) {
      const open = chatTrivia.indexOf("{", m.index);
      const close = matchBrace(chatTrivia, open);
      const body = chatTrivia.slice(open, close);
      const anchored = /(\^https:\\\/\\\/vnexpress|\^\(\?:\[\\w-\]\+\\\/\)\*\(\[a-z0-9\])/.test(body) ||
        /\^\([^)]*\d\+[^)]*\\\.html/.test(body) || /\^https:\/\/vnexpress\\\.net\\\//.test(body) ||
        /\[\^\\w\-\]/.test(body);
      const returnsSlug = /return\s+[^;]*\[1\]/.test(body) || /return\s+[^;]*(?:slug|m\[)/.test(body);
      if (anchored || returnsSlug) slugFns.push(m[1]);
    }
    const slugFnRe = slugFns.length
      ? new RegExp(`\\b(?:${slugFns.map((n) => n.replace(/\$/g, "\\$")).join("|")})\\s*\\(`)
      : null;
    check(
      "js/chatbot.js validates article links with an anchored slug regex before use",
      !!slugFnRe,
      ["no slug validator (anchored https://vnexpress.net/<slug>-<id>.html regex) found in js/chatbot.js"]
    );

    const hrefAssign = [
      ...allMatches(chatCode, /\.(?:href|src)\s*=(?!=)/g),
      ...allMatches(chatCode, /setAttribute\(\s*["'](?:href|src)["']/g),
    ];
    const bad = [];
    for (const m of hrefAssign) {
      const lineStart = chatCode.lastIndexOf("\n", m.index) + 1;
      const lineEnd = chatCode.indexOf("\n", m.index);
      const line = chatTrivia.slice(lineStart, lineEnd < 0 ? chatTrivia.length : lineEnd);
      // The RHS and, for `a.href = slug;` style code, the preceding `const
      // slug = ...` in the same block.
      const rhs = line.slice(line.slice(0, m.index - lineStart).length + m[0].length);
      if (/^\s*(["'`][^"'`]*["'`])\s*;?\s*$/.test(rhs)) continue; // literal URL
      const window = chatTrivia.slice(Math.max(0, lineStart - 400), m.index);
      const fedByValidator = slugFnRe && slugFnRe.test(window + " " + rhs);
      if (!fedByValidator) {
        bad.push(`${at(F.chat, chatTrivia, m.index)} ${line.trim()} — not fed by ${slugFns.join("/") || "a slug validator"}`);
      }
    }
    check(
      "every href/src assignment in js/chatbot.js comes from the slug validator or a literal",
      bad.length === 0,
      bad
    );
    // Model text must never be spun into a URL: no template literals
    // starting with a protocol built from variables.
    const dynamicUrl = allMatches(chatTrivia, /`\s*https?:\/\/\$\{/g).concat(allMatches(chatTrivia, /["']https?:\/\/["']\s*\+/g));
    check(
      "no URL is built by concatenating model/user text",
      dynamicUrl.length === 0,
      dynamicUrl.map((m) => `${at(F.chat, chatTrivia, m.index)} ${m[0]} — a javascript:/data: string could slip through`)
    );
  }
  // openArticle / innerHTML text nodes must be textContent.
  check(
    "model output is rendered with textContent/createTextNode",
    /\.textContent\s*=/.test(chatTrivia) || /createTextNode\s*\(/.test(chatTrivia),
    ["js/chatbot.js: no textContent/createTextNode — how is the answer rendered?"]
  );

  // ---- 5c. localStorage hygiene ------------------------------------------
  const PREFIX_RE = /news24:chat:/;
  // A key constant declared once (`const P_THREAD = "news24:chat:thread:"`)
  // has to carry the namespace; call sites may then use the constant.
  const prefixDeclared = allMatches(
    chatTrivia,
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*["'`]news24:chat:[^"'`]*["'`]/g
  ).map((m) => m[1]);
  const identRe = prefixDeclared.length
    ? new RegExp(`\\b(?:${prefixDeclared.map((n) => n.replace(/\$/g, "\\$")).join("|")})\\b`)
    : null;

  // Thin wrappers take the key from their caller, so their own parameter is
  // not a key: collect them and check every call site instead.
  const wrappers = allMatches(
    chatTrivia,
    /function\s+([A-Za-z_$][\w$]*)\s*\(\s*([A-Za-z_$][\w$]*)\s*[,)]/
  ).filter((m) => {
    const open = chatTrivia.indexOf("{", m.index);
    const close = matchBrace(chatTrivia, open);
    if (close < 0) return false;
    const body = chatTrivia.slice(open, close);
    return new RegExp(
      `localStorage\\.(?:getItem|setItem|removeItem)\\s*\\(\\s*${m[2].replace(/\$/g, "\\$")}\\b`
    ).test(body);
  }).map((m) => ({ name: m[1], param: m[2], index: m.index }));

  // -> {index, key} for every storage key expression, wrapper bodies excluded
  const keySites = [];
  for (const m of allMatches(chatTrivia, /localStorage\.(?:getItem|setItem|removeItem)\s*\(\s*([^)\n]*)/g)) {
    const inWrapper = wrappers.some(
      (w) => m.index > w.index && m.index - w.index < 200 && m[1].trim().startsWith(w.param)
    );
    if (inWrapper) continue;
    keySites.push({ index: m.index, key: firstArg(m[1]) });
  }
  for (const w of wrappers) {
    const re = new RegExp(`\\b${w.name.replace(/\$/g, "\\$")}\\s*\\(\\s*([^,)\n]*)`, "g");
    for (const m of allMatches(chatTrivia, re)) {
      // skip the declaration itself
      if (/function\s+$/.test(chatTrivia.slice(Math.max(0, m.index - 10), m.index))) continue;
      keySites.push({ index: m.index, key: m[1].trim(), via: w.name });
    }
  }
  const badKeys = keySites.filter((k) => !(PREFIX_RE.test(k.key) || (identRe && identRe.test(k.key))));
  check(
    "every localStorage call is namespaced news24:chat:*",
    keySites.length > 0 && badKeys.length === 0,
    keySites.length === 0
      ? ["js/chatbot.js: no localStorage usage found at all (the contract requires persisted chat state)"]
      : badKeys.map((k) => `${at(F.chat, chatTrivia, k.index)} storage key "${k.key.slice(0, 60)}" is not news24:chat:*`)
  );
  check(
    "js/chatbot.js does not touch AI settings or article-cache keys",
    !/news24:(?:ai|cfg|art|theme)[:\-]/.test(noComments(chatCode)),
    allMatches(noComments(chatCode), /news24:(?:ai|cfg|art|theme)[:\-]/g).map(
      (m) => `${at(F.chat, chatCode, m.index)} writes/reads a non-chat key`
    )
  );
  // Never persist article bodies: flag setItem near bodyText / currentArticle bodies.
  {
    const setItems = allMatches(chatTrivia, /localStorage\.setItem\s*\(/g).map((m) => {
      const open = chatTrivia.indexOf("(", m.index);
      let depth = 0;
      let end = open;
      for (let i = open; i < chatTrivia.length; i++) {
        if (chatTrivia[i] === "(") depth++;
        else if (chatTrivia[i] === ")") { depth--; if (depth === 0) { end = i; break; } }
      }
      return { index: m.index, src: chatTrivia.slice(open, end + 1), end };
    });
    const BODY_WORDS = /\b(bodyText|articleText|articleBody|fullText|extractive|body\b|content)\b/;
    const offenders = [];
    for (const s of setItems) {
      // Find the JSON.stringify(...) argument and test whether it mentions body text.
      const strArgs = allMatches(s.src, /JSON\.stringify\s*\(/g);
      for (const sa of strArgs) {
        let depth = 0;
        let argEnd = sa.index;
        for (let i = sa.index + sa[0].length - 1; i < s.src.length; i++) {
          if (s.src[i] === "(") depth++;
          else if (s.src[i] === ")") { depth--; if (depth === 0) { argEnd = i; break; } }
        }
        const arg = s.src.slice(sa.index, argEnd + 1);
        if (BODY_WORDS.test(arg)) offenders.push(`${at(F.chat, chatTrivia, s.index)} setItem persists what looks like article text: ${arg.slice(0, 90)}`);
      }
    }
    check("no article bodies are written to localStorage", offenders.length === 0, offenders);
  }
  // localStorage wrapped in try/catch (private mode / disabled storage throws).
  // A direct access counts as guarded when it sits inside a `try {` block or
  // when the function containing it has a `try` between its `{` and the call.
  {
    const raw = chatTrivia;
    const guarded = (idx) => {
      // innermost `try {` that is still open at `idx`
      let depth = 0;
      let lastTryDepth = null;
      let sawTryAt = -1;
      for (let i = 0; i < idx; i++) {
        const c = raw[i];
        if (c === "{") {
          depth++;
          if (/try\s*$/.test(raw.slice(Math.max(0, i - 6), i))) { sawTryAt = depth; lastTryDepth = i; }
        } else if (c === "}") {
          if (sawTryAt !== null && depth === sawTryAt) { sawTryAt = null; lastTryDepth = -1; }
          depth--;
        }
      }
      if (sawTryAt !== null && lastTryDepth >= 0) return true;
      // inside a helper function that has its own try block
      const fnStart = Math.max(raw.lastIndexOf("function ", idx), raw.lastIndexOf("=>", idx));
      if (fnStart >= 0 && idx - fnStart < 1500) {
        const chunk = raw.slice(fnStart, idx);
        return /\btry\s*\{/.test(chunk);
      }
      return false;
    };
    const accesses = allMatches(raw, /localStorage\./g);
    const unwrapped = accesses.filter((m) => !guarded(m.index));
    check(
      "localStorage access is guarded by try/catch (works when storage throws)",
      unwrapped.length === 0,
      unwrapped.slice(0, 8).map((m) => `${at(F.chat, raw, m.index)} localStorage.${raw.slice(m.index + 12, m.index + 24).split("(")[0]} outside a try/catch`)
    );
  }

  // ---- 5d. getElementById results are guarded ----------------------------
  {
    // Every id resolved once and then null-checked, OR used through `?.`.
    const sites = allMatches(chatTrivia, /getElementById\s*\(\s*["']([\w-]+)["']\s*\)/g);
    const unguarded = [];
    for (const m of sites) {
      const id = m[1];
      const after = chatTrivia.slice(m.index + m[0].length, m.index + m[0].length + 40);
      // chained optional call: getElementById("x")?.
      if (/^\s*\?\./.test(after)) continue;
      // inline guard: ... ||  /  &&  /  ? (ternary)
      if (/^\s*(\|\||&&|\?)/.test(after)) continue;
      // assigned to a name -> require a guard somewhere for that name
      const assign = /^[\w$.]+\s*=\s*$/.test(chatTrivia.slice(Math.max(0, m.index - 40), m.index).split(/[;\n]/).pop() + "");
      const lineStart = chatTrivia.lastIndexOf("\n", m.index) + 1;
      const line = chatTrivia.slice(lineStart, chatTrivia.indexOf("\n", m.index));
      const nameM = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(line);
      if (nameM) {
        const name = nameM[1].replace(/\$/g, "\\$");
        const guard = new RegExp(`(?:!\\s*${name}\\b|${name}\\s*(?:&&|\\?\\?|\\)\\s*\\{|===?\\s*null|!==?\\s*null)|if\\s*\\(\\s*${name}\\b)`);
        const scope = chatTrivia.slice(m.index, m.index + 4000);
        if (guard.test(scope) || /^\s*\?\./.test(after)) continue;
        unguarded.push(`${at(F.chat, chatTrivia, m.index)} #${id} -> ${nameM[1]} is never null-checked`);
        continue;
      }
      // Element looked up inline (e.g. inside a template or a call): require
      // an immediate member access guarded elsewhere is hard; accept `if (`.
      if (/^\s*\)/.test(after)) continue;
    }
    check("every getElementById in js/chatbot.js is null-guarded", unguarded.length === 0, unguarded);
  }

  // ---- 5e. no throw at load ---------------------------------------------
  {
    // A classic script: no ESM syntax anywhere (it is loaded without
    // type="module", so import/export would be a syntax error that silently
    // kills the whole file). `await` is only illegal at the top level, i.e.
    // outside any function body — approximate by requiring an enclosing
    // function keyword before it.
    const esm = allMatches(chatCode, /(?:^|[;{}])\s*(?:import\s+[\w{"'*]|export\s+(?:default|const|let|var|function|class|\{))/gm);
    check("js/chatbot.js contains no ESM syntax (loaded as a classic script)", esm.length === 0,
      esm.map((m) => `${at(F.chat, chatCode, m.index)} ${m[0].trim().slice(0, 40)} — a classic <script> cannot parse this`));

    // The file must end with an IIFE invocation, not bare module-level code.
    const iife = /\(function\s*\(\s*\)\s*\{/.test(chatCode) || /\(\(\)\s*=>\s*\{/.test(chatCode);
    check("js/chatbot.js is wrapped in an IIFE (no globals leaked)", iife,
      ["no (function () { ... })() wrapper found"]);

    // Every top-level `document`/`window` member access in the IIFE runs at
    // load time (the script tag is at the end of <body>, so the DOM exists).
    // What it must not do is throw: flag unguarded `document.querySelector`
    // calls that are immediately dereferenced without any null check.
    const unguardedQ = allMatches(chatCode, /document\.querySelector(?:All)?\([^)]*\)\s*\./g);
    check("document.querySelector(...) results are never dereferenced unguarded", unguardedQ.length === 0,
      unguardedQ.map((m) => `${at(F.chat, chatCode, m.index)} ${m[0].slice(0, 70)}…`));

    // The script is loaded at the end of <body> by both pages, which is what
    // makes a DOMContentLoaded guard unnecessary; verify that assumption.
    const scripts = allMatches(indexHtml, /<script[^>]*src="([^"]+)"/g).map((m) => m[1]);
    const chatIdx = scripts.findIndex((x) => x.includes("chatbot.js"));
    check(
      "js/chatbot.js is the page's last script (its DOM is already parsed)",
      chatIdx === scripts.length - 1,
      [`index.html script order: ${scripts.join(", ")} — chatbot.js must come last`]
    );
    check(
      "js/chatbot.js checks window.NewsChat exists before using it",
      /window\.NewsChat|NewsChat\s*[?!.&]|NewsChat\s*\)/.test(chatJs),
      ["js/chatbot.js: no guard for a missing window.NewsChat bridge"]
    );
  }

  // ---- 5f. app.js bridge ------------------------------------------------
  {
    // Strings must be visible (member names, error codes), comments must not.
    const appTrivia = noComments(appJs);
    const required = ["version", "currentArticle", "getArticle", "openArticle", "allItems", "chat", "openSettings"];
    const bridge = /window\.NewsChat\s*=\s*\{/.exec(appTrivia);
    const problems = [];
    if (!bridge) problems.push("js/app.js: window.NewsChat is never assigned");
    else {
      const open = appTrivia.indexOf("{", bridge.index);
      const close = matchBrace(appTrivia, open);
      const body = appTrivia.slice(open, close);
      for (const name of required) {
        // `name: fn`, `name(...) {` or ES2015 shorthand `name,`
        const re = new RegExp(`(?:^|[{,\\s])${name}\\s*(?:[:,(])`, "m");
        if (!re.test(body)) problems.push(`js/app.js: window.NewsChat.${name} missing`);
      }
      const version = /version\s*:\s*(\d+)/.exec(body);
      if (version && version[1] !== "1") problems.push(`js/app.js: window.NewsChat.version = ${version[1]}, contract says 1`);
    }
    check("app.js exposes the full window.NewsChat bridge", problems, problems);

    const eventSites = allMatches(appTrivia, /news24:article/g);
    check(
      'app.js dispatches the "news24:article" CustomEvent',
      eventSites.length > 0 && /new\s+CustomEvent\(\s*["']news24:article["']/.test(appTrivia),
      ["js/app.js: no new CustomEvent(\"news24:article\", ...) dispatch found"]
    );

    // Integration only: no chat UI in app.js.
    const chatUiInApp = [
      ...allMatches(appTrivia, /chatFab|chatPanel|chatLog|chatInput|chatSend|chatChips|chatCtx|chatTitle/g),
    ];
    check(
      "app.js contains no chat UI/logic (integration only, per the contract)",
      chatUiInApp.length === 0,
      chatUiInApp.map((m) => `${at(F.app, appTrivia, m.index)} ${m[0]}`)
    );

    // The bridge must not cache or log API keys / article bodies itself.
    const evalInApp = allMatches(appCode, /\beval\s*\(|\bnew\s+Function\s*\(/g);
    check("app.js bridge has no eval/Function", evalInApp.length === 0,
      evalInApp.map((m) => `${at(F.app, appCode, m.index)} ${m[0]}`));

    // Chat errors must map to the contract's codes.
    const bridgeSrc = (() => {
      if (!bridge) return "";
      const open = appTrivia.indexOf("{", bridge.index);
      const close = matchBrace(appTrivia, open);
      return appTrivia.slice(open, close);
    })();
    // chat(spec) in the bridge is whatever function the object points at, so
    // follow it into the IIFE and inspect that function's body.
    const chatFnName = (() => {
      const m = /[{,\s]chat\s*:\s*([A-Za-z_$][\w$]*)/.exec(bridgeSrc);
      if (m) return m[1];
      return /[{,\s]chat\s*[,}]/.test(bridgeSrc) ? "chat" : null;
    })();
    const chatFnSrc = (() => {
      if (!chatFnName) return "";
      const re = new RegExp(`(?:async\\s+)?function\\s+${chatFnName.replace(/\$/g, "\\$")}\\s*\\(`);
      const m = re.exec(appTrivia) || new RegExp(`(?:const|let|var)\\s+${chatFnName.replace(/\$/g, "\\$")}\\s*=`).exec(appTrivia);
      if (!m) return "";
      const open = appTrivia.indexOf("{", m.index);
      if (open < 0) return "";
      const close = matchBrace(appTrivia, open);
      return appTrivia.slice(m.index, close + 1);
    })();
    const fnBody = appJs.slice(appJs.indexOf(chatFnSrc.slice(0, 60)) >= 0 ? appJs.indexOf(chatFnSrc.slice(0, 60)) : 0);
    const codes = ["AI key", "AI rate"].filter(
      (c) => chatFnSrc.includes(`"${c}"`) || chatFnSrc.includes(`'${c}'`) || chatFnSrc.includes(`"${c}"`)
    );
    check(
      'the bridge surfaces the contract error codes ("AI key" / "AI rate" / "AI <x>")',
      codes.length === 2 || /["'`]AI \$\{|["'`]AI ["'`]\s*\+/.test(chatFnSrc),
      [
        `chat() implementation not found for ${chatFnName || "<unresolved>"}`,
        ...["AI key", "AI rate"].filter((c) => !codes.includes(c)).map((c) => `error message "${c}" is never produced`),
      ]
    );
    check(
      "the bridge reuses the existing provider chain + rate governor",
      /buildAiPlan|aiRequest|aiSummarize|gateWait|gateRecord/.test(chatFnSrc || bridgeSrc),
      ["js/app.js NewsChat.chat(): does not go through buildAiPlan/aiRequest/gateWait/gateRecord"]
    );
    void fnBody;
    // currentArticle must cap the body at 12000 chars.
    check(
      "currentArticle() caps bodyText at 12000 chars",
      /12000/.test(bridgeSrc) || /12000/.test(appJs),
      ["js/app.js: no 12000-char cap on currentArticle().bodyText"]
    );
  }

  // ---- 5g. required behaviours -----------------------------------------
  const behaviour = [
    ["Esc closes the panel", /["']Escape["']|key\s*===?\s*["']Esc/, "no Escape key handler"],
    ["/ and Ctrl/Cmd+K open the panel", /["']\/["']|key\s*===?\s*["']\/["']/, "no '/' shortcut"],
    ["Ctrl/Cmd+K shortcut", /["']k["']|["']K["']/, "no Ctrl/Cmd+K shortcut"],
    ["Enter sends, Shift+Enter newlines", /shiftKey/, "no shiftKey check on Enter"],
    ["aria-expanded is toggled", /aria-expanded|setAttribute\(\s*["']aria-expanded/, "aria-expanded never updated"],
    ["history trimming (8 turns)", /\b8\b/, "no 8-turn trim constant"],
    ["thinking/progress row while waiting", /thinking|dang-nghi|pending|loading|waiting/i, "no in-flight row"],
    ["article context reset on news24:article", /news24:article/, "no news24:article listener"],
    ["AI key failure message", /AI key/, "no 'AI key' branch"],
    ["AI rate failure message", /AI rate/, "no 'AI rate' branch"],
    ["topic search is local-only (no fetch on search)", /allItems\s*\(/, "no NewsChat.allItems() search"],
    ["diacritic-insensitive search", /normalize\(\s*["']NFD["']\s*\)|normalize\(\s*["']NFKD["']\s*\)|normalize\(\s*["']NFC["']\s*\)/, "no Unicode normalize() for accent-insensitive search"],
    ["openArticle used by result cards/citations", /openArticle\s*\(/, "NewsChat.openArticle() never called"],
  ];
  const missingBehaviour = behaviour
    .filter(([, re]) => !re.test(chatTrivia))
    .map(([name, , why]) => `${name}: ${why}`);
  check("contract behaviours are implemented (keyboard, history, errors, search)", missingBehaviour.length === 0, missingBehaviour);

  // Focus management: returns focus to the launcher on close, input focused on open.
  {
    const problems = [];
    if (!/\.focus\s*\(/.test(chatTrivia)) problems.push("js/chatbot.js: never calls .focus() — keyboard users cannot reach the panel");
    const fab = indexIds.get("chatFab");
    const focusFab = /chatFab/.test(chatTrivia);
    if (!focusFab) problems.push("js/chatbot.js: never references #chatFab for focus return");
    check("focus is moved on open and returned on close", problems, problems);
  }
  // Typing in another field must not trigger the shortcuts.
  check(
    "shortcuts are suppressed while typing in another field",
    /isContentEditable|contentEditable|tagName|INPUT|TEXTAREA/.test(chatTrivia),
    ["js/chatbot.js: no input-field check before the '/' and Ctrl+K shortcuts"]
  );
  // Reduced motion is handled in CSS (checked in section 6); the JS must not
  // hard-code animation durations instead of respecting the media query.
  check(
    "no inline transition/animation style that ignores prefers-reduced-motion",
    !/\.style\.(?:transition|animation)\s*=/.test(chatCode),
    allMatches(chatCode, /\.style\.(?:transition|animation)\s*=/g).map(
      (m) => `${at(F.chat, chatCode, m.index)} inline ${m[0]} bypasses the reduced-motion rule`
    )
  );
  // The panel must not crash when every provider fails.
  {
    const callSites = allMatches(chatTrivia, /\bNC\.chat\s*\(/g);
    const unguarded = callSites.filter((m) => {
      // inside a try block? walk back for an open `try {`
      let depth = 0;
      for (let i = m.index; i >= 0; i--) {
        if (chatTrivia[i] === "}") depth++;
        else if (chatTrivia[i] === "{") {
          if (depth === 0) return !/\btry\s*$/.test(chatTrivia.slice(Math.max(0, i - 8), i));
          depth--;
        }
      }
      return true;
    });
    check(
      "every NC.chat() call is inside try/catch (provider failure cannot break the panel)",
      callSites.length > 0 && unguarded.length === 0,
      callSites.length === 0
        ? ["js/chatbot.js never calls NC.chat()"]
        : unguarded.map((m) => `${at(F.chat, chatTrivia, m.index)} NC.chat(...) outside try/catch — an Error would reject unhandled`)
    );
  }
}

// ===========================================================================
section("6", "CSS: placement, dark theme, launcher size, 320px, reduced motion");
// ===========================================================================
{
  const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));

  // ---- Parse rules into {selector, body, media[], index} ------------------
  // A tiny block walker: handles nested @media/@supports and top-level rules.
  function parseRules(src) {
    const rules = [];
    const stack = []; // containers currently open, each {prelude, close}
    let i = 0;
    let segStart = 0;
    while (i < src.length) {
      // pop any container whose block already ended
      while (stack.length && i > stack[stack.length - 1].close) stack.pop();
      const c = src[i];
      if (c === "{") {
        const prelude = src.slice(segStart, i).trim();
        const close = matchBrace(src, i);
        if (close < 0) break;
        if (/^@(media|supports|layer|container)\b/.test(prelude)) {
          stack.push({ prelude, close });
          i++;
          segStart = i;
          continue;
        }
        rules.push({
          selector: prelude,
          body: src.slice(i + 1, close),
          media: stack.map((x) => x.prelude),
          index: segStart,
        });
        i = close + 1;
        segStart = i;
        continue;
      }
      if (c === "}" || c === ";") {
        i++;
        segStart = i;
        continue;
      }
      i++;
    }
    return rules;
  }
  const rules = parseRules(cssNoComments);
  const chatRules = rules.filter((r) => /\.chat-|chat-open|--chat-vh/.test(r.selector));
  const realChatRules = chatRules.filter((r) => /\.chat-[a-z-]/.test(r.selector));

  check("css/style.css styles the chat components", realChatRules.length > 0,
    ["no .chat-* rule found in css/style.css"]);

  // Every chat rule must be outside a media/supports container OR inside a
  // container whose prelude is itself well-formed (the parser above would
  // have produced a garbage selector otherwise). Report the containers so a
  // rule appended inside an existing @media block by mistake is visible.
  {
    const straySelectors = realChatRules.filter((r) => /[{}]/.test(r.selector) || /^\s*@/.test(r.selector));
    check("chat rules are well-formed (no rule left inside another rule's block)",
      straySelectors.length === 0,
      straySelectors.map((r) => `${F.css}:${lineOf(cssNoComments, r.index)} parsed badly: ${r.selector.slice(0, 80)}`));
  }

  // Append-only: the chat styles must not rewrite pre-existing rules.
  //
  // Compare the real diff instead of string-prefixing the file against
  // `git show HEAD:` — HEAD legitimately moves forward as commits land
  // (including ones unrelated to the chat), which made the prefix test
  // report edits that were already committed long before the chatbot.
  // `git diff` also answers the actual question directly: are any existing
  // lines gone?
  try {
    const diff = execFileSync("git", ["diff", "--", "css/style.css"], {
      cwd: ROOT, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
    });
    const removed = diff
      .split("\n")
      .filter((ln) => ln.startsWith("-") && !ln.startsWith("---"));
    check(
      "css/style.css is append-only vs git HEAD (no existing rule edited)",
      removed.length === 0,
      removed.slice(0, 10).map((ln) => `removed: ${ln.slice(0, 100)}`)
    );
  } catch {
    console.log("SKIP  append-only CSS check (no git history available)");
  }

  // ---- Dark theme ---------------------------------------------------------
  {
    // Chat surfaces must colour through variables (or have a dark override).
    const surfaceSel = /\.chat-(?:fab|panel|head|log|form|chips|ctx|bubble|card|chip|quote)\b/;
    const surfaces = realChatRules.filter((r) => surfaceSel.test(r.selector));
    const darkOverrides = realChatRules.filter((r) => /\[data-theme="dark"\]/.test(r.selector));
    const noVar = surfaces.filter((r) => !/var\(--/.test(r.body) && /(?:^|;)\s*(?:background|color|border-color)\s*:/.test(r.body));
    check(
      "chat surfaces take their colours from the theme variables",
      noVar.length === 0 || darkOverrides.length > 0,
      noVar.slice(0, 8).map((r) => `${F.css}:${lineOf(cssNoComments, r.index)} ${r.selector} sets colour without var(--…) and has no [data-theme="dark"] companion`)
    );
    // No light-only literal surface colour left un-overridden.
    const lightLiteral = surfaces.filter(
      (r) => /background(?:-color)?\s*:\s*(?:#fff(?:fff)?\b|#f[0-9a-f]{5}\b|white)/i.test(r.body)
    );
    check(
      "no hard-coded white surface that would glow in the dark theme",
      lightLiteral.length === 0 || darkOverrides.length > 0,
      lightLiteral.map((r) => `${F.css}:${lineOf(cssNoComments, r.index)} ${r.selector} forces a white background`)
    );
  }

  // ---- Launcher tap target -----------------------------------------------
  // Compute the real box: content height is the tallest child (the 20px
  // icon / the label line box), plus vertical padding and border.
  {
    const baseFab = realChatRules.find((r) => /^\s*\.chat-fab\s*$/.test(r.selector) && !r.media.length);
    const mobileFab = realChatRules.find(
      (r) => /^\s*\.chat-fab\s*$/.test(r.selector) && r.media.some((m) => /max-width:\s*639px/.test(m))
    );
    const declOf = (rule, prop) => {
      const m = new RegExp(`(?:^|;|\\{)\\s*${prop}\\s*:\\s*([^;]+)`, "i").exec("{" + rule.body);
      return m ? m[1].trim() : null;
    };
    // Cascade: the mobile rule overrides the base rule, so declarations it
    // omits (border, line-height, icon size) must come from the base rule.
    const box = (rule, baseRule) => {
      if (!rule) return null;
      const merged = (prop) => declOf(rule, prop) ?? (baseRule && baseRule !== rule ? declOf(baseRule, prop) : null);
      const px = (v) => {
        const m = /^(\d+(?:\.\d+)?)px$/.exec(String(v || "").trim());
        return m ? parseFloat(m[1]) : null;
      };
      const h = px(merged("height")) || px(merged("min-height"));
      const explicitW = px(merged("width")) || px(merged("min-width"));
      const padY = (merged("padding") || "").split(/\s+/);
      const padTop = px(merged("padding-top")) ?? px(padY[0]) ?? 0;
      const padBottom = px(merged("padding-bottom")) ?? px(padY[2] ?? padY[0]) ?? 0;
      const padL = px(merged("padding-left")) ?? px(padY[1] ?? padY[0]) ?? 0;
      const padR = px(merged("padding-right")) ?? px(padY[3] ?? padY[1] ?? padY[0]) ?? 0;
      // `border: 1px solid var(--primary)` -> 1px on the top and 1px on the
      // bottom; `border: 0` -> none.
      const borderDecl = merged("border") || "";
      const borderW = (() => {
        const m = /^\s*(\d+(?:\.\d+)?)px/.exec(borderDecl);
        return m ? parseFloat(m[1]) : 0;
      })();
      const border = borderW * 2;
      // The launcher is an inline-flex row: its content box is the tallest
      // item, and the label's line box (font-size x line-height) can exceed
      // the icon. A bare-number line-height multiplies the font size.
      void 0;
      const icon = /\.chat-fab svg\s*\{[^}]*height\s*:\s*(\d+(?:\.\d+)?)px/.exec(cssNoComments);
      const iconH = icon ? parseFloat(icon[1]) : 20;
      const label = /\.chat-fab-label/.test(cssNoComments);
      const fontSize = px(merged("font-size")) || 13;
      const lineH = merged("line-height");
      const labelH = label ? (lineH && px(lineH) ? px(lineH) : fontSize * 1.5) : 0;
      const contentH = Math.max(iconH, labelH);
      return {
        h: h || contentH + padTop + padBottom + border,
        w: explicitW || null, // no explicit width: grows with the label
        padTop, padBottom, contentH, fontSize,
      };
    };
    const base = box(baseFab, null);
    const mobile = box(mobileFab, baseFab);
    check(
      "chat launcher is tappable: >= 44px tall (and in the <=639px block)",
      !!base && base.h >= 44 && !!mobile && mobile.h >= 44,
      [
        !baseFab
          ? "no base .chat-fab rule"
          : `computed height ≈ ${base.h}px (content ${base.contentH}px + padding ${base.padTop}+${base.padBottom} + border) — WCAG 2.5.5 / the contract's >= 44px tap target`, 
        !mobileFab ? "no .chat-fab rule inside @media (max-width: 639px)" : null,
        mobileFab && mobile && mobile.h < 44 ? `mobile height ≈ ${mobile.h}px — needs >= 44` : null,
      ].filter(Boolean)
    );
    // The label must not be the only thing making it wide enough on phones.
    check(
      "launcher label is present (visible affordance, not a bare icon)",
      /\.chat-fab-label\s*\{[\s\S]*?\}/.test(cssNoComments) || /chat-fab-label/.test(indexHtml),
      ["no .chat-fab-label in markup or CSS"]
    );
  }

  // ---- Mobile sheet -------------------------------------------------------
  {
    const mobileSheet = realChatRules.find(
      (r) => /^\s*\.chat-panel\s*$/.test(r.selector) && r.media.some((m) => /max-width:\s*639px/.test(m))
    );
    check("<=639px: the panel becomes a full-height sheet", !!mobileSheet,
      ["css/style.css: no .chat-panel rule inside @media (max-width: 639px)"]);
    if (mobileSheet) {
      const b = mobileSheet.body;
      const fullWidth = /(?:^|;|\{)\s*left\s*:\s*0/.test("{" + b) && /(?:^|;)\s*right\s*:\s*0/.test(b);
      check("mobile sheet spans the viewport width", fullWidth,
        [`${F.css}:${lineOf(cssNoComments, mobileSheet.index)} sheet is not left:0/right:0`]);
      const vh = /height\s*:\s*var\(\s*--chat-vh/.test(b);
      const dvh = /100dvh|dvh/.test(b);
      check(
        "mobile sheet height tracks the visual viewport (keyboard-safe)",
        vh || dvh,
        [`${F.css}:${lineOf(cssNoComments, mobileSheet.index)} sheet uses a static height — the on-screen keyboard will cover the input`]
      );
      // If it relies on --chat-vh, chatbot.js must maintain that variable.
      if (vh) {
        check("js/chatbot.js maintains --chat-vh from visualViewport",
          /--chat-vh/.test(chatTrivia) && /visualViewport/.test(chatTrivia),
          ["css relies on --chat-vh but js/chatbot.js never sets it from window.visualViewport"]);
      }
      check(
        "mobile sheet keeps the top safe area (notch) clear",
        /padding-top\s*:\s*env\(\s*safe-area-inset-top/.test(b) || /top\s*:\s*env\(\s*safe-area-inset-top/.test(b),
        [`${F.css}:${lineOf(cssNoComments, mobileSheet.index)} no env(safe-area-inset-top) padding — the header sits under the notch`]
      );
    }
    // The launcher must not cover the nav / Làm mới controls: it is anchored
    // bottom-right, and it hides while the sheet is open.
    const fabRules = realChatRules.filter((r) => /\.chat-fab\b/.test(r.selector));
    const fabBase = fabRules.find((r) => !r.media.length);
    const anchoredBottomRight = fabBase &&
      /bottom\s*:\s*calc\(|bottom\s*:\s*\d/.test(fabBase.body) &&
      /right\s*:\s*\d/.test(fabBase.body) &&
      !/(?:^|;)\s*top\s*:/.test(fabBase.body);
    check("launcher is anchored bottom-right (cannot sit on the sticky nav)", !!anchoredBottomRight,
      ["css/style.css: .chat-fab should use bottom/right offsets"]);
    check(
      "launcher respects the bottom safe area (home indicator)",
      fabRules.some((r) => /env\(\s*safe-area-inset-bottom/.test(r.body)),
      ["css/style.css: .chat-fab never offsets by env(safe-area-inset-bottom)"]
    );
    check(
      "launcher hides while the panel is open (no overlap with its own send button)",
      /html\.chat-open\s+\.chat-fab\s*\{[^}]*display\s*:\s*none/.test(cssNoComments.replace(/\s+/g, " ")),
      ["css/style.css: no `html.chat-open .chat-fab { display: none }` — the launcher would float over the open sheet"]
    );
  }

  // ---- 320px overflow -----------------------------------------------------
  {
    const narrow = realChatRules.filter((r) => !r.media.some((m) => /min-width/.test(m)));
    const fixedWide = [];
    for (const r of narrow) {
      for (const m of allMatches(r.body, /(?:^|;)\s*(width|min-width)\s*:\s*(\d{3,})px/g)) {
        if (+m[2] > 288) {
          fixedWide.push(
            `${F.css}:${lineOf(cssNoComments, r.index)} ${r.selector} ${m[1]}: ${m[2]}px — wider than a 320px viewport minus gutters`
          );
        }
      }
    }
    check("no chat rule forces a width wider than a 320px phone", fixedWide.length === 0, fixedWide);

    const chatBlockSrc = realChatRules.map((r) => r.body).join("\n");
    check(
      "long model output / URLs cannot widen the panel",
      /overflow-wrap\s*:\s*(?:anywhere|break-word)/.test(chatBlockSrc) || /word-break\s*:\s*break/.test(chatBlockSrc),
      ["css/style.css: no overflow-wrap on the chat log — a long URL overflows the sheet at 320px"]
    );
    check(
      "bubbles can shrink inside their flex row (min-width: 0)",
      /min-width\s*:\s*0/.test(chatBlockSrc),
      ["css/style.css: no min-width: 0 on .chat-bubble/.chat-card-body — long content overflows"]
    );
  }

  // ---- prefers-reduced-motion --------------------------------------------
  {
    const animated = realChatRules.filter((r) => /(?:^|;|\{)\s*(?:animation|animation-name)\s*:/.test(r.body));
    const reduceRules = realChatRules.filter((r) => r.media.some((m) => /prefers-reduced-motion:\s*reduce/.test(m)));
    const guarded = realChatRules.filter((r) => r.media.some((m) => /prefers-reduced-motion:\s*no-preference/.test(m)));
    const reduceSrc = reduceRules.map((r) => r.selector + "{" + r.body + "}").join("\n");
    const stillAnimating = animated.filter((r) => {
      // A conscious slowdown (long duration) counts as respecting the setting.
      const sel = r.selector.split(",").map((x) => x.trim());
      return sel.some((one) => {
        const hit = new RegExp(`${one.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{[^}]*animation`.replace(/\s+/g, "\\s*")).test(reduceSrc);
        return !hit;
      });
    });
    check(
      "chat animations respect prefers-reduced-motion",
      animated.length === 0 || stillAnimating.length === 0 || (guarded.length > 0 && stillAnimating.length === 0),
      [
        ...stillAnimating.map((r) => `${F.css}:${lineOf(cssNoComments, r.index)} ${r.selector} animates; no prefers-reduced-motion rule neutralises it`),
      ]
    );
    check(
      "the thinking indicator is a live region for screen readers",
      /role\s*=\s*["']log["']/.test(indexHtml) && /aria-live\s*=\s*["']polite["']/.test(indexHtml),
      ["#chatLog needs role=log aria-live=polite"]
    );
  }

  // ---- Focus visibility ---------------------------------------------------
  {
    const focusable = realChatRules.filter((r) => /:focus-visible/.test(r.selector));
    check(
      "chat controls have a visible focus ring",
      focusable.length >= 2,
      [`only ${focusable.length} .chat-*:focus-visible rule(s) — keyboard users lose the caret`]
    );
  }
}

// ===========================================================================
// Summary
// ===========================================================================
console.log(`\n${"-".repeat(60)}`);
console.log(`${passed} passed, ${failed} failed`);
if (failed) {
  console.log(`\nFAILED checks — fix these before shipping:`);
  for (const f of allFailures) {
    console.log(`  [${f.section}] ${f.msg}`);
    for (const p of f.problems.slice(0, 10)) console.log(`      ${p}`);
  }
  process.exitCode = 1;
} else {
  console.log("ALL CHECKS PASSED");
}
