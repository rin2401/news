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
  function stripTags(s) {
    const el = document.createElement("div");
    el.innerHTML = s;
    return (el.textContent || "").trim();
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
      title: item.title || "(Không có tiêu đề)",
      sapo: item.sapo || "",
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
    if (!link) return;
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
    if (aboutBox) aboutBox.hidden = !wideLayout.matches;
  }
  syncAboutBox();
  wideLayout.addEventListener("change", syncAboutBox);

  function showView(name) {
    artEls.listView.hidden = name !== "list";
    artEls.view.hidden = name !== "article";
    syncAboutBox();
  }

  const ALLOWED_TOP = new Set([
    "P", "H2", "H3", "H4", "FIGURE", "TABLE", "UL", "OL",
    "BLOCKQUOTE", "IMG", "HR",
  ]);
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
  function sanitizeArticle(rootClone) {
    rootClone.querySelectorAll(STRIP_SELECTOR).forEach((n) => n.remove());

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
      [...el.attributes].forEach((a) => el.removeAttribute(a.name));
    });

    // figures that lost their image are stray captions - drop them
    rootClone.querySelectorAll("figure").forEach((f) => {
      if (!f.querySelector("img")) f.remove();
    });

    const out = document.createElement("div");
    [...rootClone.children].forEach((child) => {
      if (!ALLOWED_TOP.has(child.tagName)) return;
      const hasImg = child.querySelector("img");
      if (!child.textContent.trim() && !hasImg) return; // skip empty blocks
      out.appendChild(child);
    });
    return out.innerHTML;
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
      html = sanitizeArticle(fckOrHtml);
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
      artEls.summaryText.textContent = extractive;
      artEls.summary.hidden = !extractive;
      const ai = loadAiSummary(item.link);
      if (ai) {
        artEls.summaryText.textContent = ai;
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

  // ---- AI summary (Pollinations, free & key-less, CORS-enabled) ----
  const AI_TTL = 7 * 24 * 3600e3; // summaries rarely go stale - cache a week

  function loadAiSummary(link) {
    try {
      const raw = localStorage.getItem("news24:ai:" + link);
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
        "news24:ai:" + link,
        JSON.stringify({ t: Date.now(), text })
      );
    } catch {}
  }

  async function aiSummarize(link) {
    const body = (artEls.body.innerText || "").replace(/\s+/g, " ").trim();
    if (body.length < 200) throw new Error("no body");
    const content = body.slice(0, 6000);
    const res = await fetchWithTimeout("https://text.pollinations.ai/", 60000, {
      "Content-Type": "application/json",
    }, {
      method: "POST",
      body: JSON.stringify({
        model: "openai",
        messages: [
          {
            role: "system",
            content:
              "Bạn là trợ lý tóm tắt tin tức. Tóm tắt bài báo thành 3-4 câu " +
              "ngắn gọn, chắt lọc ý chính, bằng tiếng Việt. Chỉ trả về nội " +
              "dung tóm tắt, không mở đầu, không liệt kê.",
          },
          { role: "user", content: content },
        ],
      }),
    });
    if (!res.ok) throw new Error("AI HTTP " + res.status);
    const text = (await res.text()).trim();
    if (!text || text.length < 20 || text.length > 1500) {
      throw new Error("AI bad payload");
    }
    return text;
  }

  // Background AI summary run (auto-triggered on render when not cached).
  // One run per link at a time; on failure the extractive version stays
  // visible and the button offers a manual retry.
  let aiInFlight = null;
  async function runAiSummary(link) {
    if (aiInFlight === link) return;
    aiInFlight = link;
    try {
      const text = await aiSummarize(link);
      saveAiSummary(link, text); // cache even if the user navigated away
      if (artState.link === link) {
        artEls.summaryText.textContent = text;
        artEls.sumAiBtn.textContent = "↺ Bản rút trích";
      }
    } catch (e) {
      if (artState.link === link) {
        // keep the instant extractive summary on screen (rate limits:
        // Pollinations free tier allows ~1 reply per 45s per IP)
        artEls.sumAiBtn.textContent = "✨ Thử lại AI";
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
      artEls.summaryText.textContent = artState.extractive || "";
      artEls.sumAiBtn.textContent = "✨ Tóm tắt bằng AI";
      return;
    }
    const cached = loadAiSummary(link);
    if (cached) {
      // previously generated, just not showing (user toggled back)
      artEls.summaryText.textContent = cached;
      artEls.sumAiBtn.textContent = "↺ Bản rút trích";
      return;
    }
    artEls.sumAiBtn.disabled = true;
    artEls.sumAiBtn.classList.add("busy");
    artEls.sumAiBtn.textContent = "✨ Đang tóm tắt AI...";
    await runAiSummary(link);
  });

  function showBodyLoading() {
    stopTts(); // reading a summary of the previous article makes no sense
    artEls.fallback.hidden = true;
    artEls.summary.hidden = true;
    artEls.body.innerHTML =
      '<div class="rd-loading"><span class="rd-spinner"></span>Đang tải bài viết...</div>';
  }

  // Persist sanitized article HTML for ~24h so repeat visits skip the
  // jina/proxy round trip even after a full page load.
  function saveArticleHtml(link, html) {
    try {
      localStorage.setItem(
        "news24:art:" + link,
        JSON.stringify({ t: Date.now(), html })
      );
    } catch {
      /* quota / private mode - ignore */
    }
  }

  function loadSavedArticleHtml(link) {
    try {
      const raw = localStorage.getItem("news24:art:" + link);
      if (!raw) return null;
      const { t, html } = JSON.parse(raw);
      if (!html || Date.now() - (t || 0) > 24 * 3600e3) return null;
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
    return sanitizeArticle(await fetchArticleHtml(item.link)); // may throw
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
  // chars (the endpoint answers HTTP 400 past ~200). One forward scan,
  // cutting at the last space that fits. The previous version did
  // `cur = s.slice(0, 180)`, which silently DROPPED everything after char
  // 180 of any sentence longer than one request, so long summaries lost
  // their tail. Invariant: ttsChunks(t).join(" ") === t (whitespace-normalised).
  const TTS_MAX = 190;
  function ttsChunks(text) {
    const clean = String(text || "").replace(/\s+/g, " ").trim();
    if (!clean) return [];
    const out = [];
    let at = 0;
    while (at < clean.length) {
      let end = Math.min(at + TTS_MAX, clean.length);
      if (end < clean.length) {
        const sp = clean.lastIndexOf(" ", end);
        if (sp > at) end = sp; // cut at a word boundary (else: giant word)
      }
      out.push(clean.slice(at, end).trim()); // glue char dropped...
      at = end + 1; // ...consumed here (join(" ") rebuilds `clean`)
    }
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
    const text = (artEls.summaryText.textContent || "").trim();
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
    renderArticleHeader(item);
    renderArticleBody(item, html || fck, fckErr);
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
  function boot() {
    renderToday();
    setInterval(renderToday, 60000);
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
