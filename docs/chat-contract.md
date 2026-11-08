# Chatbot — module contract

Shared API between the two halves of the feature. **Do not change without
telling the other side**; both files are written against this document.

- `js/chatbot.js` — the feature itself (new file, owns everything below).
- `js/app.js` — integration only. It must not contain chat UI or chat logic.

## Why a separate file

`js/app.js` is an IIFE and already ~2100 lines. The chatbot needs article
text, the AI provider chain and the item list from it, so `app.js` exposes
one small bridge and `chatbot.js` (loaded after it) does the rest.

## 1. Bridge exposed by `app.js`

```js
// Set inside the IIFE, after the article/summary code is defined:
window.NewsChat = {
  version: 1,

  // -> { link, title, sapo, cat, bodyText, extractive } | null
  //    null when no article is on screen (list view / stats view).
  //    bodyText: plain text of the rendered reader body, whitespace
  //    normalised, capped at 12000 chars. extractive: the offline
  //    summary string (may be "").
  currentArticle(),

  // (link) -> Promise<{ item, text, html, interactive }>  — resolves the
  // full article; uses the existing cache/proxy chain and caches the
  // result, so a chat question about a linked article does not refetch.
  // Rejects when the body cannot be fetched.
  getArticle(link),

  // ('<slug>-<id>.html') -> void  — navigate to that article in-page
  // (pushState + reader). Used by result cards / citations.
  openArticle(slug),

  // -> Promise<item[]>  — every article in the data/ snapshots, merged and
  //    de-duplicated by link, newest first, each decorated with
  //    {title, link, sapo, img, pubDate, slug, cat}. Cached in memory
  //    after the first call.
  allItems(),

  // -> Promise<{text}>  — one chat turn against the provider chain.
  //    ({system, messages, maxTokens?, temperature?})
  //    messages: [{role:'user'|'assistant', content:'…'}], already
  //    history-trimmed by the caller.
  //    Rejects with an Error whose .message is one of:
  //      "AI key"   — the user's API key was rejected (surface to user)
  //      "AI rate"  — every provider is rate limited right now
  //      "AI <x>"   — any other failure
  //    Uses the same rate-limit governor and BYOK settings as the
  //    summary feature (aiCfg, gateWait/gateRecord).
  chat(spec),

  // -> void — open/close the settings dialog (the ⚙ button), so the chat
  //    can point the user at it when a key is wrong.
  openSettings(),
};
```

`app.js` also dispatches, when the article view changes:

```js
document.dispatchEvent(new CustomEvent("news24:article", {
  detail: { link, title, sapo },
}));
```

and `news24:article` with `detail: null` when the list view comes back.
The chat uses this to reset the "now reading" context chip and to prune
per-article conversation state.

## 2. DOM contract (`index.html` + `404.html`)

Both pages get the identical block. `index.html` and `404.html` already
differ only by the `#viewStats` section, so keep that diff intact
(`scripts/check-stats-view.mjs` must keep passing).

```html
<!-- floating launcher -->
<button class="chat-fab" id="chatFab" type="button"
        aria-expanded="false" aria-controls="chatPanel"
        aria-label="Hỏi trợ lý tin tức" title="Hỏi trợ lý tin tức">
  <svg …><!-- speech bubble --></svg>
  <span class="chat-fab-label">Hỏi AI</span>
</button>

<section class="chat-panel" id="chatPanel" hidden
         role="dialog" aria-modal="false" aria-labelledby="chatTitle">
  <header class="chat-head">
    <h2 class="chat-title" id="chatTitle">Trợ lý tin tức</h2>
    <div class="chat-head-tools">
      <button id="chatNew" type="button" title="Cuộc trò chuyện mới">＋</button>
      <button id="chatCfg" type="button" title="Cài đặt AI">⚙</button>
      <button id="chatClose" type="button" aria-label="Đóng">✕</button>
    </div>
  </header>
  <div class="chat-ctx" id="chatCtx" hidden></div>   <!-- "Đang đọc: <title>" chip -->
  <div class="chat-log" id="chatLog" role="log" aria-live="polite"></div>
  <div class="chat-chips" id="chatChips"></div>      <!-- suggestion chips -->
  <form class="chat-form" id="chatForm">
    <textarea id="chatInput" rows="1" placeholder="Hỏi về bài báo hoặc chủ đề…"></textarea>
    <button class="chat-send" id="chatSend" type="submit" aria-label="Gửi">➤</button>
  </form>
</section>
```

`chatbot.js` may add listeners to any of these ids and must *not* require
new markup anywhere else. Every id above is owned by `chatbot.js`.

## 3. Behaviour the chat must implement (`chatbot.js`)

Two intents, auto-detected per turn, no mode switch:

1. **Ask about the open article** — the chat is attributed to the article
   currently in the reader (`NewsChat.currentArticle()`), or to an article
   the user names/links. Grounding text is that article's body. The system
   prompt must forbid inventing facts outside the text and require the
   model to say it is not in the article when the answer is absent.
2. **Find news by topic** — searches `NewsChat.allItems()` (title + sapo,
   accent/diacritic-insensitive, multi-word = all words must match, with a
   token-overlap fallback) and renders result cards (thumb + title +
   category + relative time) that open via `NewsChat.openArticle`. When
   local matches are weak, say so rather than pretend; do not call the
   network for search.

Additional requirements:

- Streaming is **not** required; render an animated "thinking" row while
  `NewsChat.chat()` is in flight and replace it with the answer.
- Conversation is per-context: history for the open article is separate
  from the topic-search history. Keep at most 8 turns, drop oldest.
- Persist conversation + panel open state in `localStorage` under
  `news24:chat:*` only; never store article bodies in it.
- Esc closes the panel, `/` or Ctrl+⌘+K opens it and focuses the input
  (but not while typing in another field), Enter sends / Shift+Enter
  newlines.
- All model output is rendered as **text** (no `innerHTML` of the answer);
  only linkify `https://vnexpress.net/<slug>-<id>.html` and internal
  slugs, which must go through `relativeSlug`-safe validation.
- Failure modes map to short Vietnamese messages: `AI key` -> check the
  settings, `AI rate` -> providers are busy, try again shortly.
- Mobile (<=639px): panel is a full-height sheet; the launcher must not
  cover the "Làm mới" / nav controls and must sit above the safe area.
- Respect `prefers-reduced-motion`; dark theme via existing CSS vars.
