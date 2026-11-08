/* News24 - statistics page
 * Reads the RSS snapshots in data/<slug>.json (the same files js/app.js
 * renders), keeps one row per article across all feeds, then draws every
 * chart by hand: plain DOM + CSS, no library, no canvas, no CDN.
 *
 * Plain IIFE on purpose: GitHub Pages also serves the raw file, so this
 * must run without a build step and without ES module imports. */
"use strict";

(function () {
  // The same script is loaded by 404.html (which serves /stats on GitHub
  // Pages, where js/app.js reveals #viewStats) and by stats.html, whose page
  // body *is* the stats markup. On any other page of the site there is
  // nothing to draw - leave the page alone.
  const view = document.getElementById("viewStats");
  const page = view || document.querySelector("main.stats-page");
  if (!page || (view && view.hidden)) return;
  document.documentElement.classList.add("stats-view");

  // ------------------------------------------------------------------
  // Config
  // ------------------------------------------------------------------
  // Site-wide aggregate feed: every headline in it also belongs to a real
  // topic feed, so it is read last and never becomes a topic of its own.
  const AGGREGATE_FEED = "tin-moi-nhat";

  // Mirrors CATEGORIES in js/app.js; display order matters.
  const DEFAULT_CATEGORIES = [
    ["tin-moi-nhat", "Tin mới nhất"],
    ["thoi-su", "Thời sự"],
    ["the-gioi", "Thế giới"],
    ["kinh-doanh", "Kinh doanh"],
    ["bat-dong-san", "Bất động sản"],
    ["the-thao", "Thể thao"],
    ["giai-tri", "Giải trí"],
    ["suc-khoe", "Sức khỏe"],
    ["giao-duc", "Giáo dục"],
    ["du-lich", "Du lịch"],
    ["phap-luat", "Pháp luật"],
  ];

  // Series ink: --primary first, then neutrals mixed from --text over
  // --surface, so the same six colours track light and dark theme with
  // no new custom properties.
  const COLORS = [
    "var(--primary)",
    "color-mix(in srgb, var(--text) 74%, var(--surface))",
    "color-mix(in srgb, var(--text) 52%, var(--surface))",
    "color-mix(in srgb, var(--text) 35%, var(--surface))",
    "color-mix(in srgb, var(--text) 22%, var(--surface))",
    "color-mix(in srgb, var(--text) 12%, var(--surface))",
  ];
  const OTHERS_COLOR = COLORS[5];

  const STACK_TOP = 5; // top N categories keep their colour, rest = "Khác"
  const DAY_MS = 86400000;
  const MAX_LABELS = 10; // day labels before the axis is thinned

  const WEEKDAYS = ["CN", "Hai", "Ba", "Tư", "Năm", "Sáu", "Bảy"];
  const WEEKDAYS_LONG = [
    "Chủ nhật",
    "Thứ hai",
    "Thứ ba",
    "Thứ tư",
    "Thứ năm",
    "Thứ sáu",
    "Thứ bảy",
  ];

  // ------------------------------------------------------------------
  // Small helpers
  // ------------------------------------------------------------------
  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function fmtInt(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  }

  function pct(part, total) {
    if (!total) return "0%";
    const v = (part * 100) / total;
    return (v > 0 && v < 1 ? "<1" : String(Math.round(v))) + "%";
  }

  function pad2(n) {
    return n < 10 ? "0" + n : String(n);
  }

  // Chart data (titles, category names) is feed text: it is only ever
  // written with textContent, and links are checked before they become
  // an href, so no markup from the feed snapshot can be executed.
  function validHref(u) {
    return /^https?:\/\//i.test(String(u || ""));
  }

  function dayKey(d) {
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }

  function splitKey(key) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
    return m ? [+m[1], +m[2], +m[3]] : null;
  }

  function fmtDayLong(key) {
    const p = splitKey(key);
    if (!p) return key;
    const wd = WEEKDAYS_LONG[new Date(p[0], p[1] - 1, p[2]).getDay()];
    return wd + ", " + pad2(p[2]) + "/" + pad2(p[1]);
  }

  function fmtDayShort(key) {
    const p = splitKey(key);
    return p ? pad2(p[2]) + "/" + pad2(p[1]) : key;
  }

  function fmtDateTime(ms) {
    const d = new Date(ms);
    return (
      pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + " " +
      pad2(d.getDate()) + "/" + pad2(d.getMonth() + 1) + "/" + d.getFullYear()
    );
  }

  function weekdayOf(key) {
    const p = splitKey(key);
    return p ? new Date(p[0], p[1] - 1, p[2]).getDay() : 0;
  }

  // ------------------------------------------------------------------
  // Data
  // ------------------------------------------------------------------
  /* data/<slug>.json (the RSS snapshots js/app.js also reads) -> the same
   * normalised shape the charts draw from.
   *
   * No history file: the numbers are whatever the feeds currently carry.
   * VnExpress keeps ~60 items per feed, so "theo ngày" covers the last few
   * days only (the window grows with how many articles the feeds publish);
   * nothing older can be recovered without storing samples server-side.
   *
   * Each article is a feed item {title, link, pubDate(ms), img, sapo}; it
   * belongs to the feed it was read from. The aggregate feed repeats stories
   * that also live in a topic feed, so every article is counted once and the
   * topic wins - otherwise "Tin mới nhất" would inflate and the real topics
   * would lose their stories. */
  const CATEGORIES = DEFAULT_CATEGORIES.filter(([slug]) => slug !== AGGREGATE_FEED);

  function normalize(responses) {
    const catMap = {};
    const order = [];
    DEFAULT_CATEGORIES.forEach(([slug, name]) => {
      catMap[slug] = name;
      // The aggregate feed has no bucket of its own: everything in it that
      // no topic claimed still gets counted, under "Khác".
      if (slug !== AGGREGATE_FEED) order.push(slug);
    });
    catMap.khac = "Khác";
    order.push("khac");

    const byLink = new Map();
    let updatedAt = 0;

    // Topic feeds first, aggregate last, so a story keeps its real topic.
    // Anything only the aggregate carries still counts, under "Khác".
    const sources = CATEGORIES.concat([[AGGREGATE_FEED, ""]]);
    sources.forEach(([slug]) => {
      const snap = responses[slug];
      if (!snap || !Array.isArray(snap.items)) return;
      if (Number.isFinite(snap.fetchedAt)) updatedAt = Math.max(updatedAt, snap.fetchedAt);
      const bucket = slug === AGGREGATE_FEED ? "khac" : slug;
      snap.items.forEach((it) => {
        const link = it && typeof it.link === "string" ? it.link : "";
        const title = it && typeof it.title === "string" ? it.title : "";
        const pub = it && Number.isFinite(it.pubDate) ? it.pubDate : NaN;
        if (!validHref(link) || !title || !Number.isFinite(pub)) return;
        if (byLink.has(link)) return;
        byLink.set(link, {
          slug: bucket,
          cat: catMap[bucket],
          title: title,
          link: link,
          pubDate: pub,
          img: it && typeof it.img === "string" && validHref(it.img) ? it.img : "",
        });
      });
    });

    const items = [];
    byLink.forEach((it) => items.push(it));
    items.sort((a, b) => b.pubDate - a.pubDate);

    const dayMap = new Map();
    items.forEach((it) => {
      const d = new Date(it.pubDate);
      it.day = dayKey(d);
      it.hour = d.getHours();
      dayMap.set(it.day, (dayMap.get(it.day) || 0) + 1);
    });

    const days = [];
    dayMap.forEach((count, key) => days.push({ key: key, count: count }));
    days.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

    return {
      updatedAt: updatedAt,
      order: order,
      catMap: catMap,
      items: items,
      days: days,
      // Every category (including empty ones) so the chips and the table
      // keep a stable shape as the feeds move on.
      covers: DEFAULT_CATEGORIES.length,
    };
  }

  function withTimeout(url, ms) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    return fetch(url, { cache: "no-cache", signal: ctrl.signal }).finally(() =>
      clearTimeout(timer)
    );
  }

  /* One request per feed, all in parallel. A feed that fails is skipped
   * rather than failing the page - the rest still add up to a usable chart. */
  async function fetchSnapshots() {
    const slugs = DEFAULT_CATEGORIES.map(([slug]) => slug);
    const results = await Promise.all(
      slugs.map((slug) =>
        withTimeout("data/" + slug + ".json", 15000)
          .then((res) => (res.ok ? res.json() : null))
          .catch(() => null)
      )
    );
    const responses = {};
    let ok = 0;
    slugs.forEach((slug, i) => {
      const data = results[i];
      if (data && Array.isArray(data.items) && data.items.length) {
        responses[slug] = data;
        ok++;
      }
    });
    if (!ok) throw new Error("no feed snapshot could be read");
    return responses;
  }

  // ------------------------------------------------------------------
  // State + element cache
  // ------------------------------------------------------------------
  const state = {
    data: null,
    range: 30, // days; 0 = all
    rangeChosen: false,
    cats: null, // Set of slugs, null = every category
    onlyDay: null, // ISO day picked in a column, null = all days in range
    loading: false,
    narrow: window.matchMedia("(max-width: 639px)"),
  };

  const els = {
    updated: document.getElementById("kpiUpdated"),
    msg: document.getElementById("statsMsg"),
    skeleton: document.getElementById("statsSkeleton"),
    content: document.getElementById("statsContent"),
    kpis: document.getElementById("kpis"),
    rangeSeg: document.getElementById("rangeSeg"),
    chips: document.getElementById("catChips"),
    rangeNote: document.getElementById("rangeNote"),
    catBars: document.getElementById("catBars"),
    dayCols: document.getElementById("dayCols"),
    dayHint: document.getElementById("dayHint"),
    hourLine: document.getElementById("hourLine"),
    stackHint: document.getElementById("stackHint"),
    stackLegend: document.getElementById("stackLegend"),
    dayStack: document.getElementById("dayStack"),
    table: document.getElementById("catDayTable"),
    tip: document.getElementById("statsTip"),
    today: document.getElementById("today"),
    theme: document.getElementById("themeToggle"),
  };

  // ------------------------------------------------------------------
  // Filters
  // ------------------------------------------------------------------
  // Range ends on the LAST day that has data, not on today: the newest feed
  // snapshot can lag a few hours, and a lagging axis should not render an
  // empty tail.
  function rangeDays() {
    const recorded = state.data.days;
    if (!recorded.length) return [];
    const n = state.range;
    if (!n) return recorded.map((d) => d.key);
    const p = splitKey(recorded[recorded.length - 1].key);
    const startMs = new Date(p[0], p[1] - 1, p[2]).getTime() - (n - 1) * DAY_MS;
    const keys = [];
    for (let i = 0; i < n; i++) {
      keys.push(dayKey(new Date(startMs + i * DAY_MS)));
    }
    return keys;
  }

  // Items of `days` that pass the category filter and, unless `allDays` is
  // set, the day drill-down picked in a chart.
  function itemsIn(days, allDays) {
    const keep = new Set(days);
    return state.data.items.filter(
      (it) =>
        keep.has(it.day) &&
        (!state.cats || state.cats.has(it.slug)) &&
        (allDays || !state.onlyDay || it.day === state.onlyDay)
    );
  }

  function countBy(items, keyOf) {
    const out = {};
    items.forEach((it) => {
      const k = keyOf(it);
      out[k] = (out[k] || 0) + 1;
    });
    return out;
  }

  // Categories in site order; unknown slugs (older files) go last.
  function orderedCats() {
    return state.data.order.slice();
  }

  // ------------------------------------------------------------------
  // Tooltip: hover on desktop, focus for keyboard, tap for touch.
  // Text always goes through textContent.
  // ------------------------------------------------------------------
  function showTip(text, anchor) {
    if (!text) return hideTip();
    els.tip.textContent = text;
    els.tip.hidden = false;
    const r = anchor.getBoundingClientRect();
    const box = els.tip.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    let left = r.left + r.width / 2 - box.width / 2 + window.scrollX;
    left = Math.max(window.scrollX + 6, Math.min(left, window.scrollX + vw - box.width - 6));
    let top = r.top + window.scrollY - box.height - 8;
    if (top < window.scrollY + 4) top = r.bottom + window.scrollY + 8;
    els.tip.style.left = Math.round(left) + "px";
    els.tip.style.top = Math.round(top) + "px";
  }

  function hideTip() {
    els.tip.hidden = true;
  }

  /* One delegated listener set serves every mark that carries data-tip:
   * mouseover/mouseout (pointer), focusin/focusout (keyboard) and click
   * (touch, where hover does not exist). */
  function bindTips(root) {
    const tipOf = (t) => (t && t.closest ? t.closest("[data-tip]") : null);

    root.addEventListener("mouseover", (e) => {
      const t = tipOf(e.target);
      if (t) showTip(t.getAttribute("data-tip"), t);
      else hideTip();
    });
    // mouseover bubbles and is followed by a mouseleave on the same root:
    // only an exit from the document (no relatedTarget) closes the tip.
    root.addEventListener("mouseout", (e) => {
      if (!e.relatedTarget) hideTip();
    });
    root.addEventListener("focusin", (e) => {
      const t = tipOf(e.target);
      if (t) showTip(t.getAttribute("data-tip"), t);
    });
    root.addEventListener("focusout", hideTip);
    root.addEventListener("click", (e) => {
      const t = tipOf(e.target);
      if (!t || !window.matchMedia("(hover: none)").matches) return;
      showTip(t.getAttribute("data-tip"), t);
    });
  }

  // ------------------------------------------------------------------
  // KPI cards
  // ------------------------------------------------------------------
  function renderKpis(items) {
    els.kpis.innerHTML = "";
    const total = items.length;
    const nCats = Object.keys(countBy(items, (it) => it.slug)).length;
    const days = state.data.days;
    const first = days.length ? days[0].key : "";
    const last = days.length ? days[days.length - 1].key : "";

    const cards = [
      {
        label: "Tổng số bài",
        value: total,
        sub: state.cats ? "trong chủ đề đã chọn" : "không trùng lặp",
      },
      {
        label: "Số chủ đề",
        value: nCats + "/" + (state.data.order.length - 1),
        sub: "có bài trong kỳ",
      },
      {
        label: "Số ngày có dữ liệu",
        value: days.length,
        sub: days.length === 1 ? "mới bắt đầu ghi" : "ngày",
      },
      {
        label: "Khoảng thời gian",
        value: days.length ? fmtDayShort(first) + " – " + fmtDayShort(last) : "—",
        sub: days.length ? "năm " + first.slice(0, 4) : "chưa có dữ liệu",
        small: true,
      },
    ];

    cards.forEach((c) => {
      const card = el("div", "kpi");
      card.appendChild(el("div", "kpi-label", c.label));
      card.appendChild(
        el("div", "kpi-value" + (c.small ? " kpi-value--sm" : ""), fmtInt(c.value))
      );
      card.appendChild(el("div", "kpi-sub", c.sub));
      els.kpis.appendChild(card);
    });
  }

  // ------------------------------------------------------------------
  // Day axis: at most ~MAX_LABELS labels, weekends by name when they
  // stand alone, first and last day always labelled. Labels never
  // rotate, so a chart can't grow a sideways scrollbar on a phone.
  // ------------------------------------------------------------------
  function axisLabels(keys, narrow) {
    const meta = keys.map((key) => {
      const wd = weekdayOf(key);
      return { short: fmtDayShort(key), wd: WEEKDAYS[wd], weekend: wd === 0 || wd === 6 };
    });
    const n = meta.length;
    if (!n) return [];
    const step = Math.max(1, Math.ceil(n / (narrow ? 5 : MAX_LABELS)));
    const out = meta.map((m, i) => (i % step === 0 ? m.short : ""));
    out[0] = meta[0].short;
    // The last day is always labelled and labels spill sideways out of their
    // narrow slot, so whichever label sits just before it would collide.
    for (let i = n - 2; i >= 0; i--) {
      if (out[i]) {
        out[i] = "";
        break;
      }
    }
    out[n - 1] = meta[n - 1].short;
    if (step === 1) {
      meta.forEach((m, i) => {
        const prev = meta[i - 1];
        const next = meta[i + 1];
        const lone =
          m.weekend && !(prev && prev.weekend) && !(next && next.weekend);
        if (lone) out[i] = m.wd;
      });
    }
    return out;
  }

  // ------------------------------------------------------------------
  // a. Horizontal bars: articles per category (bar = link to ./<slug>)
  // ------------------------------------------------------------------
  function renderCatBars(items) {
    const box = els.catBars;
    box.innerHTML = "";
    const total = items.length;
    const counts = countBy(items, (it) => it.slug);

    const rows = orderedCats()
      .map((slug) => ({
        slug: slug,
        name: state.data.catMap[slug],
        count: counts[slug] || 0,
      }))
      .filter((c) => c.count > 0);
    rows.sort((a, b) => b.count - a.count);

    if (!rows.length) {
      box.appendChild(el("div", "empty-note", "Không có bài nào khớp bộ lọc."));
      return;
    }
    const max = rows[0].count;

    const chart = el("div", "hbars");
    chart.setAttribute("role", "img");
    chart.setAttribute(
      "aria-label",
      "Biểu đồ cột ngang số bài theo chủ đề, " + fmtInt(total) + " bài: " +
        rows.map((c) => c.name + " " + fmtInt(c.count) + " bài").join(", ") + "."
    );

    rows.forEach((c) => {
      const row = el("a", "hbar");
      row.href = "./" + c.slug;
      row.setAttribute(
        "aria-label",
        c.name + ": " + fmtInt(c.count) + " bài, " + pct(c.count, total) +
          " — mở chuyên mục " + c.name
      );
      const track = el("span", "hbar-track");
      const fill = el("span", "hbar-fill");
      fill.style.width = (c.count / max) * 100 + "%";
      track.appendChild(fill);

      const val = el("span", "hbar-val");
      val.appendChild(el("strong", "", fmtInt(c.count)));
      val.appendChild(el("span", "hbar-pct", pct(c.count, total)));

      row.appendChild(el("span", "hbar-name", c.name));
      row.appendChild(track);
      row.appendChild(val);
      chart.appendChild(row);
    });
    box.appendChild(chart);
  }

  // ------------------------------------------------------------------
  // b. Columns: articles per day. Counts are drawn; the x labels are
  //    links that drill down to that single day.
  // ------------------------------------------------------------------
  function renderDayCols(items, days) {
    const box = els.dayCols;
    box.innerHTML = "";
    const total = items.length;
    const counts = countBy(items, (it) => it.day);
    els.dayHint.textContent = fmtInt(total) + " bài";

    if (!days.length) {
      box.appendChild(el("div", "empty-note", "Chưa có dữ liệu."));
      return;
    }

    const max = Math.max.apply(null, days.map((k) => counts[k] || 0).concat([1]));
    const narrow = state.narrow.matches;
    const labels = axisLabels(days, narrow);
    const showVals = valuesFit(days.length, narrow);
    const peak = days
      .map((k) => ({ k: k, c: counts[k] || 0 }))
      .sort((a, b) => b.c - a.c)
      .filter((x) => x.c)
      .slice(0, 3);

    const chart = el("div", "cols");
    chart.style.setProperty("--n", String(days.length));
    labelChart(
      chart,
      "Biểu đồ cột số bài theo ngày: " + fmtInt(total) + " bài trong " +
        fmtInt(days.length) + " ngày." +
        (peak.length
          ? " Nhiều nhất: " +
            peak.map((x) => fmtDayLong(x.k) + " " + fmtInt(x.c) + " bài").join(", ") + "."
          : ""),
      "Ngày " + fmtDayShort(days[0]) + " – " + fmtDayShort(days[days.length - 1]) +
        ", cao nhất " + fmtInt(max) + " bài"
    );

    const plot = el("div", "cols-plot");
    days.forEach((key, i) => {
      const c = counts[key] || 0;
      const col = el("div", "col");
      col.appendChild(el("span", "col-val", showVals && c ? fmtInt(c) : ""));

      const track = el("div", "col-track");
      if (c) {
        const bar = el("button", "col-bar");
        bar.type = "button";
        bar.style.height = (c / max) * 100 + "%";
        bar.setAttribute("data-tip", fmtDayLong(key) + ": " + fmtInt(c) + " bài · " + pct(c, total));
        bar.setAttribute("aria-label", "Chỉ xem ngày " + fmtDayLong(key) + " (" + fmtInt(c) + " bài)");
        bar.addEventListener("click", () => {
          state.onlyDay = state.onlyDay === key ? null : key;
          render();
        });
        track.appendChild(bar);
      } else {
        track.appendChild(el("span", "col-zero", "·"));
      }
      col.appendChild(track);
      col.appendChild(dayLabel(key, labels[i], "col-x"));
      plot.appendChild(col);
    });
    chart.appendChild(plot);

    if (state.narrow.matches) {
      chart.appendChild(el("div", "chart-foot", "Nhấn vào cột để chỉ xem ngày đó"));
    }
    box.appendChild(chart);
  }

  // With 30 columns on a phone a "212" under every bar overlaps its
  // neighbours, so the value is painted only while the slots are wide
  // enough (~20px); beyond that the tooltip carries the number.
  function valuesFit(n, narrow) {
    return n <= (narrow ? 7 : 14);
  }

  /* Charts are text-free drawings whose marks stay individually focusable,
   * so they are exposed as a group with a name and a value summary instead
   * of role="img" (which would hide the focusable marks from AT). */
  function labelChart(node, name, value) {
    node.setAttribute("role", "group");
    node.setAttribute("aria-label", name + " " + value + ".");
  }

  function dayLabel(key, text, cls) {
    const wrap = el("div", cls + (text ? "" : " is-blank"));
    if (!text) {
      wrap.textContent = " ";
      return wrap;
    }
    const a = el("a", "day-link", text);
    a.href = "#" + key;
    a.setAttribute("data-day", key);
    a.setAttribute("data-tip", "Chỉ xem ngày " + fmtDayLong(key));
    a.setAttribute("aria-label", "Chỉ xem ngày " + fmtDayLong(key));
    wrap.appendChild(a);
    return wrap;
  }

  // ------------------------------------------------------------------
  // e. Articles per hour of day
  // ------------------------------------------------------------------
  function renderHourLine(items) {
    const box = els.hourLine;
    box.innerHTML = "";
    const total = items.length;
    const counts = new Array(24).fill(0);
    items.forEach((it) => {
      counts[it.hour] += 1;
    });
    const max = Math.max.apply(null, counts.concat([1]));
    const peak = counts.indexOf(max);

    const chart = el("div", "hhist");
    chart.setAttribute("role", "img");
    chart.setAttribute(
      "aria-label",
      "Số bài theo giờ đăng, " + fmtInt(total) + " bài" +
        (total ? "; cao nhất lúc " + peak + " giờ với " + fmtInt(counts[peak]) + " bài." : ".")
    );

    // 24 ticks don't fit a 360px screen: label every 3rd hour (every 6th
    // on phones), but leave every hour hoverable and focusable.
    const stepH = state.narrow.matches ? 6 : 3;
    const plot = el("div", "hhist-cols");
    for (let h = 0; h < 24; h++) {
      const c = counts[h];
      const col = el("div", "hhist-col");
      const hit = el("div", "hhist-hit");
      hit.tabIndex = 0;
      hit.setAttribute(
        "data-tip",
        pad2(h) + ":00–" + pad2(h) + ":59: " + fmtInt(c) + " bài · " + pct(c, total)
      );
      hit.setAttribute("aria-label", pad2(h) + " giờ: " + fmtInt(c) + " bài");
      const bar = el("span", "hhist-bar");
      bar.style.height = (c / max) * 100 + "%";
      hit.appendChild(bar);
      col.appendChild(hit);
      col.appendChild(el("span", "hhist-x", h % stepH === 0 ? pad2(h) : ""));
      plot.appendChild(col);
    }
    chart.appendChild(plot);
    box.appendChild(chart);
  }

  // ------------------------------------------------------------------
  // c. Stacked columns: category mix per day (top 5 + "Khác"), legend
  // ------------------------------------------------------------------
  function renderDayStack(items, days) {
    const box = els.dayStack;
    const legend = els.stackLegend;
    box.innerHTML = "";
    legend.innerHTML = "";
    els.stackHint.textContent = days.length ? fmtInt(days.length) + " ngày" : "";

    if (!days.length) {
      box.appendChild(el("div", "empty-note", "Chưa có dữ liệu."));
      return;
    }

    // Rank categories over the WHOLE range so the colour of a series does
    // not jump around when a single day is picked.
    const counts = countBy(items, (it) => it.slug);
    const ranked = orderedCats()
      .map((slug) => ({ slug: slug, count: counts[slug] || 0 }))
      .filter((c) => c.count > 0)
      .sort((a, b) => b.count - a.count);

    const series = ranked.slice(0, STACK_TOP).map((c, i) => ({
      slug: c.slug,
      key: c.slug,
      name: state.data.catMap[c.slug],
      color: COLORS[i % COLORS.length],
    }));
    const rest = ranked.slice(STACK_TOP);
    if (rest.length) {
      series.push({
        key: "__khac__",
        name: "Khác (" + fmtInt(rest.length) + " chủ đề)",
        color: OTHERS_COLOR,
        members: rest.map((r) => r.slug),
      });
    }

    const seriesOf = {};
    series.forEach((s) => {
      if (s.members) s.members.forEach((m) => (seriesOf[m] = s.key));
      else seriesOf[s.key] = s.key;
    });

    const total = items.length;
    const perDay = {};
    const colTotal = {};
    days.forEach((k) => (perDay[k] = {}));
    items.forEach((it) => {
      const sk = seriesOf[it.slug];
      if (!sk) return;
      perDay[it.day][sk] = (perDay[it.day][sk] || 0) + 1;
      colTotal[it.day] = (colTotal[it.day] || 0) + 1;
    });

    const totals = days.map((k) => colTotal[k] || 0);
    const max = Math.max.apply(null, totals.concat([1]));
    const labels = axisLabels(days, state.narrow.matches);
    const showVals = valuesFit(days.length, state.narrow.matches);
    const grand = {};
    series.forEach((s) => {
      let n = 0;
      days.forEach((k) => (n += perDay[k][s.key] || 0));
      grand[s.key] = n;
    });

    const chart = el("div", "cols");
    chart.style.setProperty("--n", String(days.length));
    labelChart(
      chart,
      "Biểu đồ cột chồng cơ cấu chủ đề theo ngày, " + fmtInt(days.length) + " ngày: " +
        series.map((s) => s.name + " " + fmtInt(grand[s.key]) + " bài").join(", ") + ".",
      "Mỗi cột là một ngày, cao nhất " + fmtInt(max) + " bài"
    );

    const plot = el("div", "cols-plot");
    days.forEach((key, i) => {
      const col = el("div", "col");
      col.appendChild(el("span", "col-val", showVals && totals[i] ? fmtInt(totals[i]) : ""));
      const track = el("div", "col-track");
      const stack = el("div", "stack");
      stack.style.height = ((totals[i] || 0) / max) * 100 + "%";
      series.forEach((s) => {
        const n = perDay[key][s.key] || 0;
        if (!n) return;
        const seg = el("div", "stack-seg");
        seg.style.flexGrow = String(n);
        seg.style.background = s.color;
        seg.tabIndex = 0;
        seg.setAttribute(
          "data-tip",
          fmtDayLong(key) + " · " + s.name + ": " + fmtInt(n) + " bài"
        );
        seg.setAttribute(
          "aria-label",
          fmtDayLong(key) + ", " + s.name + ": " + fmtInt(n) + " bài"
        );
        stack.appendChild(seg);
      });
      track.appendChild(stack);
      col.appendChild(track);
      col.appendChild(dayLabel(key, labels[i], "col-x"));
      plot.appendChild(col);
    });
    chart.appendChild(plot);
    box.appendChild(chart);

    series.forEach((s) => {
      const item = el("span", "legend-item");
      const sw = el("span", "legend-sw");
      sw.style.background = s.color;
      item.appendChild(sw);
      item.appendChild(el("span", "legend-name", s.name));
      item.appendChild(el("span", "legend-n", fmtInt(grand[s.key]) + " · " + pct(grand[s.key], total)));
      legend.appendChild(item);
    });
  }

  // ------------------------------------------------------------------
  // d. Table: category x day. Sticky first column + sticky header; the
  //    category cell links to ./<slug>, the day header filters to that day.
  // ------------------------------------------------------------------
  function renderTable(items, days) {
    const table = els.table;
    table.innerHTML = "";

    if (!days.length || !items.length) {
      table.appendChild(el("caption", "empty-note", "Chưa có dữ liệu để lập bảng."));
      return;
    }

    const counts = countBy(items, (it) => it.slug + "|" + it.day);
    const rows = orderedCats()
      .map((slug) => {
        let n = 0;
        days.forEach((k) => (n += counts[slug + "|" + k] || 0));
        return { slug: slug, name: state.data.catMap[slug], total: n };
      })
      .filter((r) => r.total > 0);
    rows.sort((a, b) => b.total - a.total);

    table.appendChild(el("caption", "sr-only", "Số bài từng chủ đề theo từng ngày"));

    const thead = el("thead");
    const hrow = el("tr");
    const corner = el("th", "sticky-col is-corner", "Chủ đề");
    corner.scope = "col";
    hrow.appendChild(corner);

    const colTotals = days.map(() => 0);
    days.forEach((key) => {
      const th = el("th", "num");
      th.scope = "col";
      th.setAttribute("data-day", key);
      th.setAttribute("data-tip", "Chỉ xem ngày " + fmtDayLong(key));
      const inner = el("button", "th-day");
      inner.type = "button";
      inner.appendChild(el("span", "th-date", fmtDayShort(key)));
      inner.appendChild(el("span", "th-wd", WEEKDAYS[weekdayOf(key)]));
      inner.addEventListener("click", () => {
        state.onlyDay = state.onlyDay === key ? null : key;
        render();
      });
      th.appendChild(inner);
      hrow.appendChild(th);
    });
    const totTh = el("th", "num is-total", "Tổng");
    totTh.scope = "col";
    hrow.appendChild(totTh);
    thead.appendChild(hrow);
    table.appendChild(thead);

    const tbody = el("tbody");
    rows.forEach((r) => {
      const tr = el("tr");
      const th = el("th", "sticky-col");
      th.scope = "row";
      const link = el("a", "tbl-cat", r.name);
      link.href = "./" + r.slug;
      th.appendChild(link);
      tr.appendChild(th);
      days.forEach((key, di) => {
        const n = counts[r.slug + "|" + key] || 0;
        colTotals[di] += n;
        tr.appendChild(el("td", "num" + (n ? "" : " is-zero"), n ? fmtInt(n) : "·"));
      });
      tr.appendChild(el("td", "num is-total", fmtInt(r.total)));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    const tfoot = el("tfoot");
    const frow = el("tr");
    const flab = el("th", "sticky-col");
    flab.scope = "row";
    flab.textContent = "Tổng ngày";
    frow.appendChild(flab);
    colTotals.forEach((n) => frow.appendChild(el("td", "num", n ? fmtInt(n) : "·")));
    frow.appendChild(el("td", "num is-total", fmtInt(items.length)));
    tfoot.appendChild(frow);
    table.appendChild(tfoot);
  }

  // ------------------------------------------------------------------
  // Filter chrome
  // ------------------------------------------------------------------
  function renderRangeSeg() {
    Array.prototype.forEach.call(els.rangeSeg.querySelectorAll(".seg-btn"), (btn) => {
      const r = btn.getAttribute("data-range");
      const active = r === "all" ? !state.range : Number(r) === state.range;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-pressed", active ? "true" : "false");
    });
  }

  function renderChips(items) {
    els.chips.innerHTML = "";
    const counts = countBy(items, (it) => it.slug);
    const slugs = orderedCats();
    slugs.forEach((slug) => {
      const on = !state.cats || state.cats.has(slug);
      const n = counts[slug] || 0;
      const btn = el(
        "button",
        "chip" + (on ? " is-on" : "") + (n ? "" : " is-empty")
      );
      btn.type = "button";
      btn.setAttribute("aria-pressed", on ? "true" : "false");
      btn.setAttribute(
        "aria-label",
        (on ? "Bỏ lọc " : "Lọc ") + state.data.catMap[slug] + " (" + fmtInt(n) + " bài)"
      );
      btn.appendChild(el("span", "chip-name", state.data.catMap[slug]));
      btn.appendChild(el("span", "chip-n", fmtInt(n)));
      btn.addEventListener("click", () => {
        if (!state.cats) {
          // First click: keep every other category and drop this one.
          state.cats = new Set(slugs.filter((s) => s !== slug));
        } else if (state.cats.has(slug)) {
          state.cats.delete(slug);
        } else {
          state.cats.add(slug);
        }
        if (state.cats.size >= slugs.length) state.cats = null;
        render();
      });
      els.chips.appendChild(btn);
    });

    const reset = el("button", "chip chip--reset", "Bỏ lọc");
    reset.type = "button";
    reset.hidden = !state.cats;
    reset.addEventListener("click", () => {
      state.cats = null;
      render();
    });
    els.chips.appendChild(reset);
  }

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------
  function render() {
    if (!state.data) return;
    const days = rangeDays();
    if (state.onlyDay && days.indexOf(state.onlyDay) === -1) state.onlyDay = null;

    // One filtered set feeds every chart, so a chip or a picked day
    // re-renders the page consistently.
    const items = itemsIn(days);

    renderRangeSeg();
    renderChips(items);
    renderKpis(items);
    renderCatBars(items);
    renderDayCols(itemsIn(days, true), days);
    renderHourLine(items);
    renderDayStack(items, days);
    renderTable(items, days);

    if (days.length) {
      const first = fmtDayLong(days[0]);
      const last = fmtDayLong(days[days.length - 1]);
      let note =
        "Khoảng đang xem: " + first + " → " + last + " (" + fmtInt(days.length) + " ngày)";
      if (state.onlyDay) {
        const n = items.filter((it) => it.day === state.onlyDay).length;
        note +=
          " · Đang chỉ xem " + fmtDayLong(state.onlyDay) + ": " + fmtInt(n) + " bài";
      }
      els.rangeNote.textContent = note;
      els.rangeNote.hidden = false;
      els.rangeNote.classList.toggle("is-filtered", Boolean(state.onlyDay || state.cats));
    } else {
      els.rangeNote.hidden = true;
    }

    els.updated.textContent = state.data.updatedAt
      ? "Cập nhật " + fmtDateTime(state.data.updatedAt)
      : "";
  }

  /* Messages always come from this file, but they go in as text nodes
   * anyway so a future caller can never inject markup. */
  function showMessage(text, withRetry) {
    els.msg.hidden = !text;
    els.msg.className = "status-bar stats-msg" + (withRetry ? " err" : "");
    els.msg.innerHTML = "";
    if (!text) return;
    els.msg.appendChild(el("span", "msg-text", text));
    const cta = el("span", "msg-cta");
    const retry = el("button", "stats-retry", "Thử lại");
    retry.type = "button";
    retry.addEventListener("click", load);
    cta.appendChild(retry);
    els.msg.appendChild(cta);
  }

  // The error state still has a way forward: the category pages load
  // fine even when a snapshot is missing.
  function attachIndex() {
    const cta = els.msg.querySelector(".msg-cta");
    if (!cta) return;
    const back = el("a", "msg-back", "Về trang chủ →");
    back.href = "./";
    cta.appendChild(back);
  }

  async function load() {
    if (state.loading) return;
    state.loading = true;
    hideTip();
    els.content.hidden = true;
    els.skeleton.hidden = false;
    showMessage("", false);
    try {
      const data = normalize(await fetchSnapshots());
      state.data = data;
      els.skeleton.hidden = true;
      els.updated.textContent = data.updatedAt
        ? "Cập nhật " + fmtDateTime(data.updatedAt)
        : "";
      if (!data.items.length) {
        showMessage(
          "Chưa có dữ liệu thống kê: các tệp data/<chuyên mục>.json đang trống. " +
            "Số liệu lấy từ chính nguồn RSS mà trang chủ dùng, nên hãy thử lại sau " +
            "khi lần làm mới tin kế tiếp chạy xong.",
          true
        );
        return;
      }
      // Pick a range that fits the data on first paint.
      if (!state.rangeChosen) {
        const n = data.days.length;
        state.range = n >= 30 ? 30 : n >= 14 ? 14 : n >= 7 ? 7 : 0;
      }
      els.content.hidden = false;
      render();
    } catch (e) {
      els.skeleton.hidden = true;
      showMessage(
        "Không tải được số liệu từ các tệp data/<chuyên mục>.json. Chúng có thể chưa " +
          "được tạo, hoặc trình duyệt đang chặn đọc tệp nội bộ khi mở bằng file://.",
        true
      );
      attachIndex();
    } finally {
      state.loading = false;
    }
  }

  // ------------------------------------------------------------------
  // Header: theme toggle + today (same behaviour as js/app.js; the
  // theme itself was already pinned inline in the <head>)
  // ------------------------------------------------------------------
  function applyTheme(t) {
    document.documentElement.dataset.theme = t;
    try {
      localStorage.setItem("news24:theme", t);
    } catch {}
  }

  els.theme.addEventListener("click", () => {
    applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  });

  function renderToday() {
    const now = new Date();
    els.today.textContent =
      WEEKDAYS_LONG[now.getDay()] + ", " +
      now.toLocaleDateString("vi-VN", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
      });
  }

  // ------------------------------------------------------------------
  // Events: range toggle, day drill-down links, tooltip hygiene
  // ------------------------------------------------------------------
  els.rangeSeg.addEventListener("click", (e) => {
    const btn = e.target.closest ? e.target.closest(".seg-btn") : null;
    if (!btn) return;
    const r = btn.getAttribute("data-range");
    state.range = r === "all" ? 0 : Number(r);
    state.rangeChosen = true;
    state.onlyDay = null;
    hideTip();
    render();
  });

  // Delegated: every .day-link inside the charts toggles the day filter,
  // except the "Bỏ lọc" reset (its own handler).
  document.addEventListener("click", (e) => {
    const link = e.target.closest ? e.target.closest("a.day-link") : null;
    if (!link || !state.data) return;
    e.preventDefault();
    const key = link.getAttribute("data-day");
    state.onlyDay = state.onlyDay === key ? null : key;
    hideTip();
    render();
  });

  window.addEventListener("scroll", hideTip, { passive: true });
  window.addEventListener("resize", hideTip);
  bindTips(document);

  renderToday();
  setInterval(renderToday, 60000);
  load();
})();
