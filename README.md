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
  stripped, lazy images resolved from `data-src`) and cached in memory.
  Inline clips keep their still frame and caption with a link to the player
  on VnExpress — see [Video clips](#video-clips) for why they cannot play here
- Live search, "load more" paging, relative timestamps ("2 giờ trước")
- **[Thống kê](stats.html)**: số bài theo chủ đề / theo ngày, đọc thẳng từ
  các snapshot RSS trong `data/`
- **Summary box** under each article: an offline extractive summary paints
  instantly, then an AI summary swaps in when it arrives (cached 7 days)
- **Read the summary aloud** with a voice picker (Google Dịch by default,
  ViFastTts as the natural-sounding option) and a reading-speed toggle
  (0.8/1/1.25/1.5×) — see [Read aloud](#read-aloud-tts)
- **Chatbot** (*Hỏi AI*): ask about the article you are reading, or find
  articles by topic — grounded in the article text and the local snapshots,
  never in the model's own knowledge
- Dark mode toggle (persisted; respects `prefers-color-scheme`)
- 10-minute `localStorage` cache for instant navigation + offline fallback
- No build step, no dependencies — plain HTML/CSS/JS

## Thống kê

[`stats.html`](stats.html) (nav *Thống kê*) answers "bao nhiêu bài, chủ đề
nào, ngày nào": số bài theo chủ đề, số bài theo ngày, số bài theo giờ, biểu đồ
cột xếp chồng chủ đề × ngày, và bảng chủ đề × ngày. Thuần HTML/CSS/JS tự vẽ,
không thư viện, không file dữ liệu riêng.

Trang đọc đúng những tệp mà trang chủ đang dùng — `data/<chuyên mục>.json` —
rồi gộp lại:

- Mỗi bài được tính **một lần**, dù nó nằm ở nhiều chuyên mục.
- Feed tổng `tin-moi-nhat` được đọc **sau cùng**, nên bài nào cũng giữ đúng
  chuyên mục thật; bài chỉ có ở feed tổng rơi vào "Khác".
- "Cập nhật" là `fetchedAt` mới nhất trong các tệp đó.

Đánh đổi: RSS chỉ giữ ~60 tin gần nhất mỗi chuyên mục, nên trang phản ánh
**cửa sổ vài ngày gần nhất** (hiện ~9 ngày, ~600 bài), không phải toàn bộ lịch
sử. Muốn có chuỗi dài hơn thì phải lưu mẫu ở server (một file lịch sử do
workflow ghi thêm) — cố ý không làm, để repo không phải mang thêm dữ liệu.

Lưu ý khi đọc biểu đồ giờ: VnExpress đánh dấu `00:00` cho bài không rõ giờ
đăng, nên cột 0 giờ luôn cao bất thường (~6 % số bài).

GitHub Pages phục vụ `/news/stats` bằng `404.html`; phần markup thống kê nằm
trong `#viewStats` ở đó và trong `stats.html` (cùng một nội dung). Kiểm tra
hai bản có khớp nhau không:

```bash
node scripts/check-stats-view.mjs
```

## Read aloud (TTS)

**🔊 Đọc tóm tắt** reads the summary box aloud with the voice picked in
**🗣** next to it. Two voices are available; the chosen one is tried first and
the other acts as fallback, so a dead proxy or a rate limit never leaves the
button doing nothing.

| Voice | How | Default |
|---|---|---|
| **Google Dịch** | Google Translate TTS, streamed through `<audio src>`. No key, no account, no rate-limit surprises. | ✅ |
| **ViFastTts** | [tts.vifast.org](https://tts.vifast.org) `POST /api/tts` — Vietnamese ONNX model (Ngọc Huyền small, 24 kHz mono WAV). More natural pacing, reads the whole summary in **one** request. | |

Both play through one `<audio>` element, so the speed button and stop behave
identically for either voice. The default is Google Dịch because it needs no
third-party proxy and has no per-minute cap; pick ViFastTts for the better
voice.

### Controls

| Control | Behaviour |
|---|---|
| 🗣 `Google Dịch` / `ViFastTts` | Opens a small picker. Persisted as `news24:ttsvoice`. Switching while reading restarts the clip from the top, because the voice is baked into synthesis rather than applied at playback. |
| ⚡ `1×` | Reading speed 0.8 / 1 / 1.25 / 1.5×. Applied on playback, so changing it mid-sentence does **not** restart the clip. Persisted as `news24:ttsrate`. |

### Why ViFastTts goes through a proxy

The public ViFastTts demo does **not** send `Access-Control-Allow-Origin` (it
runs without `--cors`, per
[`http-server/src/lib.rs`](https://github.com/vifast-oss/ViFastTts/blob/main/rust/crates/adapters/inbound/http-server/src/lib.rs)),
so a static page on GitHub Pages cannot `fetch()` it directly — the browser
blocks the response. Requests therefore go through a small CORS pass-through,
`cors.rin2401.workers.dev`, which reflects the page origin and forwards the
POST body and the WAV bytes unchanged:

```text
https://cors.rin2401.workers.dev/https://tts.vifast.org/api/tts
```

The ViFastTts demo also caps traffic at **6 requests/minute/IP** (`max_chars`
3000, read from `/api/config`). A `429` is remembered for the session so the
next click skips straight to Google instead of queueing again. A rejected
*user gesture* (`NotAllowedError`) is not masked by the fallback; it surfaces
as `⚠️ Không đọc được`.

> **Only one ViFastTts voice exists.** The model is single-speaker and
> northern; `dialect=north|central|south` is accepted by the API but returns
> byte-identical audio (verified: same MD5 for all three), and unknown
> `voice`/`speaker`/`model` fields are silently ignored. That is why the
> picker lists engines, not accents — see
> [NGOC_HUYEN.md](https://github.com/vifast-oss/ViFastTts/blob/main/docs/NGOC_HUYEN.md)
> ("Single-speaker; không speaker ID/zero-shot"). A different voice means a
> different model, i.e. a hosted service with an API key.

### Google fallback: the 200-character splitter

Google Translate TTS rejects any request past ~200 characters (measured: 200
OK, 202 → HTTP 400), so the summary is split across several requests played
back to back.

Chunks break at **sentence boundaries**, not at a fixed character count, so
playback never stops mid-clause. Sentences are packed greedily into a chunk;
only a single sentence longer than one request is broken further — at a clause
mark (`;` `:` `,`) first, then any space. Abbreviations that contain a dot
(`GS.TS`, `UBND`, `TS.`, numbered list markers like `1.`) do not end a
sentence, so they are not used as cut points.

Splitting is lossless: `chunks.join(" ") === summary` (whitespace-normalised),
so nothing is dropped or duplicated between requests.

Check the wiring (add `--online` to also call the live API through the proxy):

```bash
node tests/tts-check.mjs
node tests/tts-check.mjs --online
```

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

## Chatbot

Nút **Hỏi AI** ở góc phải dưới mở một khung chat. Nó trả lời hai loại câu hỏi,
tự nhận loại theo câu chữ — không có công tắc chế độ:

1. **Hỏi về bài đang đọc** — câu hỏi được gắn với bài đang mở trong trang đọc
   (chip *Đang đọc: …* trên đầu khung). Phần trả lời chạy trên chính nội dung
   bài đó.
2. **Tìm báo theo chủ đề** — câu hỏi không phải dạng hỏi được tìm thẳng trong
   kho tin cục bộ và trả về các thẻ kết quả (ảnh, tiêu đề, chuyên mục, thời
   gian), bấm vào là mở bài ngay trong trang.

Chưa mở bài nào (đang ở danh sách) thì mọi câu hỏi đều thành tìm kiếm; khung
chat nói rõ điều đó trong lời chào.

### Dựa vào đâu để trả lời

- Bài đang đọc: nội dung do trang đọc đưa sang (`NewsChat.currentArticle()`),
  cắt còn 6 000 ký tự trước khi gửi model. Hỏi về một bài khác (dán link
  VnExpress) thì lấy toàn văn qua đúng đường tải của trang đọc — đã cache thì
  không tải lại.
- Tìm chủ đề: chỉ tìm trong `data/*.json`. Bản thân việc tìm **không gọi
  mạng**; model chỉ chọn truy vấn ngắn và chuyên mục, tiêu đề/đường dẫn hiển
  thị lấy từ kho tin chứ không lấy từ model.
- Model trả về một câu trả lời cho bài đang đọc mà gần như không dùng từ ngữ
  nào của bài thì câu đó **bị bỏ**, thay bằng trích nguyên văn các câu liên
  quan trong bài. Không có câu trả lời từ AI thì khung chat vẫn tìm và hiện
  kết quả, kèm một dòng tiếng Việt nói rõ là thiếu câu trả lời AI.

**Dùng chung thiết lập với AI summary:** cùng chuỗi provider (OVH → các
provider miễn phí → key của bạn), cùng bộ điều tiết rate limit, cùng hộp thoại
⚙️. Đổi provider/model/key ở đó là đổi cho cả hai. AI tắt hẳn thì chat vẫn
dùng được ở chế độ tìm + trích dẫn.

### Đánh đổi

- Kho tin chỉ là **bản chụp RSS gần nhất**: mỗi chuyên mục ~60 tin, hiện
  khoảng 8 ngày gần nhất. Tin cũ hơn **không có** trong dữ liệu để tìm — khung
  chat nói thẳng "không tìm thấy" chứ không bịa ra bài.
- Câu hỏi về bài đang đọc cần tải được toàn văn bài qua `r.jina.ai`/proxy như
  trang đọc; không tải được thì nó báo chứ không trả lời liều.
- Provider miễn phí giới hạn theo IP (OVH 2 req/phút, Pollinations 1 lời/45 s),
  nên trong lúc bận chat sẽ trả lời chậm hoặc bỏ lượt gọi AI. Lỗi xong thì nó
  nghỉ một lúc (45 s nếu bị rate limit, 15 s nếu key bị từ chối) trước khi thử
  lại, và có nút **Thử lại** / **Mở cài đặt AI**.
- Model không được stream: một lượt chờ trọn câu trả lời, hiện dòng "Đang xử
  lý…" trong lúc chờ.

### Phím tắt và những gì lưu lại

| Phím | Tác dụng |
|---|---|
| `Esc` | Đóng khung chat (không đụng tới hộp thoại Cài đặt AI) |
| `/` | Mở khung chat và focus ô nhập — chỉ khi đang **không** gõ ở ô khác |
| `Ctrl/⌘ + K` | Như trên, và vẫn chạy được khi đang gõ ở ô khác |
| `Enter` / `Shift+Enter` | Gửi / xuống dòng |

Mỗi bài (và danh sách) có cuộc trò chuyện riêng, giữ tối đa 8 lượt, lưu trong
`localStorage`:

| Khoá | Nội dung |
|---|---|
| `news24:chat:open` | Khung chat đang mở (`1`) hay đóng (`0`) |
| `news24:chat:thread:<ngữ cảnh>` | Các lượt hỏi/đáp của một ngữ cảnh (`list`, hoặc `a:<link>` cho từng bài) |
| `news24:chat:threads` | Danh sách ngữ cảnh đã lưu, tối đa 6 — cũ hơn bị đẩy ra khỏi đĩa |
| `news24:chat:at:<ngữ cảnh>` | Mốc thời gian ghi gần nhất của ngữ cảnh đó |

Lịch sử chỉ chứa câu hỏi và câu trả lời (mỗi mục cắt còn 400 ký tự) — **không
lưu nội dung bài báo**. Nút **＋** xoá cuộc trò chuyện của ngữ cảnh đang mở.

Hợp đồng giữa `js/chatbot.js` và `js/app.js` nằm ở
[`docs/chat-contract.md`](docs/chat-contract.md); kiểm tra HTML/CSS/JS của
tính năng này:

```bash
node tests/chat-check.mjs
```

## How it works

**Listings** read the same-origin snapshots in [`data/`](data/) —
`data/<slug>.json` files written by `scripts/fetch-rss.mjs`, which a
GitHub Action (`.github/workflows/fetch-rss.yml`) runs every 30 minutes
with a browser User-Agent (VnExpress blocks bot UAs). No CORS, no
third-party rate limits, survives public-proxy outages. The stats page
reads exactly these files — there is no separate history dataset.

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

## Video clips

VnExpress embeds clips as HLS (`.../master.m3u8`, AES-128 encrypted `.ts`
segments) on `d1.vnecdn.net`, and that host enforces **hotlink protection**:
it answers `406`/`407` unless `Referer` is `vnexpress.net`, which a browser
cannot set. Verified from Chrome — a plain `<video src>` fails with
`DEMUXER_ERROR_COULD_NOT_PARSE` and `hls.js` fails with
`manifestLoadError`. Article images (`i1-…`, `iv1-…`) are *not* restricted,
which is why photos work and video does not.

So each clip renders as its **still frame with a play overlay**, and both
the frame and the caption open the clip on VnExpress in a new tab, where it
plays normally. That keeps the story's visuals and order instead of silently
dropping the media, which is what the sanitiser used to do.

The block is a plain `<a target="_blank"><img>` — no `<video>`, no player
script, no third-party dependency. It degrades to a 16:9 dark stage with the
play button if the poster cannot load.

Keeping it through the sanitiser takes three exemptions in `js/app.js`:

- `liftVideos()` runs **before** the tag-strip pass and swaps each clip for a
  `<figure class="rd-video">`, pulling the poster from
  `img.thumb-above-video` and the caption from `.parser_title`.
- The strip pass (`STRIP_SELECTOR`) skips anything **inside or containing**
  one of those blocks — the wrapper is
  `div.box_embed_video_parent`, which matches `[class*='box_']`, and it is an
  *ancestor* of the block, so a `closest()`-only check would still drop it.
- `figure` cleanup keeps a figure that holds media **or contains** a
  `.rd-video`; VnExpress nests the clip two figures deep.

Cached article HTML is stamped `ARTICLE_HTML_VERSION` so bodies cached by an
older build (which dropped clips entirely) are refetched.

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
stats.html    # trang thống kê (số bài theo chủ đề / theo ngày)
css/style.css # VnExpress-inspired theme (light + dark)
js/app.js     # RSS fetching, proxy fallback, caching, rendering
js/chatbot.js # chatbot: hỏi về bài đang đọc, tìm báo theo chủ đề
js/stats.js   # thống kê từ data/<slug>.json, tự vẽ biểu đồ
docs/chat-contract.md # hợp đồng chat <-> app.js
tests/chat-check.mjs  # kiểm tra HTML/CSS/JS của chatbot
tests/tts-check.mjs   # kiểm tra đọc to (TTS); --online để gọi API thật
favicon.svg
```

## Disclaimer

This is a personal demo. All articles and images belong to VnExpress;
every item links back to the original article.
