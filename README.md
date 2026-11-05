# News24 — GitHub Pages news reader (VnExpress RSS)

A static, dependency-free news site styled after VnExpress, served on
GitHub Pages. It pulls live headlines from the official
[VnExpress RSS](https://vnexpress.net/rss/tin-moi-nhat.rss) feeds in the
browser.

**Live:** <https://rin2401.github.io/news/>

## Features

- 11 categories: Tin mới nhất, Thời sự, Thế giới, Kinh doanh,
  Bất động sản, Thể thao, Giải trí, Sức khỏe, Giáo dục, Du lịch, Pháp luật
- VnExpress-style layout: featured story, thumbnail list, sidebar headlines
- **In-page reader**: click an article to read it right on the page — full
  text is fetched via [r.jina.ai](https://r.jina.ai) (HTML mode) with the RSS
  proxies as fallback, sanitized to a tag whitelist (scripts/styles/trackers
  stripped, lazy images resolved from `data-src`) and cached in memory
- Live search, "load more" paging, relative timestamps ("2 giờ trước")
- Dark mode toggle (persisted; respects `prefers-color-scheme`)
- 10-minute `localStorage` cache for instant navigation + offline fallback
- No build step, no dependencies — plain HTML/CSS/JS

## How it works

**Listings** read the same-origin snapshots in [`data/`](data/) —
`data/<slug>.json` files written by `scripts/fetch-rss.mjs`, which a
GitHub Action (`.github/workflows/fetch-rss.yml`) runs every 30 minutes
with a browser User-Agent (VnExpress blocks bot UAs). No CORS, no
third-party rate limits, survives public-proxy outages.

The **"Làm mới"** button and any missing snapshot fall back to a chain of
public CORS proxies in the browser:

1. `api.rss2json.com` (JSON wrapper; its `pubDate` is UTC and is
   converted back to local time; its CDATA is XML-escaped so `&amp;`
   entities are decoded back to `&`)
2. `api.allorigins.win/raw`
3. `api.codetabs.com/v1/proxy`
4. `corsproxy.io`

Article full text (in-page reader) goes through `r.jina.ai` with
`X-Return-Format: html` first, then the same proxy chain; the parsed
`.fck_detail` body is sanitized before rendering. Asset URLs carry a `?v=`
query that is bumped each release to defeat the 10-minute GitHub Pages
edge cache.

Each response is normalized into `{title, link, pubDate, img, sapo}` and
rendered client-side. All feed text is escaped; only `http(s)` image URLs
are allowed.

## Local development

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

(Opening `index.html` via `file://` also works, but caching behavior is
better over HTTP.)

## MCP server (for AI agents)

`scripts/mcp-server.mjs` is a **zero-dependency** MCP (Model Context
Protocol) server over stdio. It lets any MCP client — ZCode, Claude
Desktop, Claude Code, Cursor — read this site's news:

| Tool | What it does |
|---|---|
| `list_news(category?, limit?)` | Recent headlines from the `data/` snapshots (refreshed every 30 min by the GitHub Action) |
| `read_article(url)` | Full article **plain text**, fetched server-side **directly from vnexpress.net** with a browser User-Agent — no CORS, no public-proxy chain, no browser-side rate limits. Detects interactive/quiz articles whose body only exists client-side |
| `search_news(query, limit?)` | Case-insensitive search over titles + lead paragraphs |

Requirements: **Node.js ≥ 18**, nothing else (no `npm install`).

### Adding it

**ZCode** — nothing to do: the workspace config in `.zcode/config.json`
(fallback `.agents/mcp.json`) is committed to this repo, so cloning it and
opening the folder auto-connects the `news24` MCP server.

**Claude Code / Cursor** — same: `.mcp.json` is committed at the repo root,
clone and approve the server.

**Claude Desktop / manual** — add to your client's MCP config:

```json
{
  "mcpServers": {
    "news24": { "command": "node", "args": ["<repo>/scripts/mcp-server.mjs"] }
  }
}
```

Quick smoke test without any client:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_news","arguments":{"limit":3}}}' \
  | node scripts/mcp-server.mjs
```

## Structure

```
index.html    # layout + categories
css/style.css # VnExpress-inspired theme (light + dark)
js/app.js     # RSS fetching, proxy fallback, caching, rendering
favicon.svg
```

## Disclaimer

This is a personal demo. All articles and images belong to VnExpress;
every item links back to the original article.
