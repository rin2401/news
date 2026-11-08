/* News24 - VnExpress RSS reader
 * Fetches VnExpress RSS through a chain of public CORS proxies
 * (first success wins), caches to localStorage, renders a
 * VnExpress-style list with sidebar, search and dark mode. */
"use strict";

(function () {
  // ------------------------------------------------------------------
  // Config
  // ------------------------------------------------------------------
  const FEED_BASE = "https://vnexpress.net/rss/";
  const CACHE_TTL = 10 * 60 * 1000; // 10 minutes
  const PAGE_SIZE = 15;
  const SIDEBAR_FEED = "tin-moi-nhat";
  const IMG_PLACEHOLDER =
    "data:image/svg+xml;charset=utf-8," +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200">' +
        '<rect width="100%" height="100%" fill="#e3e3e3"/>' +
        '<text x="50%" y="50%" font-family="Arial" font-size="22" fill="#9a9a9a" ' +
        'text-anchor="middle" dominant-baseline="middle">News24</text></svg>'
    );

  const CATEGORIES = {
    "tin-moi-nhat": "Tin mới nhất",
    "thoi-su": "Thời sự",
    "the-gioi": "Thế giới",
    "kinh-doanh": "Kinh doanh",
    "bat-dong-san": "Bất động sản",
    "the-thao": "Thể thao",
    "giai-tri": "Giải trí",
    "suc-khoe": "Sức khỏe",
    "giao-duc": "Giáo dục",
    "du-lich": "Du lịch",
    "phap-luat": "Pháp luật",
  };

  /* Each proxy: build(targetUrl) -> request URL, extract(fetchRes) -> items[].
   * Item shape kept uniform: {title, link, pubDate(ms), img, sapo, slug}. */
  const PROXIES = [
    {
      // JSON wrapper; returns pubDate in UTC ("YYYY-MM-DD HH:mm:ss")
      name: "rss2json",
      build: (u) =>
        "https://api.rss2json.com/v1/api.json?rss_url=" +
        encodeURIComponent(u) + "&count=60",
      extract: async (res) => {
        const data = await res.json();
        if (data.status !== "ok" || !Array.isArray(data.items)) {
          throw new Error("rss2json bad payload");
        }
        return data.items.map((it) => ({
          title: stripTags(it.title || ""),
          link: safeUrl(it.link || ""),
          pubDate: utcStringToMs(it.pubDate || ""),
          img: safeImg(
            it.thumbnail ||
              (it.enclosure && it.enclosure[0] && it.enclosure[0].url) ||
              firstImgFromHtml(it.description || "")
          ),
          sapo: sapoFromHtml(it.description || ""),
        }));
      },
    },
    {
      name: "allorigins",
      build: (u) =>
        "https://api.allorigins.win/raw?url=" + encodeURIComponent(u),
      extract: async (res) => parseRssXml(await res.text()),
    },
    {
      name: "codetabs",
      build: (u) => "https://api.codetabs.com/v1/proxy?quest=" + encodeURIComponent(u),
      extract: async (res) => parseRssXml(await res.text()),
    },
    {
      name: "corsproxy",
      build: (u) => "https://corsproxy.io/?url=" + encodeURIComponent(u),
      extract: async (res) => parseRssXml(await res.text()),
    },
  ];

  // ------------------------------------------------------------------
  // Small helpers
  // ------------------------------------------------------------------
  // Titles/sapos arrive from three sources that escape with different rules:
  // raw RSS XML text nodes, rss2json's already-unescaped JSON, and the
  // data/*.json snapshots. The snapshot parser keeps CDATA bodies raw, so a
  // "&" inside a title is stored as "&amp;" and would ship to the DOM as the
  // literal text "&amp;". Decode named/numeric entities exactly once here.
  const NAMED_ENTITIES = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: "\u00a0",
    ndash: "\u2013",
    mdash: "\u2014",
    lsquo: "\u2018",
    rsquo: "\u2019",
    ldquo: "\u201c",
    rdquo: "\u201d",
    hellip: "\u2026",
  };

  function decodeEntities(s) {
    // Run twice at most: some proxies double-escape ("&amp;amp;").
    const once = (str) =>
      str.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, e) => {
        if (e[0] === "#") {
          const cp =
            e[1] === "x" || e[1] === "X"
              ? parseInt(e.slice(2), 16)
              : parseInt(e.slice(1), 10);
          if (!cp || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return m;
          try {
            return String.fromCodePoint(cp);
          } catch {
            return m;
          }
        }
        const named = NAMED_ENTITIES[e.toLowerCase()];
        return named === undefined ? m : named;
      });
    let out = String(s || "");
    for (let i = 0; i < 2 && /&[#a-zA-Z]/.test(out); i++) {
      const next = once(out);
      if (next === out) break;
      out = next;
    }
    return out;
  }

  function stripTags(s) {
    const el = document.createElement("div");
    el.innerHTML = s;
    return decodeEntities((el.textContent || "").trim());
  }

  // Description CDATA = '<a href=...><img src=...></a></br> lead text'
  function sapoFromHtml(html) {
    const withoutImg = String(html).replace(/<a[\s\S]*?<\/a>/gi, "");
    return stripTags(withoutImg).slice(0, 220);
  }

  function firstImgFromHtml(html) {
    const m = /<img[^>]+src=["']([^"']+)["']/i.exec(String(html || ""));
    return m ? safeImg(m[1]) : "";
  }

  // Some proxies (rss2json) XML-escape CDATA content, turning "&" into
  // "&amp;" inside image/query URLs. vnecdn's signed params then mismatch
  // (HTTP 401), so decode amp entities before validating the URL.
  function decodeAmp(u) {
    return String(u || "")
      .replace(/&amp;/gi, "&")
      .replace(/&#0?38;/gi, "&");
  }

  function safeUrl(u) {
    const s = decodeAmp(u);
    return /^https?:\/\//i.test(s) ? s : "";
  }

  function safeImg(u) {
    const s = decodeAmp(u);
    return /^https?:\/\//i.test(s) ? s : "";
  }

  function utcStringToMs(s) {
    // "2026-11-05 02:50:51" (UTC, from rss2json) -> epoch ms
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s);
    if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    const t = Date.parse(s);
    return Number.isNaN(t) ? Date.now() : t;
  }

  function timeAgo(ms) {
    const diffMin = Math.floor((Date.now() - ms) / 60000);
    if (diffMin < 1) return "Vừa xong";
    if (diffMin < 60) return diffMin + " phút trước";
    const h = Math.floor(diffMin / 60);
    if (h < 24) return h + " giờ trước";
    if (h < 48) {
      return (
        "Hôm qua " +
        new Date(ms).toLocaleTimeString("vi-VN", {
          hour: "2-digit",
          minute: "2-digit",
        })
      );
    }
    return new Date(ms).toLocaleDateString("vi-VN", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
  }

  function escapeAttr(s) {
    return String(s || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  }

  function safeText(s) {
    const el = document.createElement("div");
    el.textContent = String(s || "");
    return el.innerHTML;
  }

  // ------------------------------------------------------------------
  // RSS XML parsing (allorigins / codetabs / corsproxy path)
  // ------------------------------------------------------------------
  function parseRssXml(text) {
    const doc = new DOMParser().parseFromString(text, "text/xml");
    if (doc.querySelector("parsererror")) throw new Error("invalid XML");
    const nodes = doc.querySelectorAll("item");
    if (!nodes.length) throw new Error("no items");
    const items = [];
    nodes.forEach((n) => {
      const descHtml = (n.querySelector("description") || {}).textContent || "";
      const enclosure = n.querySelector("enclosure");
      const link = safeUrl((n.querySelector("link") || {}).textContent || "");
      items.push({
        title: stripTags((n.querySelector("title") || {}).textContent || ""),
        link,
        pubDate: Date.parse(
          (n.querySelector("pubDate") || {}).textContent || ""
        ) || Date.now(),
        img: safeImg(
          (enclosure && enclosure.getAttribute("url")) ||
            firstImgFromHtml(descHtml)
        ),
        sapo: sapoFromHtml(descHtml),
      });
    });
    return items;
  }

  // ------------------------------------------------------------------
  // Fetch with proxy fallback + localStorage cache
  // ------------------------------------------------------------------
  function cacheKey(slug) {
    // v2: items cached before the "&amp;" URL fix carried broken image links
    return "news24:v2:cache:" + slug;
  }

  function readCache(slug) {
    try {
      const raw = localStorage.getItem(cacheKey(slug));
      if (!raw) return null;
      const { t, items } = JSON.parse(raw);
      if (!Array.isArray(items) || !items.length) return null;
      return { t: t || 0, items };
    } catch {
      return null;
    }
  }

  function writeCache(slug, items) {
    try {
      localStorage.setItem(
        cacheKey(slug),
        JSON.stringify({ t: Date.now(), items })
      );
    } catch {
      /* quota / private mode - ignore */
    }
  }

  function fetchWithTimeout(url, ms, headers, init) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    init = init || {};
    return fetch(url, {
      method: init.method || "GET",
      body: init.body,
      signal: ctrl.signal,
      mode: "cors",
      headers: headers || undefined,
    }).finally(() => clearTimeout(timer));
  }

  async function fetchFeed(slug) {
    const target = FEED_BASE + slug + ".rss";
    let lastErr = null;
    for (const proxy of PROXIES) {
      try {
        const res = await fetchWithTimeout(proxy.build(target), 12000);
        if (!res.ok) {
          lastErr = new Error(proxy.name + " HTTP " + res.status);
          continue;
        }
        const items = await proxy.extract(res);
        if (items.length) return items.map((it) => decorate(it, slug));
        lastErr = new Error(proxy.name + " empty");
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error("all proxies failed");
  }

  function decorate(item, slug) {
    return Object.assign({}, item, {
      slug,
      cat: CATEGORIES[slug] || "Tin tức",
      pubDate: item.pubDate || Date.now(),
      // The snapshot parser keeps CDATA raw, so titles/sapos can still carry
      // entities ("&amp;"). Decode here for every source: it is idempotent
      // for text that was already unescaped.
      title: decodeEntities(item.title) || "(Không có tiêu đề)",
      sapo: decodeEntities(item.sapo),
      img: item.img || "",
      link: item.link || "https://vnexpress.net",
    });
  }

  // Preferred source: same-origin JSON snapshots (data/<slug>.json)
  // written every 30 minutes by the fetch-rss GitHub Action - no CORS,
  // no third-party rate limits, immune to public-proxy outages.
  async function fetchFeedLocal(slug) {
    const res = await fetch("data/" + slug + ".json", { cache: "no-cache" });
    if (!res.ok) throw new Error("local HTTP " + res.status);
    const data = await res.json();
    if (!data.items || !data.items.length) throw new Error("local empty");
    return data.items.map((it) => decorate(it, slug));
  }

  async function loadFeed(slug, force) {
    if (!force) {
      try {
        return await fetchFeedLocal(slug);
      } catch {
        /* fall through to proxies */
      }
    }
    // Live refresh ("Làm mới") or snapshot missing: proxy chain, then
    // fall back to whatever snapshot we have.
    try {
      return await fetchFeed(slug);
    } catch {
      return fetchFeedLocal(slug);
    }
  }

  // ------------------------------------------------------------------
  // Rendering
  // ------------------------------------------------------------------
  const els = {
    nav: document.getElementById("catNav"),
    colTitle: document.getElementById("colTitle"),
    colMeta: document.getElementById("colMeta"),
    featured: document.getElementById("featuredSlot"),
    list: document.getElementById("newsList"),
    skeletons: document.getElementById("skeletons"),
    loadMore: document.getElementById("loadMoreBtn"),
    sideList: document.getElementById("sideList"),
    search: document.getElementById("searchInput"),
    status: document.getElementById("statusBar"),
    refresh: document.getElementById("refreshBtn"),
    theme: document.getElementById("themeToggle"),
    today: document.getElementById("today"),
  };

  const state = {
    slug: "tin-moi-nhat",
    items: [],
    shown: PAGE_SIZE,
    query: "",
    loading: false,
  };

  function showSkeletons(on) {
    els.skeletons.innerHTML = "";
    els.skeletons.hidden = !on;
    if (!on) return;
    const tpl = document.getElementById("tplSkeleton");
    for (let i = 0; i < 5; i++) {
      els.skeletons.appendChild(tpl.content.cloneNode(true));
    }
  }

  function showStatus(msg, isErr, retry) {
    els.status.hidden = !msg;
    if (!msg) return;
    els.status.className = "status-bar" + (isErr ? " err" : "");
    els.status.innerHTML = safeText(msg) +
      (retry ? ' <span class="retry">Thử lại</span>' : "");
    if (retry) {
      els.status.querySelector(".retry").addEventListener("click", () => {
        loadSlug(state.slug, { force: true });
      });
    }
  }

  function articleHtml(it, variant) {
    // Build markup with escaped text; img src validated as http(s) upstream.
    // Cards point at the local slug.html page (VnExpress-style URLs),
    // served via 404.html on GitHub Pages.
    const href = escapeAttr(relativeSlug(it.link));
    const img = it.img
      ? '<img src="' + escapeAttr(it.img) + '" alt="' + escapeAttr(it.title) +
        '" loading="lazy" referrerpolicy="no-referrer" onerror="this.src=this.dataset.ph" data-ph="' +
        IMG_PLACEHOLDER + '">'
      : "";
    const meta =
      '<div class="a-meta"><span class="a-cat">' + safeText(it.cat) +
      '</span><span class="dot">·</span><span>' + timeAgo(it.pubDate) +
      "</span></div>";
    if (variant === "featured") {
      return (
        '<a class="article-featured' + (it.img ? "" : " no-img") +
        '" href="' + href + '">' +
        (it.img ? '<div class="thumb-featured">' + img + "</div>" : "") +
        '<h2 class="a-title">' + safeText(it.title) + "</h2>" +
        (it.sapo ? '<p class="a-sapo">' + safeText(it.sapo) + "</p>" : "") +
        meta +
        "</a>"
      );
    }
    if (variant === "side") {
      return (
        '<a class="side-item' + (it.img ? "" : " no-img") +
        '" href="' + href + '">' +
        (it.img ? '<div class="side-thumb">' + img + "</div>" : "") +
        "<div><h3 class=\"a-title\">" + safeText(it.title) + "</h3>" +
        '<div class="a-meta">' + timeAgo(it.pubDate) + "</div></div></a>"
      );
    }
    return (
      '<a class="news-item' + (it.img ? "" : " no-img") +
      '" href="' + href + '">' +
      (it.img ? '<div class="thumb">' + img + "</div>" : "") +
      '<div class="news-body"><h3 class="a-title">' + safeText(it.title) +
      "</h3>" +
      (it.sapo ? '<p class="a-sapo">' + safeText(it.sapo) + "</p>" : "") +
      meta +
      "</div></a>"
    );
  }

  function filteredItems() {
    const q = state.query.trim().toLowerCase();
    if (!q) return state.items;
    return state.items.filter(
      (it) =>
        it.title.toLowerCase().includes(q) ||
        it.sapo.toLowerCase().includes(q)
    );
  }

  function renderMain() {
    const items = filteredItems();
    els.colTitle.textContent =
      CATEGORIES[state.slug] +
      (state.query ? ' — kết quả cho "' + state.query + '"' : "");
    els.colMeta.textContent = items.length
      ? items.length + " bài viết"
      : "";

    els.loadMore.hidden = state.shown >= items.length;

    if (!items.length) {
      els.featured.innerHTML = "";
      els.list.innerHTML =
        '<div class="empty-note">Không có bài viết phù hợp.</div>';
      return;
    }

    const [first, ...rest] = items;
    const useFeatured = !state.query; // featured layout only in browse mode
    registerItems(items);
    els.featured.innerHTML = useFeatured ? articleHtml(first, "featured") : "";
    const pageItems = useFeatured ? rest : items;
    els.list.innerHTML = pageItems
      .slice(0, state.shown)
      .map((it) => articleHtml(it))
      .join("");
  }

  function renderSidebar(items) {
    if (!items || !items.length) return;
    registerItems(items);
    // Sidebar shows latest headlines, skipping what the main column
    // already displays for the current category.
    const seen = new Set(
      state.items.slice(0, state.shown + 1).map((i) => i.link)
    );
    const pool = items.filter((i) => !seen.has(i.link)).slice(0, 12);
    els.sideList.innerHTML = pool
      .map((it) => articleHtml(decorate(it, SIDEBAR_FEED), "side"))
      .join("");
    els.sideList.insertAdjacentHTML(
      "beforeend",
      '<button class="side-more" type="button" aria-expanded="false">' +
        "Xem thêm tin quan tâm</button>"
    );
    els.sideList.classList.remove("expanded");
    const more = els.sideList.querySelector(".side-more");
    more.addEventListener("click", () => {
      els.sideList.classList.add("expanded");
      more.remove();
    });
  }

  // ------------------------------------------------------------------
  // Data loading
  // ------------------------------------------------------------------
  let sideLoad = null; // sidebar promise shared across category switches

  async function loadSidebar() {
    if (!sideLoad) {
      sideLoad = loadFeed(SIDEBAR_FEED, false)
        .catch(() => {
          sideLoad = null;
          return [];
        })
        .then((items) => {
          if (items.length) {
            // keep a short-lived copy; refresh every ~30 min
            setTimeout(() => (sideLoad = null), 30 * 60000);
          }
          renderSidebar(items);
          return items;
        });
    } else {
      sideLoad.then((items) => items && items.length && renderSidebar(items));
    }
    return sideLoad;
  }

  async function loadSlug(slug, opts) {
    opts = opts || {};
    if (!CATEGORIES[slug]) slug = "tin-moi-nhat";
    state.slug = slug;
    state.shown = PAGE_SIZE;
    state.query = "";
    els.search.value = "";
    showView("list");
    document.title = "News24 - Đọc báo nhanh 24h từ VnExpress RSS";
    if (opts.syncUrl !== false) updateHash(slug);
    setActiveNav(slug);

    // 1) instant paint from cache (if any)
    const cached = readCache(slug);
    if (cached) {
      state.items = cached.items;
      renderMain();
      showSkeletons(false);
    } else {
      state.items = [];
      renderMain();
      showSkeletons(true);
    }

    // 2) network refresh unless fresh cache + not forced
    const fresh = cached && Date.now() - cached.t < CACHE_TTL;
    if (fresh && !opts.force) {
      showSkeletons(false);
      showStatus(
        "Cập nhật lúc " +
          new Date(cached.t).toLocaleTimeString("vi-VN") +
          " · nhấn \"Làm mới\" để tải lại",
        false
      );
      loadSidebar();
      return;
    }

    state.loading = true;
    els.refresh.classList.add("spinning");
    showStatus("", false);
    try {
      const items = await loadFeed(slug, opts.force);
      state.items = items;
      writeCache(slug, items);
      showStatus("", false);
    } catch (e) {
      if (!state.items.length) {
        showSkeletons(false);
        showStatus(
          "Không tải được tin (mạng hoặc proxy bị chặn). " +
            "Vui lòng thử lại.",
          true,
          true
        );
      } else {
        showStatus("Đang dùng dữ liệu đã lưu trong máy.", false);
      }
    } finally {
      state.loading = false;
      els.refresh.classList.remove("spinning");
      showSkeletons(false);
      renderMain();
    }
    loadSidebar();
  }

  // ------------------------------------------------------------------
  // Routing / events
  // ------------------------------------------------------------------
  function slugFromHash() {
    const m = /^#\/?([\w-]+)$/.exec(location.hash);
    return m && CATEGORIES[m[1]] ? m[1] : "tin-moi-nhat";
  }

  // Category URLs are real paths (/news/<slug>, VnExpress-style) served
  // through the 404-trick; legacy #/<slug> hash links migrate to them.
  // Resolves the base the page was served from, so the site also works
  // under a sub-path (/news/thoi-su -> "/news/", /thoi-su -> "/").
  function currentCat() {
    const m = /^(.*\/)([a-z-]+)\/?$/i.exec(decodeURI(location.pathname));
    return m && CATEGORIES[m[2]] ? m[2] : null;
  }

  function updateHash(slug) {
    if (location.pathname.endsWith("/" + slug)) return; // already there
    if (location.hash === "#/" + slug) {
      // migrate a legacy hash URL to the clean path form
      history.replaceState(null, "", "./" + slug);
      return;
    }
    // replace (not push) to avoid history noise on programmatic loads
    history.replaceState(null, "", "./" + slug);
  }

  function setActiveNav(slug) {
    els.nav.querySelectorAll(".nav-link").forEach((a) => {
      a.classList.toggle("active", a.dataset.slug === slug);
    });
  }

  els.nav.addEventListener("click", (e) => {
    const link = e.target.closest(".nav-link");
    // Only category links carry data-slug; the "Thống kê" link is a real
    // page navigation and must fall through to the browser.
    if (!link || !link.dataset.slug) return;
    e.preventDefault();
    const slug = link.dataset.slug;
    history.pushState(null, "", "./" + slug);
    loadSlug(slug, { syncUrl: false }); // URL already updated by the push
  });

  window.addEventListener("hashchange", () => {
    if (currentSlug()) return; // hash on an article URL is meaningless
    loadSlug(slugFromHash());
  });

  els.loadMore.addEventListener("click", () => {
    state.shown += PAGE_SIZE;
    renderMain();
  });

  els.search.addEventListener("input", () => {
    if (currentSlug()) {
      location.href = "./"; // search only makes sense on the list view
      return;
    }
    state.query = els.search.value;
    state.shown = PAGE_SIZE;
    renderMain();
  });

  els.refresh.addEventListener("click", () => {
    if (currentSlug()) {
      location.reload();
      return;
    }
    loadSlug(state.slug, { force: true });
  });

  // ------------------------------------------------------------------
  // Theme
  // ------------------------------------------------------------------
  function applyTheme(t) {
    document.documentElement.dataset.theme = t;
    try {
      localStorage.setItem("news24:theme", t);
    } catch {}
  }

  (function initTheme() {
    let saved = null;
    try {
      saved = localStorage.getItem("news24:theme");
    } catch {}
    const prefersDark = window.matchMedia(
      "(prefers-color-scheme: dark)"
    ).matches;
    applyTheme(saved || (prefersDark ? "dark" : "light"));
  })();

  els.theme.addEventListener("click", () => {
    applyTheme(
      document.documentElement.dataset.theme === "dark" ? "light" : "dark"
    );
  });

  // ------------------------------------------------------------------
  // Header date
  // ------------------------------------------------------------------
  function renderToday() {
    const now = new Date();
    const wd = ["Chủ nhật", "Thứ 2", "Thứ 3", "Thứ 4", "Thứ 5", "Thứ 6", "Thứ 7"][
      now.getDay()
    ];
    els.today.textContent =
      wd +
      ", " +
      now.toLocaleDateString("vi-VN", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
      });
  }

  // ------------------------------------------------------------------
  // Article pages (/news/<slug>.html - VnExpress-style slugs)
  // ------------------------------------------------------------------
  const artEls = {
    view: document.getElementById("viewArticle"),
    listView: document.getElementById("viewList"),
    cat: document.getElementById("artCat"),
    time: document.getElementById("artTime"),
    title: document.getElementById("artTitle"),
    sapo: document.getElementById("artSapo"),
    lead: document.getElementById("artLead"),
    leadImg: document.getElementById("artLeadImg"),
    fullBtn: document.getElementById("artFullBtn"),
    body: document.getElementById("artBody"),
    fallback: document.getElementById("artFallback"),
    fallbackMsg: document.getElementById("artFallbackMsg"),
    fallbackQuiz: document.getElementById("artFallbackQuiz"),
    origin: document.getElementById("artOrigin"),
    originQuiz: document.getElementById("artOriginQuiz"),
    origin2: document.getElementById("artOrigin2"),
    retry: document.getElementById("artRetry"),
    summary: document.getElementById("artSummary"),
    summaryText: document.getElementById("artSummaryText"),
    sumAiBtn: document.getElementById("sumAiBtn"),
    ttsBtn: document.getElementById("ttsBtn"),
    ttsRateBtn: document.getElementById("ttsRateBtn"),
  };

  const articleCache = new Map(); // article link -> sanitized html
  const artState = { link: null, viaPush: false, extractive: "" };
  // Item behind the article on screen - the detail-page path renders from
  // the body alone, so keep the title/sapo/link for window.NewsChat.
  let artItem = null;

  // Rendered cards by article link - lets card clicks transition to the
  // article view in place (pushState) instead of a full page load.
  const itemIndex = new Map();
  function registerItems(items) {
    (items || []).forEach((i) => itemIndex.set(i.link, i));
  }

  // VnExpress slugs end in "-<id>.html", e.g.
  // /news/thuoc-ung-thu-qua-dat-5141250.html
  function currentSlug() {
    const m = /\/((?:[a-z0-9]+-)+\d+)\.html?$/i.exec(decodeURI(location.pathname));
    return m ? m[1] : null;
  }

  // Cards link to the slug.html path (served by 404.html on GitHub Pages)
  function relativeSlug(link) {
    const m = /^https:\/\/vnexpress\.net\/([a-z0-9-]+-\d+\.html)(?:[?#].*)?$/i.exec(
      link || ""
    );
    return m ? m[1] : link || "#";
  }

  // "Về trang này" is a desktop sidebar card: on phones the sidebar is
  // pinned above the article, where the reader has priority over meta copy,
  // so JS hides it below 1024px (the markup ships it visible, so it still
  // shows up if this script never runs). CSS also drops it below 640px.
  const wideLayout = window.matchMedia("(min-width: 1024px)");
  const aboutBox = document.querySelector(".side-about");
  function syncAboutBox() {
    const stats = document.documentElement.classList.contains("stats-view");
    if (aboutBox) aboutBox.hidden = stats || !wideLayout.matches;
  }
  syncAboutBox();
  wideLayout.addEventListener("change", syncAboutBox);

  function showView(name) {
    artEls.listView.hidden = name !== "list";
    artEls.view.hidden = name !== "article";
    // The stats view is server-rendered into 404.html and driven by
    // js/stats.js, which loads after this script and draws once it sees
    // #viewStats visible (see /.stats-view).
    const statsView = document.getElementById("viewStats");
    if (statsView) statsView.hidden = name !== "stats";
    document.documentElement.classList.toggle("stats-view", name === "stats");
    syncAboutBox();
    broadcastArticleView(name);
  }

  // Tells js/chatbot.js which article the reader is looking at (null when
  // the page shows a list or the stats). showView() runs before a reader
  // is re-rendered, so on the article path it emits from a microtask -
  // after the synchronous render, and still before the network response
  // that would paint the new body. The null case is synchronous: leaving
  // the reader must clear the chat's context on the spot.
  function broadcastArticleView(name) {
    const clear = () => dispatchArticle(null);
    if (document.documentElement.classList.contains("stats-view")) return clear();
    const link = name === "article" ? artState.link : null;
    if (!link || window.location.pathname.indexOf(relativeSlug(link)) < 0) return clear();
    queueMicrotask(() => {
      // the reader may have moved on (another article, or back to a list)
      if (artState.link !== link || document.documentElement.classList.contains("stats-view")) {
        return dispatchArticle(null);
      }
      dispatchArticle({
        link,
        // prefer the rendered header, but loadArticle() emits before the
        // snapshots resolve and only knows the title from the fetched HTML
        title: (artEls.title && artEls.title.textContent.trim()) || (artItem && artItem.title) || "",
        sapo: (artEls.sapo && artEls.sapo.textContent) || "",
      });
    });
  }

  // The event is optional for readers of app.js: a missing constructor
  // (very old browsers) must not take the reader down with it.
  function dispatchArticle(detail) {
    try {
      document.dispatchEvent(new CustomEvent("news24:article", { detail }));
    } catch {}
  }

  const ALLOWED_TOP = new Set([
    "P", "H2", "H3", "H4", "FIGURE", "TABLE", "UL", "OL",
    "BLOCKQUOTE", "IMG", "HR",
  ]);
  // Same set as a CSS selector - used to tell a layout wrapper (has
  // readable blocks inside, worth unwrapping) from junk to just drop.
  const ALLOWED_TOP_SELECTOR = [...ALLOWED_TOP]
    .map((t) => (t === "IMG" || t === "HR" ? t : t.toLowerCase()))
    .join(",");
  const STRIP_SELECTOR = [
    "script", "style", "iframe", "form", "input", "button", "noscript",
    "svg", "video", "audio", "object", "embed", "source", "h1",
    "meta", "link", "template", "p.description", ".title-detail", ".author",
    "[class*='list-news']", "[class*='box-']", "[class*='tag-']",
    "[class*='sidebar']", "[class*='banner']", "[class*='newsletter']",
    "[class*='subscribe']", "[class*='hidden']", "[class*='ad-']",
    "[id*='banner']",
  ].join(",");

  // Full-text fetch chain: jina (server-rendered HTML) goes first alone -
  // fast and clean, but rate-limited. When it fails, the remaining public
  // proxies race in parallel so one slow/hung source cannot drag out the
  // whole chain (allorigins often needs 5-10s; corsproxy.io died in 2026
  // and serves its own landing page instead).
  async function fetchArticleHtml(url) {
    const trySource = async (name, srcUrl, ms, headers) => {
      const res = await fetchWithTimeout(srcUrl, ms, headers);
      if (!res.ok) throw new Error(name + " HTTP " + res.status);
      const doc = new DOMParser().parseFromString(await res.text(), "text/html");
      const fck = doc.querySelector(".fck_detail");
      if (fck) {
        if (fck.textContent.trim().length > 200) return fck.cloneNode(true);
        // quiz/poll/live template: the body is a client-side widget
        // (data-component-type / data-widget placeholder) - VnExpress's own
        // JS renders it, so NO proxy can ever return it as static HTML
        if (fck.querySelector("[data-component-type], [data-widget]")) {
          const err = new Error(name + " interactive-only article");
          err.interactive = true;
          throw err;
        }
      }
      throw new Error(name + " thin/missing fck_detail");
    };
    const enc = encodeURIComponent(url);
    try {
      // jina alone: usual case resolves in ~1-2s
      return await trySource(
        "jina", "https://r.jina.ai/" + url, 12000,
        { "X-Return-Format": "html" }
      );
    } catch (e) {
      // interactive widget: no source can help, skip the proxy race
      if (e.interactive) throw e;
      // rate-limited or down: race the fallbacks, first valid body wins
      const fallbacks = [
        trySource("allorigins", "https://api.allorigins.win/raw?url=" + enc, 25000),
        trySource("codetabs", "https://api.codetabs.com/v1/proxy?quest=" + enc, 25000),
      ];
      try {
        return await Promise.any(fallbacks);
      } catch (agg) {
        const inter = (agg.errors || []).find((x) => x && x.interactive);
        throw inter || agg;
      }
    }
  }

  // Turn a cloned .fck_detail into safe reader HTML:
  // whitelist top-level tags, strip scripts/junk boxes, resolve
  // lazy-loaded images (data-src), neutralize every other attribute.
  function sanitizeArticle(rootClone, articleUrl) {
    // Videos first: the strip pass below drops <video>/<source>/<iframe>,
    // and VnExpress keeps the real player inside .box_embed_video, which
    // the junk-box selector would remove too. Replace each clip with a
    // clean <video> block we build ourselves, before anything is stripped.
    liftVideos(rootClone, articleUrl);

    // The blocks liftVideos() just built are ours, not VnExpress's junk boxes
    // (.box_embed_video matches "[class*='box_']"), so they are exempt.
    const own = (n) => n.closest("figure.rd-video");
    rootClone.querySelectorAll(STRIP_SELECTOR).forEach((n) => {
      if (!own(n)) n.remove();
    });

    // unwrap <picture> so one plain <img> survives
    rootClone.querySelectorAll("picture").forEach((pic) => {
      const img = pic.querySelector("img");
      if (img) pic.replaceWith(img);
      else pic.remove();
    });

    // images: real URL may sit in data-src (lazy loading placeholder in src)
    rootClone.querySelectorAll("img").forEach((img) => {
      const real = decodeAmp(
        img.getAttribute("data-src") || img.getAttribute("src") || ""
      );
      [...img.attributes].forEach((a) => img.removeAttribute(a.name));
      if (/^https?:\/\//i.test(real)) {
        img.setAttribute("src", real);
        img.setAttribute("alt", "Ảnh minh họa");
        img.setAttribute("loading", "lazy");
        img.setAttribute("referrerpolicy", "no-referrer");
        img.onerror = () => img.remove();
      } else {
        img.remove();
      }
    });

    // links: VnExpress article URLs become internal slug pages so
    // readers stay on-site; anything else http(s) opens off-site
    rootClone.querySelectorAll("a").forEach((a) => {
      const href = decodeAmp(a.getAttribute("href") || "");
      [...a.attributes].forEach((x) => a.removeAttribute(x.name));
      const slug = relativeSlug(href);
      if (/^https:\/\/vnexpress\.net\//i.test(href) && slug !== href) {
        a.setAttribute("href", slug); // internal article page, same tab
      } else if (/^https?:\/\//i.test(href)) {
        a.setAttribute("href", href);
        a.setAttribute("target", "_blank");
        a.setAttribute("rel", "noopener");
      } else {
        a.replaceWith(...a.childNodes); // unwrap javascript:/anchor links
      }
    });

    // everything else: drop attributes on EVERY remaining element.
    // VnExpress wraps photos in <div class="fig-picture" style=
    // "padding-bottom:132.8%"> lazy-load hacks; keeping that style would
    // push the figcaption hundreds of pixels below its image.
    rootClone.querySelectorAll("*").forEach((el) => {
      if (el.tagName === "IMG" || el.tagName === "A") return; // handled above
      // our own video blocks: keep the player's attributes (controls,
      // preload, poster, src). Everything else is rebuilt below.
      if (el.tagName === "VIDEO") {
        [...el.attributes].forEach((a) => {
          if (!VIDEO_KEEP_ATTRS.has(a.name)) el.removeAttribute(a.name);
        });
        return;
      }
      if (el.classList && el.classList.contains("rd-video")) {
        [...el.attributes].forEach((a) => {
          if (a.name !== "class") el.removeAttribute(a.name);
        });
        return;
      }
      [...el.attributes].forEach((a) => el.removeAttribute(a.name));
    });

    // figures that lost their media are stray captions - drop them
    rootClone.querySelectorAll("figure").forEach((f) => {
      if (!f.querySelector("img") && !f.querySelector("video")) f.remove();
    });

    const out = document.createElement("div");
    [...rootClone.children].forEach((child) => {
      if (ALLOWED_TOP.has(child.tagName)) {
        const hasMedia = child.querySelector("img, video");
        if (!child.textContent.trim() && !hasMedia) return; // skip empty blocks
        out.appendChild(child);
        return;
      }
      // Layout wrappers: product/photo templates (item_slide_show,
      // wrap_pic, width-detail-photo) put every <p> and <img> inside
      // plain <div>s, so a flat whitelist would drop the whole body.
      // Unwrap the wrapper and lift its allowed blocks instead of
      // losing them - nested wrappers are handled height-first.
      const inner = child.querySelector(ALLOWED_TOP_SELECTOR);
      if (!inner) return; // nothing readable inside - drop the wrapper
      [...child.children].forEach((c) => flattenInto(out, c));
    });
    return out.innerHTML;
  }

  // Move `node` into `out` as an allowed top-level block, peeling away
  // wrapping <div>s first. Keeps child order while it unwraps.
  function flattenInto(out, node) {
    if (ALLOWED_TOP.has(node.tagName)) {
      const hasMedia = node.querySelector("img, video");
      if (node.textContent.trim() || hasMedia) out.appendChild(node);
      return;
    }
    // A media wrapper (block_thumb_picture, box_img_video, ...) is several
    // divs deep, so its <img> is never a direct child: lift the photos out
    // as their own blocks rather than walking past them. Only when the
    // wrapper carries no text of its own - otherwise the caption/paragraph
    // walk below already contains the photo. Detach them first so the
    // recursion cannot reach them a second time (a wrapper with several
    // photos would otherwise duplicate every one).
    if (!node.textContent.trim()) {
      [...node.querySelectorAll("img, figure.rd-video")].forEach((m) => out.appendChild(m));
    }
    [...node.children].forEach((c) => flattenInto(out, c));
  }

  // ---- videos ---------------------------------------------------------
  // VnExpress ships clips as an adaptive HLS playlist (master.m3u8, served
  // as "application/x-mpegURL"). Safari plays HLS natively; Chrome and
  // Firefox do not, so those browsers get the MP4 renditions listed inside
  // the playlist (see hlsMp4Sources()).
  //
  // The markup is a 4-level nest, and the player wrapper is display:none
  // until VnExpress's own JS builds a player inside it:
  //   <figure class="tplCaption">
  //     <div class="fig-picture">…<img data-src="poster.jpg">…</div>
  //     <div id="embed_video_N" class="box_embed_video" style="display:none">
  //       <div><div><div>
  //         <video src="…/master.m3u8"></video>
  //     <figcaption class="desc_cation">…</figcaption>
  //   </figure>
  // So the poster and caption come from the <figure>, not from next to the
  // <video>.
  const VIDEO_SRC_RE = /\.m3u8(?:[?#]|$)/i;
  // The only <video> attributes a reader-side player needs.
  const VIDEO_KEEP_ATTRS = new Set(["controls", "preload", "playsinline", "poster", "src", "data-hls"]);

  // Poster frames come from the image CDN (i1-/vcdn1-...), same as <img>.
  function isTrustedImageUrl(u) {
    return /^https:\/\/[a-z0-9-]+\.vnecdn\.net\//i.test(u || "");
  }

  // Same-origin (VnExpress CDN) only: never load media a proxy happened to
  // return from somewhere else.
  function isTrustedVideoUrl(u) {
    return /^https:\/\/d\d+\.vnecdn\.net\//i.test(u || "") && VIDEO_SRC_RE.test(u || "");
  }

  function buildVideoBlock(src, poster, caption, sourceUrl) {
    const fig = document.createElement("figure");
    fig.className = "rd-video";
    const video = document.createElement("video");
    video.setAttribute("controls", "");
    video.setAttribute("preload", "metadata");
    video.setAttribute("playsinline", "");
    if (isTrustedImageUrl(poster)) {
      video.setAttribute("poster", poster);
    }
    // Src stays out of the markup: attachHlsPlayer() decides between native
    // HLS (Safari) and hls.js. data-hls carries the playlist through the
    // attribute sanitiser.
    video.dataset.hls = src;
    fig.appendChild(video);
    if (caption || sourceUrl) {
      const cap = document.createElement("figcaption");
      if (caption) cap.appendChild(document.createTextNode(caption));
      // The clip itself lives behind VnExpress's hotlink protection, so this
      // link is the way to actually watch it.
      if (sourceUrl) {
        const link = document.createElement("a");
        link.href = sourceUrl;
        link.target = "_blank";
        link.rel = "noopener";
        link.className = "rd-video-link";
        link.textContent = "▶ Xem video trên VnExpress";
        if (caption) cap.appendChild(document.createTextNode(" "));
        cap.appendChild(link);
      }
      fig.appendChild(cap);
    }
    return fig;
  }

  // Replace every VnExpress clip with a clean <figure class="rd-video">
  // before the strip pass removes <video>/<source>/<iframe> and the junk
  // boxes (.box_embed_video matches "[class*='box_']") that hold it.
  function liftVideos(root, sourceUrl) {
    [...root.querySelectorAll("video")].forEach((video) => {
      const src = decodeAmp(video.getAttribute("src") || "");
      if (!isTrustedVideoUrl(src)) {
        video.remove();
        return;
      }
      const vid = (/(\d+)\s*$/.exec(video.id || "") || [])[1] || "";
      // The canonical wrapper is #embed_video_N; fall back to the nearest
      // box_embed_video ancestor for markup that omits the id.
      let wrapper =
        (vid && root.querySelector(`[id='embed_video_${vid}']`)) ||
        video.closest(".box_embed_video");
      if (!wrapper || !root.contains(wrapper)) wrapper = video;

      const fig = wrapper.closest("figure") || wrapper.parentElement || wrapper;

      // poster: full-size frame from the figure <meta>, else the lazy <img>
      let poster = "";
      const meta = fig.querySelector && fig.querySelector("meta[itemprop='url']");
      if (meta) poster = (meta.getAttribute("content") || "").trim();
      if (!poster) {
        const img = fig.querySelector && fig.querySelector("img");
        if (img) poster = (img.getAttribute("data-src") || img.getAttribute("src") || "").trim();
      }
      poster = decodeAmp(poster).trim();

      const capEl = fig.querySelector && fig.querySelector(".parser_title, figcaption");
      const caption = capEl ? capEl.textContent.replace(/\s+/g, " ").trim() : "";

      const block = buildVideoBlock(src, poster, caption, sourceUrl);
      // Replace the player wrapper in place; when there is no wrapper, the
      // video itself stands in.
      wrapper.replaceWith(block);

      // Drop the figure's now-redundant poster image: it is the same frame
      // shown in the player, and its lazy <img> would render as a broken
      // picture above the video (the data-src placeholder is a 1px gif).
      if (fig && fig !== wrapper && root.contains(fig)) {
        fig.querySelectorAll("meta, picture, img").forEach((n) => n.remove());
      }
    });
  }

  // VnExpress clips are HLS (AES-128 encrypted .ts segments) served from
  // d1.vnecdn.net behind hotlink protection: the player CDN answers 406/407
  // unless the Referer is vnexpress.net, and a browser cannot forge that
  // header. So a clip embedded on this site cannot be played here at all -
  // verified against Chrome and against native <video> HLS.
  //
  // What we DO render is the still frame + the caption, plus a link that
  // opens the clip on VnExpress where it plays normally. That keeps the
  // story's visuals and order intact instead of silently dropping the
  // media, which is what the old sanitiser did.
  //
  // The player is only attached when the CDN is reachable from the current
  // origin (self-hosted / reverse-proxied deployments, where Referer checks
  // do not apply). Probing is a single HEAD per page; failure is cached so
  // github.io visitors do not pay for it on every article.
  const HLS_CDN = "https://cdn.jsdelivr.net/npm/hls.js@1.5.20/dist/hls.min.js";
  const HLS_SRI = "sha384-V5ruNBgmYcC3SJRUQeNykAAAgde5gOFq/Hu0CZj7bygDP0yRIhkvX8+w0u/7mRvr";
  const NATIVE_HLS = (() => {
    try {
      return !!document.createElement("video").canPlayType("application/vnd.apple.mpegurl");
    } catch {
      return false;
    }
  })();

  let videoCdnOk = null; // null = untested, false = hotlink-blocked
  let hlsLoading = null;
  let hlsBroken = false;

  // Can this origin actually fetch VnExpress media? One ranged GET (small,
  // cached by the CDN) answers it; 200 = yes, anything else = hotlink block.
  async function videoCdnReachable(src) {
    if (videoCdnOk !== null) return videoCdnOk;
    try {
      const res = await fetchWithTimeout(src, 8000, { Range: "bytes=0-0" });
      videoCdnOk = res.ok;
    } catch {
      videoCdnOk = false;
    }
    return videoCdnOk;
  }

  function loadHlsJs() {
    if (window.Hls) return Promise.resolve(window.Hls);
    if (hlsBroken) return Promise.reject(new Error("hls.js unavailable"));
    if (hlsLoading) return hlsLoading;
    hlsLoading = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = HLS_CDN;
      s.async = true;
      s.crossOrigin = "anonymous";
      // SRI pins the exact bytes we reviewed: a tampered CDN file fails
      // closed instead of executing.
      s.integrity = HLS_SRI;
      s.onload = () => (window.Hls ? resolve(window.Hls) : reject(new Error("hls.js missing")));
      s.onerror = () => reject(new Error("hls.js blocked"));
      document.head.appendChild(s);
    }).catch((e) => {
      hlsBroken = true; // one failure per page is enough
      throw e;
    });
    return hlsLoading;
  }

  // Mark a clip as "not playable here": keep the still frame, drop the dead
  // player chrome, and make the caption lead to the real video.
  function degradeVideo(fig, why) {
    fig.classList.add("rd-video--static");
    if (why) fig.dataset.reason = why;
    const video = fig.querySelector("video");
    if (video) {
      video.removeAttribute("controls");
      video.removeAttribute("src");
      video.setAttribute("muted", "");
    }
  }

  // Attach a player to each clip in `scope`, or degrade it to the poster.
  // Runs after every article render; cheap when the CDN is known to block.
  async function attachHlsPlayer(scope) {
    if (!scope) return;
    const figs = [...scope.querySelectorAll("figure.rd-video")];
    const pending = figs.filter((f) => !f.dataset.player);
    if (!pending.length) return;

    const first = pending[0].querySelector("video[data-hls]");
    const playlist = first && first.dataset.hls;
    if (!playlist) return;

    if (!(await videoCdnReachable(playlist))) {
      pending.forEach((f) => degradeVideo(f, "hotlink"));
      return;
    }

    if (NATIVE_HLS) {
      pending.forEach((f) => {
        f.dataset.player = "native";
        const v = f.querySelector("video");
        v.setAttribute("src", v.dataset.hls);
        v.removeAttribute("data-hls");
      });
      return;
    }

    let Hls;
    try {
      Hls = await loadHlsJs();
    } catch {
      pending.forEach((f) => degradeVideo(f, "no-hls"));
      return;
    }
    for (const fig of pending) {
      const video = fig.querySelector("video");
      if (!video || !video.dataset.hls) continue;
      fig.dataset.player = "hls";
      const src = video.dataset.hls;
      video.removeAttribute("data-hls");
      if (!Hls.isSupported()) {
        degradeVideo(fig, "unsupported");
        continue;
      }
      const hls = new Hls({ enableWorker: true });
      hls.loadSource(src);
      hls.attachMedia(video);
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data || !data.fatal) return;
        hls.destroy();
        degradeVideo(fig, "stream");
      });
    }
  }

  function urlBasename(u) {
    try {
      return new URL(u).pathname.split("/").pop();
    } catch {
      return u || "";
    }
  }

  // Find the RSS item (title, photo, sapo, category, time) behind a slug
  // by scanning the same-origin snapshots.
  async function findItemData(slug) {
    const suffix = "/" + slug + ".html";
    const results = await Promise.allSettled(
      Object.keys(CATEGORIES).map((catSlug) =>
        fetch("data/" + catSlug + ".json", { cache: "no-cache" })
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status))))
          .then((d) => ({ catSlug, items: d.items || [] }))
      )
    );
    for (const r of results) {
      if (r.status !== "fulfilled" || !r.value) continue;
      const found = r.value.items.find((it) => (it.link || "").endsWith(suffix));
      if (found) return decorate(found, r.value.catSlug);
    }
    return null;
  }

  // Snapshot may have rotated past an older article - pull title/sapo
  // straight out of the fetched article HTML instead.
  function itemFromArticle(fck, link) {
    const titleEl = fck.querySelector(".title-detail, h1");
    const sapoEl = fck.querySelector("p.description");
    return decorate(
      {
        title: titleEl ? titleEl.textContent.trim() : "Bài viết",
        link,
        pubDate: Date.now(),
        img: "",
        sapo: sapoEl ? sapoEl.textContent.trim() : "",
      },
      ""
    );
  }

  // Render body html; when the body's first photo is the same file as
  // the lead image under the headline, drop the inline copy and move
  // its credit under the lead.
  function applyArticleBody(html) {
    artEls.body.innerHTML = html;
    attachHlsPlayer(artEls.body); // lazy hls.js for Safari-less browsers
    if (artEls.lead.hidden) return;
    const leadName = urlBasename(artEls.leadImg.getAttribute("src"));
    const first = artEls.body.querySelector("img");
    if (!first || urlBasename(first.getAttribute("src")) !== leadName) return;
    const fig = first.closest("figure");
    const cap = fig ? fig.querySelector("figcaption") : null;
    const capText = cap ? cap.textContent.trim() : "";
    if (fig) fig.remove();
    else first.remove();
    if (capText) {
      const leadCap = document.createElement("figcaption");
      leadCap.textContent = capText;
      artEls.lead.appendChild(leadCap);
    }
  }

  // Offline extractive summary: sapo-style lead is already shown above,
  // so pick the first few real sentences of the body (skipping any that
  // duplicate the sapo). Vietnamese abbreviations (GS.TS., UBND., ...)
  // split prematurely, so merge fragments shorter than 30 chars forward.
  function extractSummary(item) {
    const text = (artEls.body.innerText || "").replace(/\s+/g, " ").trim();
    if (text.length < 200) return "";
    const parts = text.split(/(?<=[.!?…])\s+/);
    const sentences = [];
    for (const p of parts) {
      const s = p.trim();
      if (!s) continue;
      const last = sentences[sentences.length - 1];
      if (last !== undefined && last.length < 30) {
        sentences[sentences.length - 1] = last + " " + s;
      } else {
        sentences.push(s);
      }
    }
    const sapo = (item.sapo || "").trim();
    const picked = [];
    let len = 0;
    for (const s of sentences) {
      if (s.length < 40) continue; // headings / stray fragments
      if (sapo && (s === sapo || s.includes(sapo) || sapo.includes(s))) continue;
      picked.push(s);
      len += s.length;
      if (picked.length >= 4 || len >= 380) break;
    }
    if (!picked.length) return "";
    return picked.join(" ") + (len >= 380 ? "…" : "");
  }

  // ---- summary body: one bullet per key point ----
  // The AI/extractive text comes back as one run-on string such as
  // "- Ý một. - Ý hai. - Ý ba." (models ignore "no list" instructions and
  // the extractive pass joins sentences with a space). Split on an inline
  // bullet mark: a dash after whitespace, followed by a capital or digit.
  // That leaves in-word/number hyphens alone ("4,5-5% GDP", "e-mail").
  // No bullet marks at all -> fall back to one sentence per line.
  const SUM_BULLET = /(?<=\s)[-–—•*·]\s+(?=[\p{Lu}\p{N}"“(])/gu;

  function summaryPoints(text) {
    const raw = String(text || "").replace(/\s+/g, " ").trim();
    if (!raw) return [];
    // Drop the leading bullet mark too: the first one is not preceded by
    // whitespace, so the split above leaves it attached to point #1.
    const trim = (s) => s.trim().replace(/^[-–—•*·]\s*/, "");
    let parts = raw.split(SUM_BULLET).map(trim).filter(Boolean);
    if (parts.length < 2) {
      parts = raw.split(/(?<=[.!?…])\s+/).map((p) => p.trim()).filter(Boolean);
    }
    return parts.length ? parts : [raw];
  }

  function renderSummary(text) {
    const points = summaryPoints(text);
    artEls.summaryText.textContent = "";
    for (const p of points) {
      const li = document.createElement("li");
      li.textContent = p;
      artEls.summaryText.appendChild(li);
    }
    return points.length > 0;
  }

  // Read-aloud needs the plain words back (the TTS splitter also relies on
  // sentences ending in ./!/?/…, not on the bullet marks).
  function summarySpeech() {
    return Array.from(artEls.summaryText.children)
      .map((li) => (li.textContent || "").trim().replace(/[.!?…]?$/, "."))
      .join(" ");
  }

  function renderArticleHeader(item) {
    document.title = item.title + " - News24";
    artEls.cat.textContent = item.cat || "Tin tức";
    artEls.title.textContent = item.title;
    artEls.time.textContent = timeAgo(item.pubDate) + " · nguồn VnExpress";
    artEls.sapo.textContent = item.sapo || "";
    artEls.lead.querySelectorAll("figcaption").forEach((c) => c.remove());
    if (item.img) {
      artEls.leadImg.src = item.img;
      artEls.lead.hidden = false;
    } else {
      artEls.lead.hidden = true;
    }
    artEls.fullBtn.href = artEls.origin.href = artEls.origin2.href = item.link;
  }

  function renderArticleBody(item, fckOrHtml, err) {
    let html = null;
    if (typeof fckOrHtml === "string") {
      html = fckOrHtml;
    } else if (fckOrHtml) {
      html = sanitizeArticle(fckOrHtml, item.link);
    }
    const textLen = html ? html.replace(/<[^>]*>/g, "").trim().length : 0;
    if (html && textLen >= 80) {
      articleCache.set(item.link, html);
      saveArticleHtml(item.link, html);
      applyArticleBody(html);
      artEls.fallback.hidden = true;
      // summary: AI is the default method. The instant offline extractive
      // version paints first as a placeholder, then the AI text swaps in
      // when it arrives (or instantly from the 7-day cache on repeat views).
      const extractive = extractSummary(item);
      artState.extractive = extractive;
      renderSummary(extractive);
      artEls.summary.hidden = !extractive;
      const ai = loadAiSummary(item.link);
      if (ai) {
        renderSummary(ai);
        artEls.sumAiBtn.textContent = "↺ Bản rút trích";
        artEls.sumAiBtn.disabled = false;
        artEls.sumAiBtn.classList.remove("busy");
      } else if (extractive) {
        // kick off the AI summary in the background; busy button until done
        artEls.sumAiBtn.disabled = true;
        artEls.sumAiBtn.classList.add("busy");
        artEls.sumAiBtn.textContent = "✨ Đang tóm tắt AI...";
        runAiSummary(item.link);
      } else {
        artEls.sumAiBtn.disabled = true;
        artEls.sumAiBtn.textContent = "✨ Tóm tắt bằng AI";
      }
    } else {
      // graceful degrade: lead image + sapo already shown above -
      // surface the explanation plus the always-visible full-article link
      artEls.body.innerHTML = "";
      artEls.fallback.hidden = false;
      artEls.summary.hidden = true;
      const quiz = !!(err && err.interactive);
      if (artEls.fallbackMsg) artEls.fallbackMsg.hidden = quiz;
      if (artEls.fallbackQuiz) {
        artEls.fallbackQuiz.hidden = !quiz;
        if (quiz) artEls.originQuiz.href = item.link;
      }
    }
  }

  // ---- AI summary ----
  // Two free, key-less, CORS-enabled providers, tried in order:
  //   1. OVH "Kepler" public OpenAI-compatible endpoint - Mistral Small 24B
  //      answers in ~3.3s (fastest of the six models measured; the Qwen and
  //      gpt-oss-* ones burn their whole budget on hidden reasoning and
  //      returned an empty `content`). Limit: 2 requests/minute per IP.
  //   2. Pollinations - GPT-OSS 20B, ~8-17s and only 1 reply every 45s,
  //      kept as the fallback because it is a different network entirely.
  // Both expose their limits in headers, so the governor below paces itself
  // instead of hammering them until they answer 429/402.
  const AI_TTL = 7 * 24 * 3600e3; // summaries rarely go stale - cache a week

  function loadAiSummary(link) {
    try {
      const raw = localStorage.getItem("news24:ai:" + link + ":" + cacheBuster());
      if (!raw) return null;
      const { t, text } = JSON.parse(raw);
      if (!text || Date.now() - (t || 0) > AI_TTL) return null;
      return text;
    } catch {
      return null;
    }
  }

  function saveAiSummary(link, text) {
    try {
      localStorage.setItem(
        "news24:ai:" + link + ":" + cacheBuster(),
        JSON.stringify({ t: Date.now(), text })
      );
    } catch {}
  }

  // ---- user settings (BYOK) ----
  // Everything the settings dialog writes lives under one localStorage key,
  // so it is trivial to inspect, reset, or clear from devtools.
  const AI_CFG_KEY = "news24:aicfg";

  const AI_PROMPT_DEFAULT =
    "Bạn là trợ lý tóm tắt tin tức. Tóm tắt bài báo thành 3-4 câu " +
    "ngắn gọn, chắt lọc ý chính, bằng tiếng Việt. Chỉ trả về nội " +
    "dung tóm tắt, không mở đầu, không liệt kê.";

  // `keyless: true` providers need no account and are the default; any
  // other choice needs the user's own API key (BYOK), stored locally only.
  const AI_CFG_DEFAULT = {
    provider: "ovh-mistral",
    model: "", // blank = provider default
    apiKey: "",
    prompt: AI_PROMPT_DEFAULT,
    maxTokens: 400,
    temperature: 0.3,
  };

  // Provider catalogue. Every entry is an OpenAI-compatible chat endpoint
  // except Gemini and Anthropic, which get their own builders. `perMinute`
  // seeds the rate-limit governor; 0 means "user's own key, don't pace".
  const AI_CATALOG = {
    "ovh-mistral": {
      label: "OVH Kepler — Mistral Small (miễn phí)",
      url: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions",
      perMinute: 2,
      keyless: true,
      model: "Mistral-Small-3.2-24B-Instruct-2506",
      models: [
        "Mistral-Small-3.2-24B-Instruct-2506",
        "Meta-Llama-3_3-70B-Instruct",
        "gpt-oss-20b",
      ],
    },
    "pollinations": {
      label: "Pollinations — GPT-OSS 20B (miễn phí)",
      url: "https://text.pollinations.ai/",
      perMinute: 1,
      keyless: true,
      model: "openai-fast",
      models: ["openai-fast"],
    },
    openai: {
      label: "OpenAI",
      url: "https://api.openai.com/v1/chat/completions",
      perMinute: 0,
      model: "gpt-4o-mini",
      models: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini", "gpt-4.1-nano"],
    },
    gemini: {
      label: "Google Gemini",
      url: "https://generativelanguage.googleapis.com/v1beta/models",
      perMinute: 0,
      model: "gemini-2.0-flash",
      models: ["gemini-2.0-flash", "gemini-2.5-flash", "gemini-1.5-flash"],
    },
    deepseek: {
      label: "DeepSeek",
      url: "https://api.deepseek.com/chat/completions",
      perMinute: 0,
      model: "deepseek-chat",
      models: ["deepseek-chat", "deepseek-reasoner"],
    },
    groq: {
      label: "Groq",
      url: "https://api.groq.com/openai/v1/chat/completions",
      perMinute: 0,
      model: "llama-3.3-70b-versatile",
      models: [
        "llama-3.3-70b-versatile",
        "llama-3.1-8b-instant",
        "mixtral-8x7b-32768",
      ],
    },
    openrouter: {
      label: "OpenRouter",
      url: "https://openrouter.ai/api/v1/chat/completions",
      perMinute: 0,
      model: "google/gemini-2.0-flash-001",
      models: [
        "google/gemini-2.0-flash-001",
        "openai/gpt-4o-mini",
        "anthropic/claude-3.5-haiku",
        "meta-llama/llama-3.3-70b-instruct",
      ],
    },
    anthropic: {
      label: "Anthropic Claude",
      url: "https://api.anthropic.com/v1/messages",
      perMinute: 0,
      model: "claude-3-5-haiku-20241022",
      models: [
        "claude-3-5-haiku-20241022",
        "claude-sonnet-4-20250514",
        "claude-3-5-sonnet-20241022",
      ],
    },
    custom: {
      label: "Tuỳ chỉnh (OpenAI-compatible)",
      url: "",
      perMinute: 0,
      model: "",
      models: [],
      custom: true,
    },
  };

  function loadAiCfg() {
    try {
      const raw = localStorage.getItem(AI_CFG_KEY);
      if (!raw) return { ...AI_CFG_DEFAULT };
      const saved = JSON.parse(raw);
      const cfg = { ...AI_CFG_DEFAULT, ...saved };
      if (!AI_CATALOG[cfg.provider]) cfg.provider = AI_CFG_DEFAULT.provider;
      if (!cfg.prompt || !cfg.prompt.trim()) cfg.prompt = AI_PROMPT_DEFAULT;
      return cfg;
    } catch {
      return { ...AI_CFG_DEFAULT };
    }
  }

  function saveAiCfg(cfg) {
    try {
      localStorage.setItem(AI_CFG_KEY, JSON.stringify(cfg));
    } catch {}
  }

  let aiCfg = loadAiCfg();

  // The summary cache is keyed by provider+model+prompt, so changing any of
  // them does not silently serve text produced under the old settings.
  function cacheBuster() {
    const sig = [aiCfg.provider, aiCfg.model, aiCfg.prompt].join("|");
    let h = 5381;
    for (let i = 0; i < sig.length; i++) h = ((h << 5) + h + sig.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  // Turns the current settings into concrete requests. The chosen BYOK
  // provider is tried first; the two key-less ones stay behind it as a
  // safety net so a bad key or a missing model degrades instead of dying.
  // Gemini and Anthropic are not OpenAI-shaped, hence their own builders.
  function buildAiPlan() {
    const plan = [];
    const { provider, model, apiKey, prompt, maxTokens, temperature } = aiCfg;
    const key = apiKey.trim();
    const mdl = (model || "").trim();

    if (provider === "gemini") {
      plan.push({
        name: "gemini",
        url: `${AI_CATALOG.gemini.url}/${encodeURIComponent(mdl || AI_CATALOG.gemini.model)}:generateContent`,
        perMinute: 0,
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: prompt }] },
          contents: [{ role: "user", parts: [{ text: "{CONTENT}" }] }],
          generationConfig: { maxOutputTokens: maxTokens, temperature },
        }),
        extract: (json) =>
          (json?.candidates?.[0]?.content?.parts || [])
            .map((p) => p.text || "")
            .join("")
            .trim(),
      });
    } else if (provider === "anthropic") {
      plan.push({
        name: "anthropic",
        url: AI_CATALOG.anthropic.url,
        perMinute: 0,
        headers: {
          "Content-Type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
          // Anthropic blocks browser calls unless the caller opts in; this
          // is their documented header for exactly this use case.
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
          model: mdl || AI_CATALOG.anthropic.model,
          max_tokens: maxTokens,
          temperature,
          system: prompt,
          messages: [{ role: "user", content: "{CONTENT}" }],
        }),
        extract: (json) =>
          (json?.content || []).map((c) => c.text || "").join("").trim(),
      });
    } else {
      const cat = AI_CATALOG[provider];
      const headers = { "Content-Type": "application/json" };
      if (key) headers.Authorization = "Bearer " + key;
      plan.push({
        name: provider,
        // A custom provider's endpoint lives in the settings, not the catalog
        url: (cat.custom ? aiCfg.customUrl || "" : cat.url).trim(),
        perMinute: cat.perMinute,
        headers,
        body: JSON.stringify({
          model: mdl || cat.model,
          max_tokens: maxTokens,
          temperature,
          messages: [
            { role: "system", content: prompt },
            { role: "user", content: "{CONTENT}" },
          ],
        }),
        extract: (json) => json?.choices?.[0]?.message?.content || "",
        isText: provider === "pollinations",
      });
    }

    // Key-less fallbacks, unless the user already picked one of them.
    for (const name of ["ovh-mistral", "pollinations"]) {
      if (name === provider) continue;
      const cat = AI_CATALOG[name];
      plan.push({
        name,
        url: cat.url,
        perMinute: cat.perMinute,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: cat.model,
          max_tokens: maxTokens,
          temperature,
          messages: [
            { role: "system", content: prompt },
            { role: "user", content: "{CONTENT}" },
          ],
        }),
        extract: (json) => json?.choices?.[0]?.message?.content || "",
        isText: name === "pollinations",
      });
    }
    return plan.filter((p) => p.url);
  }

  // ---- rate-limit governor ----
  // Tracks one timestamp queue per provider and refuses to send a request
  // that would exceed its per-minute cap; the caller is told how long to
  // wait. Retry-After / ratelimit-reset headers are folded back in so the
  // server's own pacing wins over our estimate.
  const aiGate = new Map(); // provider name -> { sent: [ms], blockedUntil: ms }

  function gateOf(name) {
    let g = aiGate.get(name);
    if (!g) aiGate.set(name, (g = { sent: [], blockedUntil: 0 }));
    return g;
  }

  // Milliseconds to wait before `provider` may be called (0 = go now).
  function gateWait(provider) {
    const g = gateOf(provider.name);
    const now = Date.now();
    let wait = Math.max(0, g.blockedUntil - now);
    g.sent = g.sent.filter((t) => now - t < 60000);
    if (g.sent.length >= provider.perMinute) {
      // oldest request in the window frees a slot 60s after it was sent
      const freesAt = g.sent[0] + 60000;
      wait = Math.max(wait, freesAt - now);
    }
    return wait;
  }

  function gateRecord(provider, res) {
    const g = gateOf(provider.name);
    g.sent.push(Date.now());
    const retryAfter = parseFloat(res.headers.get("retry-after"));
    const reset = parseFloat(
      res.headers.get("ratelimit-reset") || res.headers.get("x-ratelimit-reset")
    );
    const secs = Number.isFinite(retryAfter)
      ? retryAfter
      : Number.isFinite(reset)
      ? reset
      : 0;
    if (secs > 0) g.blockedUntil = Math.max(g.blockedUntil, Date.now() + secs * 1000);
  }

  // Sends one summarization request, respecting the governor. Resolves to
  // { text } on success, or { error } describing why this provider failed.
  async function aiRequest(provider, content) {
    if (gateWait(provider) > 0) {
      return { error: "rate" }; // skip it - the next provider may be free
    }
    const body = provider.body.split("{CONTENT}").join(JSON.stringify(content).slice(1, -1));
    let res;
    try {
      res = await fetchWithTimeout(provider.url, 60000, provider.headers, {
        method: "POST",
        body,
      });
    } catch (e) {
      return { error: "network" };
    }
    gateRecord(provider, res);
    if (!res.ok) {
      return { error: res.status === 401 || res.status === 403
        ? "key" // bad/missing API key - surfaced to the user, not retried
        : "HTTP " + res.status };
    }
    let text = "";
    try {
      text = provider.isText
        ? await res.text()
        : provider.extract(await res.json());
    } catch {
      return { error: "bad payload" };
    }
    text = (text || "").trim();
    if (!text || text.length < 20 || text.length > 1500) {
      return { error: "bad payload" };
    }
    return { text };
  }

  // Tries each provider in order; the first real summary wins. A provider
  // that is rate-limited, down or returns junk just hands over to the next.
  // A rejected API key is different: it is reported instead of silently
  // falling back, so the user knows their BYOK settings are wrong.
  async function aiSummarize() {
    const body = (artEls.body.innerText || "").replace(/\s+/g, " ").trim();
    if (body.length < 200) throw new Error("no body");
    const content = body.slice(0, 6000);
    const plan = buildAiPlan();
    if (!plan.length) throw new Error("AI no endpoint");
    let lastErr = "no provider";
    let sawKeyErr = false;
    for (const provider of plan) {
      const out = await aiRequest(provider, content);
      if (out.text) return out.text;
      lastErr = out.error;
      if (out.error === "key") sawKeyErr = true; // remember, do not abort
      if (out.error === "rate") continue; // try the next provider right away
    }
    // A rejected key is the most actionable failure, even when a later
    // provider failed for an unrelated reason - surface it instead.
    throw new Error(sawKeyErr ? "AI key" : "AI " + lastErr);
  }

  // ------------------------------------------------------------------
  // Bridge for js/chatbot.js
  // ------------------------------------------------------------------
  // The chatbot ships as its own script and needs four things from here:
  // the open article, article bodies by link, the snapshot item list, and
  // the provider chain above (with its rate-limit governor). Nothing below
  // renders or reasons about conversation - that stays in chatbot.js.
  function articleUrl(link) {
    return /^https:\/\/vnexpress\.net\/[a-z0-9-]+-\d+\.html$/i.test(link || "")
      ? link
      : "";
  }

  // Sanitized reader HTML -> plain text for a model prompt: block ends
  // become sentence stops so the text does not run words together.
  function htmlToText(html) {
    const box = document.createElement("div");
    box.innerHTML = html || "";
    box.querySelectorAll(
      "p,h2,h3,h4,li,blockquote,figcaption,td,th,br,hr"
    ).forEach((n) => n.append(" "));
    return (box.textContent || "").replace(/\s+/g, " ").trim();
  }

  // One chat turn. chat(spec) takes the messages because the caller writes
  // the instructions; buildAiPlan() still owns provider choice, and the
  // returned providers keep `perMinute: 0` for key-less endpoints, which
  // the governor reads as "waiting is not worth it" - so pacing is redone
  // here from the catalogue value.
  async function aiChatTurn(spec) {
    const messages = ((spec && spec.messages) || []).filter(
      (m) => m && typeof m.content === "string" && m.content.trim() &&
        (m.role === "user" || m.role === "assistant")
    );
    if (!messages.length) throw new Error("AI no messages");
    const system = String((spec && spec.system) || "").trim();
    const maxTokens = Math.min(2048, Math.max(64, (spec && spec.maxTokens) || 600));
    const rawTemp = spec ? parseFloat(spec.temperature) : NaN;
    const temperature = Number.isFinite(rawTemp)
      ? Math.min(2, Math.max(0, rawTemp))
      : 0.2;

    // Same credentials as buildAiPlan(), different message list: the
    // summary prompt stays out of the conversation entirely.
    const saved = aiCfg;
    aiCfg = { ...saved, prompt: system, maxTokens, temperature };
    let plan;
    try {
      plan = buildAiPlan();
    } finally {
      aiCfg = saved;
    }
    if (!plan.length) throw new Error("AI no endpoint");

    const chatMessages = messages.slice(-12);
    // Every provider template carries the turn as one "{CONTENT}" user
    // message, so the conversation is flattened into a JSON block there.
    const turn = JSON.stringify(chatMessages);
    let lastErr = "no provider";
    let sawKey = false;
    for (const p of plan) {
      const perMinute =
        p.perMinute || (AI_CATALOG[p.name] && AI_CATALOG[p.name].perMinute) || 0;
      if (perMinute > 0 && gateWait({ name: p.name, perMinute }) > 0) {
        lastErr = "rate"; // skip it - another provider may still be free
        continue;
      }
      const body = p.body.split("{CONTENT}").join(JSON.stringify(turn).slice(1, -1));
      let res;
      try {
        res = await fetchWithTimeout(p.url, 60000, p.headers, { method: "POST", body });
      } catch {
        lastErr = "network";
        continue;
      }
      gateRecord({ name: p.name, perMinute }, res);
      if (res.status === 401 || res.status === 403) {
        sawKey = true;
        lastErr = "key";
        continue;
      }
      if (!res.ok || res.status === 429 || res.status === 402) {
        lastErr = "rate"; // 402 = Pollinations out of its free quota
        continue;
      }
      let text = "";
      let toolCalls = null;
      try {
        if (p.isText) {
          text = await res.text();
        } else {
          const json = await res.json();
          const msg = json && json.choices && json.choices[0] && json.choices[0].message;
          // A model that answers with a tool call puts NOTHING in `content`
          // (measured: OVH/Mistral returns content: undefined, finish_reason
          // "tool_calls"). Reading content alone would drop the call and let
          // the raw JSON leak into the reply, so prefer the structured
          // calls and re-serialise them into the one shape chatbot.js parses.
          if (msg && Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
            const fn = msg.tool_calls[0].function || {};
            toolCalls = { name: fn.name, arguments: fn.arguments };
          } else {
            text = p.extract(json);
          }
        }
      } catch {
        lastErr = "bad payload";
        continue;
      }
      if (toolCalls) {
        return { text: JSON.stringify(toolCalls), toolCalls }; // toolCalls: a parse, not a guess
      }
      text = (text || "").trim();
      if (!text) {
        lastErr = "empty answer";
        continue;
      }
      return { text };
    }
    throw new Error(sawKey ? "AI key" : "AI " + lastErr);
  }

  // Snapshot items merged across categories (one article usually appears in
  // several), newest first. Cached for the session - a page load is not
  // going to see fresher data than the list view already fetched.
  let allItemsPromise = null;
  function allItems() {
    if (allItemsPromise) return allItemsPromise;
    allItemsPromise = Promise.allSettled(
      Object.keys(CATEGORIES).map((catSlug) =>
        fetch("data/" + catSlug + ".json", { cache: "no-cache" })
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status))))
          .then((d) => (d.items || []).map((it) => decorate(it, catSlug)))
      )
    ).then((results) => {
      const byLink = new Map();
      results.forEach((r) => {
        if (r.status !== "fulfilled") return;
        r.value.forEach((it) => {
          if (it.link && !byLink.has(it.link)) byLink.set(it.link, it);
        });
      });
      const items = [...byLink.values()].sort((a, b) => b.pubDate - a.pubDate);
      // an empty snapshot set (offline, first load) must not stick
      if (!items.length) allItemsPromise = null;
      return items;
    });
    return allItemsPromise;
  }

  // Background AI summary run (auto-triggered on render when not cached).
  // One run per link at a time; on failure the extractive version stays
  // visible and the button offers a manual retry.
  let aiInFlight = null;
  async function runAiSummary(link) {
    if (aiInFlight === link) return;
    aiInFlight = link;
    try {
      const text = await aiSummarize();
      saveAiSummary(link, text); // cache even if the user navigated away
      if (artState.link === link) {
        renderSummary(text);
        artEls.sumAiBtn.textContent = "↺ Bản rút trích";
      }
    } catch (e) {
      if (artState.link === link) {
        // keep the instant extractive summary on screen; the free
        // providers are IP-rate-limited, so offer a manual retry
        artEls.sumAiBtn.textContent =
          e && e.message === "AI key" ? "⚠ Kiểm tra API key" : "✨ Thử lại AI";
      }
    } finally {
      if (artState.link === link) {
        artEls.sumAiBtn.disabled = false;
        artEls.sumAiBtn.classList.remove("busy");
      }
      if (aiInFlight === link) aiInFlight = null;
    }
  }

  artEls.sumAiBtn.addEventListener("click", async () => {
    const link = artState.link;
    if (!link) return;
    if (artEls.sumAiBtn.textContent.includes("rút trích")) {
      // AI text is showing: toggle back to the offline extractive version
      renderSummary(artState.extractive || "");
      artEls.sumAiBtn.textContent = "✨ Tóm tắt bằng AI";
      return;
    }
    const cached = loadAiSummary(link);
    if (cached) {
      // previously generated, just not showing (user toggled back)
      renderSummary(cached);
      artEls.sumAiBtn.textContent = "↺ Bản rút trích";
      return;
    }
    artEls.sumAiBtn.disabled = true;
    artEls.sumAiBtn.classList.add("busy");
    artEls.sumAiBtn.textContent = "✨ Đang tóm tắt AI...";
    await runAiSummary(link);
  });

  // ---- settings dialog ----
  // The form is a plain <dialog>; values are read on open from `aiCfg` and
  // committed on "Lưu". Saving drops the in-memory AI cache only when the
  // provider/model/prompt actually changed, since the cache key embeds them.
  const cfgEls = {
    btn: document.getElementById("aiCfgBtn"),
    dlg: document.getElementById("aiCfgDialog"),
    provider: document.getElementById("cfgProvider"),
    providerHint: document.getElementById("cfgProviderHint"),
    model: document.getElementById("cfgModel"),
    modelList: document.getElementById("cfgModelList"),
    keyWrap: document.getElementById("cfgKeyWrap"),
    apiKey: document.getElementById("cfgApiKey"),
    reveal: document.getElementById("cfgReveal"),
    urlWrap: document.getElementById("cfgUrlWrap"),
    url: document.getElementById("cfgUrl"),
    prompt: document.getElementById("cfgPrompt"),
    maxTokens: document.getElementById("cfgMaxTokens"),
    temp: document.getElementById("cfgTemp"),
    status: document.getElementById("cfgStatus"),
    save: document.getElementById("cfgSave"),
    reset: document.getElementById("cfgReset"),
  };
  const customUrls = {}; // provider -> endpoint, remembered across opens

  function cfgStatus(msg, kind) {
    if (!cfgEls.status) return;
    cfgEls.status.textContent = msg || "";
    cfgEls.status.hidden = !msg;
    cfgEls.status.className = "ai-cfg-status" + (kind ? " " + kind : "");
  }

  function syncCfgFields() {
    const id = cfgEls.provider.value;
    const cat = AI_CATALOG[id] || AI_CATALOG[AI_CFG_DEFAULT.provider];
    const needsKey = !cat.keyless;
    if (cfgEls.keyWrap) cfgEls.keyWrap.hidden = !needsKey;
    if (cfgEls.urlWrap) cfgEls.urlWrap.hidden = !cat.custom;
    if (cfgEls.model) cfgEls.model.placeholder = cat.model || "Để trống dùng mặc định";
    if (cfgEls.modelList) {
      cfgEls.modelList.innerHTML = (cat.models || [])
        .map((m) => '<option value="' + m + '"></option>')
        .join("");
    }
    if (cfgEls.providerHint) {
      cfgEls.providerHint.textContent = cat.keyless
        ? "Miễn phí, không cần API key. Giới hạn theo IP nên có thể phải chờ giữa các lần."
        : "Cần API key của bạn. Key lưu cục bộ trong trình duyệt này.";
    }
  }

  function openCfg() {
    if (!cfgEls.dlg) return;
    if (cfgEls.provider) {
      cfgEls.provider.innerHTML = Object.entries(AI_CATALOG)
        .map(
          ([id, cat]) =>
            '<option value="' + id + '">' + cat.label + "</option>"
        )
        .join("");
      cfgEls.provider.value = aiCfg.provider;
    }
    if (cfgEls.model) cfgEls.model.value = aiCfg.model || "";
    if (cfgEls.apiKey) cfgEls.apiKey.value = aiCfg.apiKey || "";
    if (cfgEls.apiKey) cfgEls.apiKey.type = "password";
    if (cfgEls.url) cfgEls.url.value = customUrls[aiCfg.provider] || aiCfg.customUrl || "";
    if (cfgEls.prompt) cfgEls.prompt.value = aiCfg.prompt || AI_PROMPT_DEFAULT;
    if (cfgEls.maxTokens) cfgEls.maxTokens.value = aiCfg.maxTokens;
    if (cfgEls.temp) cfgEls.temp.value = aiCfg.temperature;
    cfgStatus("");
    syncCfgFields();
    if (typeof cfgEls.dlg.showModal === "function") cfgEls.dlg.showModal();
    else cfgEls.dlg.setAttribute("open", "");
  }

  function closeCfg() {
    if (!cfgEls.dlg) return;
    if (typeof cfgEls.dlg.close === "function") cfgEls.dlg.close();
    else cfgEls.dlg.removeAttribute("open");
  }

  if (cfgEls.btn) cfgEls.btn.addEventListener("click", openCfg);
  if (cfgEls.provider) {
    cfgEls.provider.addEventListener("change", () => {
      // remember a custom endpoint before switching away from it
      if (cfgEls.url) customUrls[cfgEls.provider.value] = cfgEls.url.value;
      syncCfgFields();
      cfgStatus("");
    });
  }
  if (cfgEls.reveal) {
    cfgEls.reveal.addEventListener("click", () => {
      cfgEls.apiKey.type = cfgEls.apiKey.type === "password" ? "text" : "password";
    });
  }
  if (cfgEls.reset) {
    cfgEls.reset.addEventListener("click", () => {
      aiCfg = { ...AI_CFG_DEFAULT };
      saveAiCfg(aiCfg);
      openCfg();
      cfgStatus("Đã khôi phục cài đặt mặc định.", "ok");
    });
  }
  if (cfgEls.save) {
    cfgEls.save.addEventListener("click", () => {
      const provider = cfgEls.provider.value;
      const cat = AI_CATALOG[provider] || AI_CATALOG[AI_CFG_DEFAULT.provider];
      const prompt = (cfgEls.prompt.value || "").trim() || AI_PROMPT_DEFAULT;
      const apiKey = (cfgEls.apiKey.value || "").trim();
      const url = (cfgEls.url.value || "").trim();
      const maxTokens = Math.min(
        2048,
        Math.max(64, parseInt(cfgEls.maxTokens.value, 10) || AI_CFG_DEFAULT.maxTokens)
      );
      const rawTemp = parseFloat(cfgEls.temp.value);
      const temperature = Number.isFinite(rawTemp)
        ? Math.min(2, Math.max(0, rawTemp))
        : AI_CFG_DEFAULT.temperature;

      if (!cat.keyless && !apiKey) {
        cfgStatus("Hãy nhập API key cho " + cat.label + ".", "err");
        cfgEls.apiKey.focus();
        return;
      }
      if (cat.custom) {
        if (!/^https:\/\/\S+$/i.test(url)) {
          cfgStatus("Endpoint phải là một URL https:// hợp lệ.", "err");
          cfgEls.url.focus();
          return;
        }
        customUrls.custom = url;
      }

      const next = {
        provider,
        model: (cfgEls.model.value || "").trim(),
        apiKey,
        prompt,
        maxTokens,
        temperature,
      };
      const changed =
        next.provider !== aiCfg.provider ||
        next.model !== aiCfg.model ||
        next.prompt !== aiCfg.prompt;
      aiCfg = next;
      if (cat.custom) aiCfg.customUrl = url;
      saveAiCfg(aiCfg);
      // New settings -> the old summaries were produced by a different
      // model/prompt, so make the next article regenerate.
      if (changed) {
        artState.extractive = artState.extractive || "";
        if (artEls.sumAiBtn) artEls.sumAiBtn.textContent = "✨ Tóm tắt bằng AI";
      }
      closeCfg();
      // Re-run the summary for the article on screen under the new settings
      const link = artState.link;
      if (changed && link && artEls.body.innerText.trim().length >= 200) {
        artEls.sumAiBtn.disabled = true;
        artEls.sumAiBtn.classList.add("busy");
        artEls.sumAiBtn.textContent = "✨ Đang tóm tắt AI...";
        runAiSummary(link);
      }
    });
  }

  // ---- chatbot bridge (see docs/chat-contract.md) ----
  // Exposed once openCfg and everything it reads exist, and before
  // js/chatbot.js (which loads next) has its own DOMContentLoaded work.
  function currentArticle() {
    const link = articleUrl(artState.link);
    if (!link) return null;
    const slug = `${location.pathname}${location.hash}`.indexOf(relativeSlug(link)) >= 0;
    if (!slug) return null; // the reader is on a list for this article
    const bodyText = (artEls.body.innerText || "").replace(/\s+/g, " ").trim();
    return {
      link,
      title:
        (artEls.title && artEls.title.textContent && artEls.title.textContent.trim()) ||
        (artItem && artItem.title) ||
        "Bài viết",
      sapo: (artEls.sapo && artEls.sapo.textContent) || "",
      cat: (artEls.cat && artEls.cat.textContent) || "Tin tức",
      bodyText: bodyText.slice(0, 12000),
      extractive: artState.extractive || "",
    };
  }

  // Full article for a link the user brought up in chat. An article that is
  // not in the snapshots still renders - decorate() fills the gaps.
  async function getArticle(link) {
    const href = articleUrl(link);
    if (!href) throw new Error("bad link");
    const item =
      itemIndex.get(href) ||
      (await allItems()).find((i) => i.link === href) ||
      decorate({ title: "Bài viết", link: href, pubDate: Date.now() }, "");
    try {
      const html = await fetchArticleBody(item);
      const text = htmlToText(html);
      if (!text) throw new Error("empty body");
      return { item, text, html, interactive: false };
    } catch (e) {
      // a quiz/live widget cannot be fetched as HTML by anyone - say so
      // instead of handing the caller a bare failure
      const interactive = !!(e && e.interactive);
      throw Object.assign(new Error(interactive ? "interactive" : "unavailable"), {
        interactive,
        item,
      });
    }
  }

  function openArticleBySlug(slug) {
    const m = /^([a-z0-9-]+-\d+)\.html?$/i.exec(String(slug || ""));
    if (!m) return false;
    const link = "https://vnexpress.net/" + m[1] + ".html";
    const item = itemIndex.get(link);
    if (item) openArticleInPlace(item, false);
    else loadArticle(m[1]);
    return true;
  }

  try {
    window.NewsChat = {
      version: 1,
      currentArticle,
      getArticle,
      openArticle: openArticleBySlug,
      allItems,
      chat: aiChatTurn,
      openSettings: openCfg,
    };
  } catch (e) {
    /* a read-only global (hardened browser) just means no chatbot */
  }

  function showBodyLoading() {
    stopTts(); // reading a summary of the previous article makes no sense
    artEls.fallback.hidden = true;
    artEls.summary.hidden = true;
    artEls.body.innerHTML =
      '<div class="rd-loading"><span class="rd-spinner"></span>Đang tải bài viết...</div>';
  }

  // Persist sanitized article HTML for ~24h so repeat visits skip the
  // jina/proxy round trip even after a full page load.
  // Bumped when the sanitiser's output shape changes, so a reader who has
  // the old markup cached (e.g. bodies from before videos were kept) does not
  // keep being served it for 24h. 2 = inline videos are preserved.
  const ARTICLE_HTML_VERSION = 2;

  function saveArticleHtml(link, html) {
    try {
      localStorage.setItem(
        "news24:art:" + link,
        JSON.stringify({ t: Date.now(), v: ARTICLE_HTML_VERSION, html })
      );
    } catch {
      /* quota / private mode - ignore */
    }
  }

  function loadSavedArticleHtml(link) {
    try {
      const raw = localStorage.getItem("news24:art:" + link);
      if (!raw) return null;
      const { t, v, html } = JSON.parse(raw);
      if (!html || Date.now() - (t || 0) > 24 * 3600e3) return null;
      if (v !== ARTICLE_HTML_VERSION) return null; // stale shape - refetch
      return html;
    } catch {
      return null;
    }
  }

  async function fetchArticleBody(item) {
    if (articleCache.has(item.link)) return articleCache.get(item.link);
    const saved = loadSavedArticleHtml(item.link);
    if (saved) {
      articleCache.set(item.link, saved);
      return saved;
    }
    return sanitizeArticle(await fetchArticleHtml(item.link), item.link); // may throw
  }

  // ---- Read the summary aloud (TTS) ----
  // Google Translate TTS is the ONLY voice — one implementation, no
  // browser/OS voice fallback. Playback goes through <audio> elements so it
  // covers Android, iOS and desktop alike. Playback is NOT CORS-checked
  // (only fetch would be), but Google 404s any request carrying a Referer —
  // the page-wide <meta referrer no-referrer> in index.html suppresses it.
  // Requests must stay under ~200 chars, so the summary is split (ttsChunks).
  const GTTS = "https://translate.googleapis.com/translate_tts?ie=UTF-8&client=gtx&tl=vi";
  let tts = { playing: false, token: 0, audio: null };

  // ---- reading speed (persisted) ----
  const TTS_RATES = [0.8, 1, 1.25, 1.5];
  function loadTtsRate() {
    const v = parseFloat(localStorage.getItem("news24:ttsrate"));
    return TTS_RATES.includes(v) ? v : 1;
  }
  function ttsRateLabel() {
    return "⚡ " + ttsRate + "×";
  }
  let ttsRate = loadTtsRate();
  if (artEls.ttsRateBtn) artEls.ttsRateBtn.textContent = ttsRateLabel();
  artEls.ttsRateBtn.addEventListener("click", () => {
    ttsRate = TTS_RATES[(TTS_RATES.indexOf(ttsRate) + 1) % TTS_RATES.length];
    try {
      localStorage.setItem("news24:ttsrate", String(ttsRate));
    } catch {}
    artEls.ttsRateBtn.textContent = ttsRateLabel();
    // adjust the chunk that is already playing, no restart needed
    if (tts.audio) tts.audio.playbackRate = ttsRate;
  });

  function stopTts() {
    tts.token++;
    tts.playing = false;
    if (tts.audio) {
      const a = tts.audio;
      tts.audio = null;
      a.onended = a.onerror = null;
      a.pause();
      a.removeAttribute("src"); // also aborts an in-flight load
    }
    if (artEls.ttsBtn) artEls.ttsBtn.textContent = "🔊 Đọc tóm tắt";
  }

  // Split the summary into Google Translate TTS requests of <= TTS_MAX
  // chars, preferring to cut at sentence boundaries so playback never stops
  // mid-clause. The endpoint rejects anything past ~200 chars (measured:
  // 200 OK, 202 -> HTTP 400), so TTS_MAX leaves a small margin.
  //
  // Two levels: sentences are packed greedily into a chunk, and only a
  // single sentence longer than one request is broken down further - at a
  // clause mark first, then any space, then a hard cut.
  // Invariant: ttsChunks(t).join(" ") === t (whitespace-normalised).
  const TTS_MAX = 195;

  // Tokens that end with a dot without ending the sentence.
  const TTS_ABBREV = new Set([
    "GS", "TS", "PGS", "ThS", "BS", "KS", "TP", "UBND", "HĐND", "VN",
    "Q", "P", "H", "Th", "Nxb", "Co", "Ltd", "Inc", "St", "Mr", "Mrs",
    "Ms", "Dr", "vs", "etc", "No", "Vol",
  ]);

  // Sentence splitter that keeps the terminator attached to its sentence.
  function ttsSentences(text) {
    const out = [];
    let buf = "";
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      buf += ch;
      if (ch !== "." && ch !== "!" && ch !== "?" && ch !== "…") continue;
      // swallow a run of terminators / closing quotes: "...", "?!", ”
      let j = i + 1;
      while (j < text.length && /[.!?…'"”’»)\]]/.test(text[j])) {
        buf += text[j];
        j++;
      }
      i = j - 1;
      if (ch === ".") {
        // A dot ends a sentence only before whitespace + capital/EOS, and
        // never after a known abbreviation or a numbered list marker.
        const rest = text.slice(i + 1);
        const nextOk = /^\s+[A-ZÀ-Ỹ"“(\[]/.test(rest) || /^\s*$/.test(rest);
        const tok = (buf.trim().split(/\s+/).pop() || "").replace(/[^\p{L}.]/gu, "");
        if (TTS_ABBREV.has(tok.replace(/\.$/, "")) || /^\d+\.$/.test(tok) || !nextOk) {
          continue;
        }
      }
      if (buf.trim()) out.push(buf.trim());
      buf = "";
    }
    if (buf.trim()) out.push(buf.trim());
    return out;
  }

  // Break one over-long sentence: clause punctuation beats a bare space.
  function ttsSplitLong(seg) {
    const parts = [];
    let rest = seg;
    while (rest.length > TTS_MAX) {
      const win = rest.slice(0, TTS_MAX + 1);
      let cut = -1;
      for (const re of [/[;:]\s/g, /,\s/g, /\s[–—]\s/g]) {
        let m;
        let last = -1;
        while ((m = re.exec(win))) last = m.index + m[0].length;
        // Ignore a clause mark so early it would strand the rest
        if (last > TTS_MAX * 0.4) {
          cut = last;
          break;
        }
      }
      if (cut < 0) {
        const sp = win.lastIndexOf(" ");
        if (sp > 0) cut = sp + 1;
      }
      if (cut <= 0) cut = TTS_MAX; // no space at all
      parts.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) parts.push(rest);
    return parts.filter(Boolean);
  }

  function ttsChunks(text) {
    const clean = String(text || "").replace(/\s+/g, " ").trim();
    if (!clean) return [];
    const out = [];
    let cur = "";
    const flush = () => {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
    };
    for (const s of ttsSentences(clean)) {
      const need = (cur ? cur.length + 1 : 0) + s.length;
      if (need <= TTS_MAX) {
        cur = cur ? cur + " " + s : s; // still fits: pack it in
        continue;
      }
      flush();
      if (s.length <= TTS_MAX) {
        cur = s;
      } else {
        const ps = ttsSplitLong(s);
        for (let i = 0; i < ps.length - 1; i++) out.push(ps[i]);
        cur = ps[ps.length - 1];
      }
    }
    flush();
    return out;
  }

  async function playGoogleTts(text, token) {
    const chunks = ttsChunks(text);
    for (let i = 0; i < chunks.length; i++) {
      if (tts.token !== token) return; // stopped mid-way
      const url =
        GTTS +
        "&total=" + chunks.length +
        "&idx=" + i +
        "&textlen=" + chunks[i].length +
        "&q=" + encodeURIComponent(chunks[i]);
      await new Promise((resolve, reject) => {
        const a = new Audio(url);
        tts.audio = a;
        a.defaultPlaybackRate = ttsRate; // survives the load algorithm reset
        a.playbackRate = ttsRate; // browsers keep the voice pitch (preservesPitch)
        a.onended = resolve;
        a.onerror = () => reject(new Error("gtts chunk " + i));
        a.play().catch(() => reject(new Error("gtts play " + i)));
      });
    }
  }

  artEls.ttsBtn.addEventListener("click", () => {
    if (tts.playing) {
      stopTts();
      return;
    }
    const text = summarySpeech();
    if (!text) return;
    tts.playing = true;
    artEls.ttsBtn.textContent = "⏹ Dừng đọc";
    const token = ++tts.token;
    playGoogleTts(text, token)
      .then(() => {
        if (tts.token === token) stopTts(); // finished naturally
      })
      .catch((err) => {
        if (tts.token !== token) return; // user already stopped
        stopTts(); // no second voice: tell the user instead of switching
        console.warn("[tts] Google Translate TTS lỗi:", err && err.message);
        artEls.ttsBtn.textContent = "⚠️ Không đọc được";
        setTimeout(() => {
          if (!tts.playing) artEls.ttsBtn.textContent = "🔊 Đọc tóm tắt";
        }, 2000);
      });
  });

  // In-page navigation: pushState keeps the pretty /news/<slug>.html URL
  // while rendering without a page load (and the 404-trick still serves
  // the same page on hard load / shared links).
  function openArticleInPlace(item, viaPop) {
    artItem = item;
    artState.link = item.link;
    artState.viaPush = !viaPop;
    if (!viaPop) history.pushState({ art: item.link }, "", relativeSlug(item.link));
    showView("article");
    window.scrollTo(0, 0);
    renderArticleHeader(item);
    showBodyLoading();
    fetchArticleBody(item)
      .then((html) => {
        if (artState.link !== item.link) return;
        renderArticleBody(item, html);
      })
      .catch((err) => {
        if (artState.link !== item.link) return;
        renderArticleBody(item, null, err);
      });
  }

  // Direct URL entry (/news/<slug>.html served by 404.html): item data
  // comes from the snapshots, body from cache or the proxy chain.
  async function loadArticle(slug) {
    const link = "https://vnexpress.net/" + slug + ".html";
    artItem = null;
    artState.link = link;
    artState.viaPush = false;
    showView("article");
    window.scrollTo(0, 0);
    artEls.title.textContent = "Đang tải bài viết...";
    artEls.cat.textContent = "Bài viết";
    artEls.time.textContent = "";
    artEls.sapo.textContent = "";
    artEls.lead.hidden = true;
    artEls.fullBtn.href = artEls.origin.href = artEls.origin2.href = link;
    showBodyLoading();

    let html = loadSavedArticleHtml(link);
    if (html) articleCache.set(link, html);

    const [itemRes, fckRes] = await Promise.allSettled([
      findItemData(slug),
      html ? Promise.resolve(null) : fetchArticleHtml(link),
    ]);
    if (artState.link !== link) return; // user navigated away meanwhile
    let item = itemRes.status === "fulfilled" ? itemRes.value : null;
    const fck = fckRes.status === "fulfilled" ? fckRes.value : null;
    const fckErr = fckRes.status === "rejected" ? fckRes.reason : null;
    if (!item && fck) {
      item = itemFromArticle(fck, link);
    }
    if (!item) {
      item = decorate({ title: "Bài viết", link, pubDate: Date.now() }, "");
    }
    artItem = item;
    renderArticleHeader(item);
    renderArticleBody(item, html || fck, fckErr);
    // the header landed after showView() already announced this article
    broadcastArticleView("article");
  }

  // Card clicks (list + sidebar) with plain slug.html hrefs become
  // in-page transitions; modified clicks fall through to native
  // navigation (new tab), unknown links to the 404-trick page load.
  document.addEventListener("click", (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    const a = e.target.closest ? e.target.closest("a") : null;
    if (!a) return;
    const href = a.getAttribute("href") || "";
    if (!/^[a-z0-9-]+-\d+\.html?$/i.test(href)) return;
    const item = itemIndex.get("https://vnexpress.net/" + href);
    if (!item) return;
    e.preventDefault();
    openArticleInPlace(item, false);
  });

  window.addEventListener("popstate", () => {
    const slug = currentSlug();
    if (slug) {
      const link = "https://vnexpress.net/" + slug + ".html";
      const item = itemIndex.get(link);
      if (item) openArticleInPlace(item, true);
      else loadArticle(slug);
      return;
    }
    artState.link = null;
    artState.viaPush = false;
    // history landed on a category path (/news/<slug>) or the root
    const cat = currentCat();
    loadSlug(cat || "tin-moi-nhat", { syncUrl: false });
  });

  // From an in-page article, the back link replays the history entry
  // (no reload); on a hard-loaded article it stays a plain href="./".
  document.querySelector(".back-link").addEventListener("click", (e) => {
    if (artState.viaPush) {
      e.preventDefault();
      history.back();
    }
  });

  artEls.retry.addEventListener("click", () => {
    if (!artState.link) return;
    articleCache.delete(artState.link);
    try {
      localStorage.removeItem("news24:art:" + artState.link);
    } catch {}
    const slug = currentSlug();
    if (slug) loadArticle(slug);
  });

  // ------------------------------------------------------------------
  // Boot
  // ------------------------------------------------------------------
  // The stats view lives in 404.html (and stats.html on hosts that serve
  // it). GitHub Pages answers /news/stats with 404.html, so the app has to
  // recognise the URL and let the markup/js/stats.js take over.
  function isStatsPage() {
    return /^\/(?:[\w.-]+\/)*stats(?:\.html?)?\/?$/.test(decodeURI(location.pathname));
  }

  function boot() {
    renderToday();
    setInterval(renderToday, 60000);
    if (isStatsPage()) {
      showView("stats");
      document.title = "Thống kê tin tức - News24";
      loadSidebar();
      return;
    }
    const slug = currentSlug();
    if (slug) {
      // /news/<slug>.html - this page was served by the root 404.html
      loadArticle(slug);
      loadSidebar();
      return;
    }
    const cat = currentCat();
    if (cat) {
      // /news/<category> - real category URL (VnExpress-style)
      loadSlug(cat);
      loadSidebar();
      return;
    }
    if (!/(^|\/)index\.html?$/.test(location.pathname) && !/\/$/.test(location.pathname)) {
      // 404.html served for a path that is neither the index nor an
      // article slug - bounce back to the app root
      location.replace(location.pathname.indexOf("/news/") === 0 ? "/news/" : "/");
      return;
    }
    loadSlug(slugFromHash());
    loadSidebar();
  }

  boot();
})();
