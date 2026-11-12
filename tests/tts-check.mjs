#!/usr/bin/env node
/**
 * Static acceptance checks for read-aloud (TTS).
 *
 *   node tests/tts-check.mjs            # offline checks only
 *   node tests/tts-check.mjs --online   # also calls the live ViFastTts API
 *
 * Dependency-free on purpose (node:fs + regex scans) — this repo has no
 * build step and no npm packages. Prints one PASS/FAIL line per check and
 * exits 1 when anything fails.
 *
 * What it covers:
 *   1. The two pages ship the same TTS controls (button + speed + dialect)
 *      and pin identical asset versions.
 *   2. Every element js/app.js looks up exists in both pages.
 *   3. The engine chain is wired the documented way: ViFastTts first,
 *      Google Translate as fallback, both through the shared <audio> path.
 *   4. The proxy URL is well-formed and matches the documented one.
 *   5. No TTS setting is persisted outside the news24:* namespace, and no
 *      API key / secret is written into js/app.js.
 *   6. The summary splitter still satisfies its invariant (chunks join back
 *      to the input) — that is what keeps the Google fallback lossless.
 *   7. --online: the demo API answers /healthz, /api/config and /api/tts
 *      through the proxy, returning real WAV bytes.
 *
 * Node 18+ (fetch for --online). No DOM.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf-8");

const PAGES = ["index.html", "404.html"];
const APP_JS = "js/app.js";
const app = read(APP_JS);
const pages = Object.fromEntries(PAGES.map((p) => [p, read(p)]));

// ---------------------------------------------------------------------------
// Tiny harness (same shape as tests/chat-check.mjs)
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;

function section(title) {
  console.log(`\n== ${title}`);
}
function pass(msg) {
  passed++;
  console.log(`PASS  ${msg}`);
}
function fail(msg, problems = []) {
  failed++;
  console.log(`FAIL  ${msg}`);
  for (const p of problems.slice(0, 20)) console.log(`        ${p}`);
}
function check(ok, msg, problems = []) {
  if (ok) pass(msg);
  else fail(msg, problems);
}

// Strip JS comments so "this is what the code does" checks do not trip over
// documentation that mentions the same identifiers.
const code = app
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

// ---------------------------------------------------------------------------
// 1. Markup: both pages expose the same three controls
// ---------------------------------------------------------------------------
section("1. TTS controls exist in both pages");

for (const id of ["ttsBtn", "ttsRateBtn", "ttsVoiceBtn"]) {
  const counts = PAGES.map((p) => ({
    page: p,
    n: (pages[p].match(new RegExp(`id="${id}"`, "g")) || []).length,
  }));
  check(
    counts.every((c) => c.n === 1),
    `#${id} appears exactly once in each page`,
    counts.map((c) => `${c.page}: ${c.n} occurrence(s)`)
  );
}

// The picker's closed label must match the default voice, or the control
// lies about which voice will be used before js/app.js runs.
for (const p of PAGES) {
  check(
    /id="ttsVoiceBtn"[^>]*>[^<]*Google Dịch/.test(pages[p]),
    `${p}: #ttsVoiceBtn ships labelled with the default voice (Google Dịch)`
  );
  const rows = [...pages[p].matchAll(/data-voice="([^"]+)"/g)].map((m) => m[1]);
  check(
    rows.length === 2 && rows[0] === "google" && rows[1] === "vifast",
    `${p}: the picker lists exactly google + vifast, google first`,
    [`rows: ${rows.join(", ") || "(none)"}`]
  );
  check(
    /data-voice="google"[^>]*aria-checked="true"/.test(pages[p]),
    `${p}: Google Dịch is pre-checked in markup`
  );
}

// ---------------------------------------------------------------------------
// 2. Every element js/app.js looks up exists in both pages
// ---------------------------------------------------------------------------
section("2. js/app.js element lookups resolve in both pages");

const lookups = [...code.matchAll(/getElementById\("([^"]+)"\)/g)].map((m) => m[1]);
const ttsLookups = ["ttsBtn", "ttsRateBtn", "ttsVoiceBtn", "ttsVoiceMenu"].filter((id) =>
  lookups.includes(id)
);
check(
  ttsLookups.length === 4,
  "app.js looks up all three TTS controls",
  [`found: ${ttsLookups.join(", ") || "(none)"}`]
);
for (const p of PAGES) {
  const missing = lookups.filter((id) => !pages[p].includes(`id="${id}"`));
  const ttsMissing = missing.filter((id) => /^tts/.test(id));
  check(ttsMissing.length === 0, `${p}: no missing TTS element ids`, ttsMissing);
}

// ---------------------------------------------------------------------------
// 3. Engine chain: ViFastTts first, Google as fallback
// ---------------------------------------------------------------------------
section("3. Engine chain and playback path");

// Default voice must be Google Translate, and the picker order is the list.
check(/const TTS_DEFAULT_VOICE = "google"/.test(code), "default voice is Google Translate");
check(
  /const TTS_VOICES = \[\s*\{ id: "google"/.test(code),
  "TTS_VOICES is the single source of truth for the picker"
);
check(
  /function ttsVoiceOrder\(\)/.test(code) &&
    /\[ttsVoice, \.\.\.TTS_VOICES/.test(code),
  "playback tries the chosen voice first, then the other one"
);

check(
  /const VFTTS = "https:\/\/tts\.vifast\.org"/.test(code),
  "ViFastTts base URL points at tts.vifast.org"
);

check(
  /const TTS_PROXY = "https:\/\/cors\.rin2401\.workers\.dev\/"/.test(code),
  "the CORS proxy is the documented Cloudflare worker"
);

check(/const GTTS = "https:\/\/translate\.googleapis\.com\/translate_tts/.test(code),
  "Google Translate TTS is still the fallback endpoint");

// ViFastTts must be reached through the proxy, never directly (no ACAO).
check(
  /TTS_PROXY \+ VFTTS \+ "\/api\/tts"/.test(code),
  "ViFastTts request URL is proxy + origin + /api/tts"
);
// Every occurrence of the origin constant must be part of the proxied URL
// (plus its declaration), i.e. nothing builds a bare VFTTS request.
const originUses = [...code.matchAll(/(?:TTS_PROXY \+ )?VFTTS(\s*\+\s*"\/api\/[^"]*")?/g)]
  .map((m) => m[0])
  .filter((s) => !s.startsWith("TTS_PROXY"));
const unproxied = originUses.filter((s) => s !== "VFTTS" || false);
check(
  unproxied.length === 0 || originUses.every((s) => s.startsWith("TTS_PROXY")),
  "no direct (un-proxied) request to the ViFastTts origin",
  originUses
);

// The response must be checked before playback: a proxy error page is HTML.
check(
  /\/\^audio\\\/\/i\.test\(blob\.type\)/.test(code),
  "the ViFastTts response is validated as audio/* before playing"
);

// Both engines must play through one shared element (speed + stop semantics).
check(
  /function playClip\(src, token\)/.test(code) && /tts\.audio \|\| new Audio\(\)/.test(code),
  "both engines play through the shared <audio> element"
);

// Stop must revoke the object URL so a long session does not leak clips.
check(
  /URL\.revokeObjectURL\(ttsUrl\)/.test(code),
  "stopTts() revokes the blob URL"
);

// A 429 must be remembered for the session, not retried on every click.
check(
  /vifastQuotaExhausted = true/.test(code) &&
    /engine === "vifast" && vifastQuotaExhausted\) continue/.test(code),
  "a 429 from ViFastTts is remembered and skipped for the session"
);

// Playback unlock errors must not silently fall through to the second engine.
check(
  /NotAllowedError/.test(code) && /AbortError/.test(code),
  "user-gesture / abort errors are not masked by the fallback"
);

// ---------------------------------------------------------------------------
// 4. Settings: persisted, namespaced, and in sync across pages
// ---------------------------------------------------------------------------
section("4. Persisted settings");

const keys = [...code.matchAll(/localStorage\.(?:get|set)Item\("([^"]+)"/g)].map((m) => m[1]);
const badKeys = [...new Set(keys)].filter((k) => !k.startsWith("news24:"));
check(badKeys.length === 0, "every localStorage key is in the news24: namespace", badKeys);

check(keys.includes("news24:ttsrate"), "reading speed is persisted (news24:ttsrate)");
check(keys.includes("news24:ttsvoice"), "the chosen voice is persisted (news24:ttsvoice)");

// Both pages must pin the same versions, or one of them loads stale code.
for (const v of ["app.js", "style.css", "chatbot.js"]) {
  const pins = PAGES.map((p) => {
    const m = new RegExp(`${v.replace(".", "\\.")}\\?v=([0-9a-z]+)`).exec(pages[p]);
    return { page: p, v: m ? m[1] : null };
  });
  check(
    pins.every((x) => x.v) && pins[0].v === pins[1].v,
    `${v} is pinned to the same version in both pages`,
    pins.map((x) => `${x.page}: ${x.v}`)
  );
}

// A version bump must actually change the URL, or the edge cache serves the
// previous app.js and the new UI silently does nothing.
const appPin = /app\.js\?v=(\d+)/.exec(pages["index.html"]);
check(appPin && Number(appPin[1]) >= 48, "app.js pin was bumped for this release", [
  `pin is ${appPin ? appPin[1] : "(missing)"}`,
]);
const cssPin = /style\.css\?v=(\d+)/.exec(pages["index.html"]);
check(cssPin && Number(cssPin[1]) >= 40, "style.css pin was bumped for the picker styles", [
  `pin is ${cssPin ? cssPin[1] : "(missing)"}`,
]);

// ---------------------------------------------------------------------------
// 5. No secrets, no inline keys
// ---------------------------------------------------------------------------
section("5. Secrets");

const secretish = [
  /sk-[A-Za-z0-9]{16,}/,
  /AIza[0-9A-Za-z_-]{30,}/,
  /ghp_[A-Za-z0-9]{20,}/,
];
const hits = secretish.filter((re) => re.test(app));
check(hits.length === 0, "no API keys committed in js/app.js", hits.map(String));

// ---------------------------------------------------------------------------
// 6. Splitter invariant (keeps the Google fallback lossless)
// ---------------------------------------------------------------------------
section("6. Summary splitter invariant");

// Pull the splitter out of app.js and exercise it with the same constants.
const TTS_MAX = Number(/TTS_MAX = (\d+)/.exec(code)?.[1] ?? NaN);
check(Number.isFinite(TTS_MAX) && TTS_MAX <= 195, `TTS_MAX is set and <= 195 (${TTS_MAX})`);

// The splitter block starts at TTS_MAX (declared just above the helpers)
// and ends where the first engine implementation begins.
const startOf = code.indexOf("const TTS_MAX =");
const endOf = code.indexOf("async function fetchViFastTts");
check(startOf > 0 && endOf > startOf, "splitter helpers are locatable in app.js");

if (startOf > 0 && endOf > startOf) {
  const src = code.slice(startOf, endOf);
  const factory = new Function(
    `${src}\nreturn { ttsChunks };`
  );
  let splitter;
  try {
    splitter = factory();
  } catch (e) {
    fail("splitter evaluates standalone", [String(e)]);
  }
  if (splitter) {
    pass("splitter evaluates standalone");
    const cases = [
      "Giá vàng trong nước tăng mạnh trong phiên sáng nay. Nhiều cửa hàng điều chỉnh lên mức cao nhất ba tháng.",
      "Ông Nguyễn Văn A, GS.TS đầu ngành, cho biết tỷ lệ tăng trưởng đạt 4,5-5% GDP. Đây là mức cao nhất kể từ năm 2021.",
      "Một câu rất dài " + "với nhiều mệnh đề nối tiếp nhau ".repeat(30) + "và kết thúc ở đây.",
      "Câu ngắn. " + "Từ ".repeat(200),
    ];
    const norm = (s) => s.replace(/\s+/g, " ").trim();
    const broken = [];
    for (const c of cases) {
      const chunks = splitter.ttsChunks(c);
      if (chunks.join(" ") !== norm(c)) broken.push("join mismatch: " + c.slice(0, 40) + "…");
      if (chunks.some((x) => x.length > TTS_MAX)) broken.push("chunk over TTS_MAX: " + c.slice(0, 40) + "…");
    }
    check(broken.length === 0, "chunks join back to the input and none exceed TTS_MAX", broken);
  }
}

// ---------------------------------------------------------------------------
// 7. Optional live probe
// ---------------------------------------------------------------------------
if (process.argv.includes("--online")) {
  section("7. Live ViFastTts API (through the proxy)");
  const PROXY = /const TTS_PROXY = "([^"]+)"/.exec(code)?.[1];
  const ORIGIN = /const VFTTS = "([^"]+)"/.exec(code)?.[1];
  if (!PROXY || !ORIGIN) {
    fail("proxy/origin constants are readable from app.js");
  } else {
    const base = PROXY + ORIGIN;
    try {
      const health = await fetch(base + "/healthz").then((r) => r.json());
      check(health && health.ok === true, `/healthz reports ok (arch ${health.arch})`);

      const cfg = await fetch(base + "/api/config").then((r) => r.json());
      check(
        Number.isFinite(cfg.max_chars) && Number.isFinite(cfg.rate_limit),
        `/api/config reports max_chars=${cfg.max_chars}, rate_limit=${cfg.rate_limit}/` +
          `${cfg.rate_window}s`,
        []
      );

      const res = await fetch(base + "/api/tts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "Xin chào, đây là bản tin hôm nay.", speed: 1, dialect: "north" }),
      });
      const type = res.headers.get("content-type") || "";
      const buf = Buffer.from(await res.arrayBuffer());
      const isWav = buf.length > 44 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WAVE";
      check(res.ok && isWav && /audio\/wav/.test(type),
        `POST /api/tts returns a WAV (${buf.length} bytes, ${type})`,
        [`status ${res.status}`]);
    } catch (e) {
      fail("live API reachable through the proxy", [String(e)]);
    }
  }
}

// ---------------------------------------------------------------------------
console.log("\n" + "-".repeat(60));
console.log(`${passed} passed, ${failed} failed`);
if (failed) {
  console.log("SOME CHECKS FAILED");
  process.exit(1);
}
console.log("ALL CHECKS PASSED");
