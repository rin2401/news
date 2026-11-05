#!/usr/bin/env node
// News24 MCP server — zero-dependency, stdio JSON-RPC 2.0 (MCP).
//
// Tools:
//   list_news(category?, limit?)  — headlines from the same-origin
//                                   snapshots the GitHub Action refreshes
//                                   every 30 min (data/<slug>.json)
//   read_article(url)             — full article text, fetched DIRECTLY from
//                                   vnexpress.net with a browser UA. No CORS
//                                   and no public-proxy chain server-side,
//                                   so this is far more reliable than the
//                                   browser-side reader.
//   search_news(query, limit?)    — title/sapo search across all categories
//
// Path resolution is based on import.meta.url (NOT cwd) so the server runs
// from any working directory — including MCP clients that spawn it from
// elsewhere. Only stdlib is used: no npm install, clone-and-run.

import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DATA_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "data"
);

// VnExpress serves its 404 page to bot User-Agents (see fetch-rss.mjs)
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

const SERVER_INFO = { name: "news24", version: "1.0.0" };

// ---- data layer ----

async function readFeed(slug) {
  const file = path.join(DATA_DIR, slug + ".json");
  if (!existsSync(file)) return null;
  try {
    const { fetchedAt, items } = JSON.parse(await readFile(file, "utf8"));
    return { slug, fetchedAt, items: items || [] };
  } catch {
    return null;
  }
}

async function categoryList() {
  try {
    return (await readdir(DATA_DIR))
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -5));
  } catch {
    return [];
  }
}

async function listNews({ category = "tin-moi-nhat", limit = 20 } = {}) {
  const cats = await categoryList();
  let feeds = [];
  if (category && category !== "all") {
    const one = await readFeed(category);
    if (!one) {
      throw new Error(
        `unknown category "${category}". Available: ${cats.join(", ")}, all`
      );
    }
    feeds = [one];
  } else {
    feeds = (await Promise.all(cats.map(readFeed))).filter(Boolean);
  }
  const rows = feeds.flatMap((f) =>
    f.items.map((it) => ({
      title: it.title,
      link: it.link,
      pubDate: new Date(it.pubDate).toISOString(),
      category: f.slug,
      sapo: it.sapo || "",
    }))
  );
  rows.sort((a, b) => b.pubDate.localeCompare(a.pubDate));
  const n = Math.max(1, Math.min(100, Math.trunc(limit) || 20));
  return {
    categories: cats,
    snapshotAgeMin: feeds.length
      ? Math.round((Date.now() - Math.max(...feeds.map((f) => f.fetchedAt || 0))) / 60000)
      : null,
    count: rows.length,
    items: rows.slice(0, n),
  };
}

async function searchNews({ query, limit = 10 } = {}) {
  const q = String(query || "").toLowerCase().trim();
  if (!q) throw new Error("query is required");
  const cats = await categoryList();
  const feeds = (await Promise.all(cats.map(readFeed))).filter(Boolean);
  const hits = feeds.flatMap((f) =>
    f.items
      .filter(
        (it) =>
          (it.title || "").toLowerCase().includes(q) ||
          (it.sapo || "").toLowerCase().includes(q)
      )
      .map((it) => ({
        title: it.title,
        link: it.link,
        pubDate: new Date(it.pubDate).toISOString(),
        category: f.slug,
        sapo: it.sapo || "",
      }))
  );
  hits.sort((a, b) => b.pubDate.localeCompare(a.pubDate));
  const n = Math.max(1, Math.min(50, Math.trunc(limit) || 10));
  return { query, count: hits.length, items: hits.slice(0, n) };
}

// ---- article full text (server-side: no CORS, browser UA is enough) ----

const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
  nbsp: " ", hellip: "…", laquo: "«", raquo: "»", ndash: "–", mdash: "—",
};

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<(script|style|iframe|form|svg)[\s\S]*?<\/\1>/gi, "")
      // block enders start a new paragraph of plain text
      .replace(/<\/(p|h[1-6]|li|blockquote|figcaption|tr|span|div)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, "")
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function tagText(html, re) {
  const m = html.match(re);
  return m ? htmlToText(m[1]).replace(/\s+/g, " ").trim() : "";
}

function articleUrl(input) {
  let u = String(input || "").trim();
  if (!u) throw new Error("url is required");
  if (!/^https?:\/\//i.test(u)) {
    u = u.replace(/^\/+/, "");
    if (!/^[a-z0-9-]+-\d+\.html?$/i.test(u) && !/\/[a-z0-9-]+-\d+\.html?$/i.test(u)) {
      throw new Error("expected a VnExpress article URL or <slug>-<id>.html");
    }
    u = "https://vnexpress.net/" + u;
  }
  if (!/^https:\/\/vnexpress\.net\//i.test(u)) {
    throw new Error("only vnexpress.net articles are supported");
  }
  return u;
}

