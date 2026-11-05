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
- Live search, "load more" paging, relative timestamps ("2 giờ trước")
- Dark mode toggle (persisted; respects `prefers-color-scheme`)
- 10-minute `localStorage` cache for instant navigation + offline fallback
- No build step, no dependencies — plain HTML/CSS/JS

## How it works

VnExpress RSS does not send CORS headers, so the browser cannot read it
directly from a `github.io` origin. `js/app.js` therefore tries a chain of
public CORS proxies in order and uses the first that responds:

1. `api.rss2json.com` (JSON wrapper; note its `pubDate` is UTC and is
   converted back to local time)
2. `api.allorigins.win/raw`
3. `api.codetabs.com/v1/proxy`
4. `corsproxy.io`

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
