#!/usr/bin/env node
/**
 * Guard against drift between the two copies of the stats markup:
 * stats.html (served as-is by hosts that know the file) and the
 * #viewStats section inside 404.html (what GitHub Pages serves for
 * /news/stats, since there is no such file in the built site).
 *
 *   node scripts/check-stats-view.mjs
 *
 * Exits 1 when the .stats-page markup or the chart tooltip differ apart
 * from indentation. Re-sync by copying the block from stats.html.
 */
import { readFile } from "node:fs/promises";

const here = new URL("../", import.meta.url);
const [stats, notFound] = await Promise.all([
  readFile(new URL("stats.html", here), "utf-8"),
  readFile(new URL("404.html", here), "utf-8"),
]);

function grab(html, re, what) {
  const m = re.exec(html);
  if (!m) throw new Error(`${what}: block not found`);
  return m[1];
}

const trim = (s) =>
  s
    .split("\n")
    .map((ln) => ln.trim())
    .filter(Boolean)
    .join("\n");

const pages = {
  "stats.html": {
    main: trim(
      grab(stats, /<main class="container stats-page">\n([\s\S]*?)\n  <\/main>/, "stats.html <main>")
    ),
    tip: trim(grab(stats, /(<div id="statsTip"[\s\S]*?<\/div>)/, "stats.html tooltip")),
  },
  "404.html": {
    main: trim(
      grab(notFound, /<section class="main-col" id="viewStats"[^>]*>\n([\s\S]*?)\n    <\/section>/, "404.html #viewStats")
    ),
    tip: trim(grab(notFound, /(<div id="statsTip"[\s\S]*?<\/div>)/, "404.html tooltip")),
  },
};

const problems = [];
for (const key of ["main", "tip"]) {
  const a = pages["stats.html"][key].split("\n");
  const b = pages["404.html"][key].split("\n");
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) {
      problems.push(
        `${key} line ${i + 1}:\n  stats.html: ${a[i]}\n  404.html:   ${b[i]}`
      );
    }
  }
}

if (problems.length) {
  console.error("stats markup drifted between stats.html and 404.html:\n");
  console.error(problems.slice(0, 10).join("\n"));
  if (problems.length > 10) console.error(`... and ${problems.length - 10} more`);
  process.exit(1);
}
console.log("OK stats.html and 404.html #viewStats are in sync");
