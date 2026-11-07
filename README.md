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
- **Mobile-first ordering**: on phones and tablets the *Tin được quan tâm*
  block sits at the very top of the page, right under the category tabs (its
  first 3 headlines, then "Xem thêm tin quan tâm"); the section itself follows
- **In-page reader**: click an article to read it right on the page — full
  text is fetched via [r.jina.ai](https://r.jina.ai) (HTML mode) with the RSS
  proxies as fallback, sanitized to a tag whitelist (scripts/styles/trackers
  stripped, lazy images resolved from `data-src`) and cached in memory
- Live search, "load more" paging, relative timestamps ("2 giờ trước")
- **Summary box** under each article: an offline extractive summary paints
  instantly, then an AI summary swaps in when it arrives (cached 7 days)
- **Read the summary aloud** via Google Translate TTS, with a reading-speed
  toggle (0.8/1/1.25/1.5×)
- Dark mode toggle (persisted; respects `prefers-color-scheme`)
- 10-minute `localStorage` cache for instant navigation + offline fallback
- No build step, no dependencies — plain HTML/CSS/JS

## AI summary

Works out of the box with two free, key-less, CORS-enabled providers, and
can be pointed at your own API key (BYOK) from the ⚙️ button in the header.

**Zero-config default chain:**

| # | Provider | Model | Latency | Detail |
|---|---|---|---|---|
| 1 | [OVH Kepler](https://oai.endpoints.kepler.ai.cloud.ovh.net/v1) | `Mistral-Small-3.2-24B-Instruct-2506` | ~3.3 s | OpenAI-compatible; 2 req/min per IP |
| 2 | [Pollinations](https://text.pollinations.ai/) | `openai-fast` (GPT-OSS 20B) | ~8–17 s | 1 reply / 45 s per IP |

Mistral Small is first because it was the fastest of the six models
benchmarked and returns clean Vietnamese prose. The Qwen and `gpt-oss-*`
models on the same endpoint spend their whole token budget on hidden
reasoning and came back with an empty `content`, so they are not used.

**Bring your own key** — ⚙️ in the header opens the settings dialog:

| Setting | Notes |
|---|---|
| Provider | OVH, Pollinations (free), or OpenAI, Gemini, DeepSeek, Groq, OpenRouter, Anthropic, or any OpenAI-compatible endpoint |
| Model | Free-text with suggestions; blank = the provider's default |
| API key | Stored in this browser's `localStorage` only, sent straight to the provider |
| System prompt | Editable, so you can switch language or style |
| `max_tokens`, `temperature` | Range-clamped on save |

Your chosen provider runs first; the two key-less ones stay behind it as a
fallback, so a bad key degrades to a working summary instead of failing.
A *rejected* key is still reported (`⚠ Kiểm tra API key`) rather than
silently masked by the fallback.

The summary cache key embeds provider + model + prompt, so changing any of
them regenerates instead of serving text produced under the old settings.

A small client-side **rate-limit governor** paces requests: it keeps a
per-provider sliding one-minute window, folds `Retry-After` /
`ratelimit-reset` headers back into its own backoff, and skips a provider
that would exceed its cap rather than sending a request that is going to be
rejected. If every provider is unavailable the instant extractive summary
stays on screen and the button offers a retry.

> **Note on keys:** GitHub Pages serves this site as a static file, so there
> is no server to hold a secret. A key entered here lives in the browser and
> is visible to anyone with access to that machine. Use a scoped, low-quota
> key — and don't commit one.

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
