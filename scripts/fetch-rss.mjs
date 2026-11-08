#!/usr/bin/env node
/**
 * Fetch VnExpress RSS feeds and write normalized JSON snapshots to
 * data/<slug>.json so the GitHub Pages site can read same-origin data
 * (no CORS, no third-party rate limits). The public proxies stay as a
 * client-side fallback only.
 *
 * Run by .github/workflows/fetch-rss.yml every 30 minutes, or locally:
 *   node scripts/fetch-rss.mjs
 */
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

const FEED_BASE = "https://vnexpress.net/rss/";
const FEEDS = [
  "tin-moi-nhat",
  "thoi-su",
  "the-gioi",
  "kinh-doanh",
  "bat-dong-san",
  "the-thao",
  "giai-tri",
  "suc-khoe",
  "giao-duc",
  "du-lich",
  "phap-luat",
];

function decodeEntities(s) {
  // Entities can be nested ("&amp;amp;") when the feed escapes an already
  // escaped body - peel at most two layers so text stays faithful.
  let out = String(s || "");
  for (let i = 0; i < 2 && /&[#a-zA-Z]/.test(out); i++) {
    const next = out
      .replace(/&#[xX]([0-9a-fA-F]+);/g, (_, h) => safeFromCp(parseInt(h, 16), _))
      .replace(/&#(\d+);/g, (m, d) => safeFromCp(parseInt(d, 10), m))
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&nbsp;/g, "\u00a0")
      .replace(/&ndash;/g, "\u2013")
      .replace(/&mdash;/g, "\u2014")
      .replace(/&lsquo;|&rsquo;/g, (m) => (m === "&lsquo;" ? "\u2018" : "\u2019"))
      .replace(/&ldquo;|&rdquo;/g, (m) => (m === "&ldquo;" ? "\u201c" : "\u201d"))
      .replace(/&hellip;/g, "\u2026");
    if (next === out) break;
    out = next;
  }
  return out;
}

function safeFromCp(cp, fallback) {
  if (!cp || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return fallback;
  try {
    return String.fromCodePoint(cp);
  } catch {
    return fallback;
  }
}

function stripTags(html) {
  return decodeEntities(String(html || "").replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function firstGroup(re, s) {
  const m = re.exec(s);
  return m ? m[1] : "";
}

// VnExpress item shape mirrors the client-side parser in js/app.js:
// {title, link, pubDate(ms), img, sapo}
function parseRss(xml) {
  const items = [];
  const blocks = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  for (const b of blocks) {
    const title = stripTags(
      firstGroup(/<title>([\s\S]*?)<\/title>/, b).replace(
        /<!\[CDATA\[([\s\S]*?)\]\]>/g,
        "$1"
      )
    );
    const link = decodeEntities(firstGroup(/<link>([\s\S]*?)<\/link>/, b));
    const pubDateRaw = firstGroup(/<pubDate>([\s\S]*?)<\/pubDate>/, b);
    const pubDate = Date.parse(pubDateRaw) || Date.now();
    const desc = firstGroup(
      /<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/,
      b
    );
    // description CDATA = '<a href=...><img src=...></a></br> lead text'
    const imgFromDesc = decodeEntities(
      firstGroup(/<img[^>]+src=["']([^"']+)["']/, desc)
    );
    const enclosure = decodeEntities(
      firstGroup(/<enclosure[^>]*url=["']([^"']+)["']/, b)
    );
    const sapo = stripTags(
      String(desc).replace(/<a[\s\S]*?<\/a>/gi, "")
    ).slice(0, 220);
    if (!title || !/^https:\/\//.test(link)) continue;
    items.push({
      title,
      link,
      pubDate,
      img: /^https:\/\//.test(enclosure) ? enclosure : imgFromDesc,
      sapo,
    });
  }
  return items;
}

async function fetchFeed(slug) {
  const res = await fetch(FEED_BASE + slug + ".rss", {
    headers: { "User-Agent": UA, Accept: "application/rss+xml, */*" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${slug}`);
  const items = parseRss(await res.text());
  if (items.length < 5) throw new Error(`only ${items.length} items in ${slug}`);
  return items;
}

async function main() {
  const outDir = path.join(process.cwd(), "data");
  await mkdir(outDir, { recursive: true });
  let failed = [];
  for (const slug of FEEDS) {
    try {
      const items = await fetchFeed(slug);
      const payload = { fetchedAt: Date.now(), items };
      await writeFile(
        path.join(outDir, `${slug}.json`),
        JSON.stringify(payload),
        "utf-8"
      );
      console.log(`OK ${slug}: ${items.length} items`);
    } catch (e) {
      console.error(`FAIL ${slug}: ${e.message}`);
      failed.push(slug);
    }
  }
  if (failed.length === FEEDS.length) {
    // total outage - do not wipe good data, exit non-zero so the
    // workflow shows red and keeps the previous snapshot
    process.exit(1);
  }
}

main();
