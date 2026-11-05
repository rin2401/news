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

  function safeUrl(u) {
    return /^https?:\/\//i.test(u || "") ? u : "";
  }

  function safeImg(u) {
    return /^https?:\/\//i.test(u || "") ? u : "";
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
    return "news24:cache:" + slug;
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

  function fetchWithTimeout(url, ms) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    return fetch(url, { signal: ctrl.signal, mode: "cors" }).finally(() =>
      clearTimeout(timer)
    );
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
        '" href="' + escapeAttr(it.link) + '" target="_blank" rel="noopener">' +
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
        '" href="' + escapeAttr(it.link) + '" target="_blank" rel="noopener">' +
        (it.img ? '<div class="side-thumb">' + img + "</div>" : "") +
        "<div><h3 class=\"a-title\">" + safeText(it.title) + "</h3>" +
        '<div class="a-meta">' + timeAgo(it.pubDate) + "</div></div></a>"
      );
    }
    return (
      '<a class="news-item' + (it.img ? "" : " no-img") +
      '" href="' + escapeAttr(it.link) + '" target="_blank" rel="noopener">' +
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
    els.featured.innerHTML = useFeatured ? articleHtml(first, "featured") : "";
    const pageItems = useFeatured ? rest : items;
    els.list.innerHTML = pageItems
      .slice(0, state.shown)
      .map((it) => articleHtml(it))
      .join("");
  }

  function renderSidebar(items) {
    if (!items || !items.length) return;
    // Sidebar shows latest headlines, skipping what the main column
    // already displays for the current category.
    const seen = new Set(
      state.items.slice(0, state.shown + 1).map((i) => i.link)
    );
    const pool = items.filter((i) => !seen.has(i.link)).slice(0, 12);
    els.sideList.innerHTML = pool
      .map((it) => articleHtml(decorate(it, SIDEBAR_FEED), "side"))
      .join("");
  }

  // ------------------------------------------------------------------
  // Data loading
  // ------------------------------------------------------------------
  let sideLoad = null; // sidebar promise shared across category switches

  async function loadSidebar() {
    if (!sideLoad) {
      sideLoad = fetchFeed(SIDEBAR_FEED)
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
    updateHash(slug);
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
      const items = await fetchFeed(slug);
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

  function updateHash(slug) {
    const target = "#/" + slug;
    if (location.hash !== target) {
      // replace (not push) to avoid history noise on programmatic loads
      history.replaceState(null, "", target);
    }
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
    loadSlug(link.dataset.slug);
  });

  window.addEventListener("hashchange", () => {
    loadSlug(slugFromHash());
  });

  els.loadMore.addEventListener("click", () => {
    state.shown += PAGE_SIZE;
    renderMain();
  });

  els.search.addEventListener("input", () => {
    state.query = els.search.value;
    state.shown = PAGE_SIZE;
    renderMain();
  });

  els.refresh.addEventListener("click", () => {
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
  // Boot
  // ------------------------------------------------------------------
  renderToday();
  setInterval(renderToday, 60000);
  loadSlug(slugFromHash());
})();