async function readArticle({ url } = {}) {
  const link = articleUrl(url);
  const res = await fetch(link, {
    headers: { "user-agent": BROWSER_UA, "accept-language": "vi,en;q=0.9" },
    redirect: "follow",
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`vnexpress.net HTTP ${res.status} for ${link}`);
  const html = await res.text();

  // .fck_detail is the article <article> container; it closes with the
  // page's first </article>. The real markup is <article class="fck_detail ">
  // (trailing space — do NOT match an exact 'class="fck_detail"' string).
  // Quiz/poll templates embed a client-side widget placeholder there
  // instead of static text (see js/app.js).
  const openTag = html.match(/<[a-z0-9]+\b[^>]*\bclass="[^"]*\bfck_detail\b[^"]*"[^>]*>/i);
  let fck = null;
  if (openTag) {
    const start = openTag.index + openTag[0].length;
    const end = html.indexOf("</article>", start);
    fck = html.slice(start, end === -1 ? start + 100000 : end);
  }
  if (!fck) throw new Error("article body (.fck_detail) not found — VnExpress layout may have changed");

  const title = tagText(html, /<h1[^>]*class="[^"]*title-detail[^"]*"[^>]*>([\s\S]*?)<\/h1>/i)
    || tagText(html, /<title>([\s\S]*?)<\/title>/i).replace(/ - Báo VnExpress$/, "");
  const sapo = tagText(fck, /<p[^>]*class="[^"]*description[^"]*"[^>]*>([\s\S]*?)<\/p>/i);

  if (/data-component-type|data-widget=/i.test(fck) && htmlToText(fck).length < 200) {
    return {
      title,
      link,
      sapo,
      interactive: true,
      note:
        "Interactive/quiz article: the body is rendered client-side by " +
        "VnExpress's own JavaScript and does not exist as static HTML. " +
        "Open the link in a browser to play it.",
    };
  }

  // the h1 title-detail lives inside .fck_detail; it's already returned
  // as `title`, don't duplicate it in the body text
  let text = htmlToText(fck.replace(/<h1[\s\S]*?<\/h1>/i, ""));
  if (text.length > 20000) {
    text = text.slice(0, 20000).replace(/\n[^\n]*$/, "") + "\n…[truncated]";
  }
  if (text.length < 80) {
    throw new Error("article body too short — fetch may have been blocked or throttled");
  }
  return { title, link, sapo, chars: text.length, text };
}

// ---- MCP protocol (stdio, newline-delimited JSON-RPC 2.0) ----

const TOOLS = [
  {
    name: "list_news",
    description:
      "List recent VnExpress headlines from the News24 same-origin snapshots. " +
      "Returns title, link, pubDate, category and sapo (lead paragraph).",
    inputSchema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          description:
            "Category slug: tin-moi-nhat (default), thoi-su, the-gioi, " +
            "kinh-doanh, bat-dong-san, the-thao, giai-tri, suc-khoe, " +
            "giao-duc, du-lich, phap-luat — or \"all\" to merge every category.",
        },
        limit: { type: "integer", description: "Max items (1-100, default 20)" },
      },
    },
  },
  {
    name: "read_article",
    description:
      "Fetch and return the full plain-text body of a VnExpress article " +
      "(server-side fetch with a browser User-Agent — no proxy chain). " +
      "Returns title, sapo and the article text, or an interactive flag " +
      "for quiz/template articles whose body only exists client-side.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description:
            "Full article URL (https://vnexpress.net/<slug>-<id>.html) " +
            "or just the '<slug>-<id>.html' part.",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "search_news",
    description:
      "Search headlines and lead paragraphs across all categories of the " +
      "News24 snapshots (case-insensitive substring match).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search text (Vietnamese ok)" },
        limit: { type: "integer", description: "Max items (1-50, default 10)" },
      },
      required: ["query"],
    },
  },
];

const HANDLERS = { list_news: listNews, read_article: readArticle, search_news: searchNews };

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

async function dispatch(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params?.protocolVersion || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      },
    });
    return;
  }
  if (method === "notifications/initialized" || method.startsWith("notifications/")) {
    return; // notifications carry no response
  }
  if (method === "ping") {
    send({ jsonrpc: "2.0", id, result: {} });
    return;
  }
  if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    return;
  }
  if (method === "tools/call") {
    const name = params?.name;
    const handler = HANDLERS[name];
    if (!handler) {
      send({
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: `unknown tool "${name}"` },
      });
      return;
    }
    try {
      const result = await handler(params?.arguments || {});
      send({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          isError: false,
        },
      });
    } catch (err) {
      // tool failures are results (isError), not protocol errors
      send({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: String(err?.message || err) }],
          isError: true,
        },
      });
    }
    return;
  }
  if (id !== undefined) {
    send({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `method not found: ${method}` },
    });
  }
}

// newline-delimited JSON-RPC over stdio
let buf = "";
let pending = 0; // in-flight requests (tool calls hit the network)
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // skip malformed lines, never crash the transport
    }
    pending++;
    Promise.resolve(dispatch(msg))
      .catch((err) => {
        if (msg?.id !== undefined) {
          send({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32603, message: String(err?.message || err) },
          });
        }
        console.error(`[news24-mcp] ${err?.stack || err}`);
      })
      .finally(() => pending--);
  }
});
// a real MCP client keeps stdin open; on EOF (pipe closed) let in-flight
// requests finish (max ~15s) so `printf | node server` smoke tests
// still print their results before the process exits.
process.stdin.on("end", () => {
  const t0 = Date.now();
  (function drain() {
    if (pending <= 0 || Date.now() - t0 > 15000) process.exit(0);
    else setTimeout(drain, 100);
  })();
});
