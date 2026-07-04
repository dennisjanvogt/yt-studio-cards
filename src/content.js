/*
 * content.js — isoliertes Content-Script.
 * Baut die Karten-Ansicht in den Inhalte-Tab von YouTube Studio.
 *
 * Selektoren sind gegen das echte Studio-DOM verifiziert:
 *   Zeile           ytcp-video-row
 *   Titel           #video-title
 *   Metriken        .tablecell-views / .tablecell-comments / .tablecell-likes
 *   Datum           .tablecell-date  (Text: "26.06.2026 Veröffentlicht")
 *   Sichtbarkeit    .tablecell-visibility
 *   Dauer           Badge-Overlay (m:ss) in .tablecell-video
 *   Listencontainer .video-table-content   (Pager liegt außerhalb)
 *
 * CTR & Retention kommen aus dem internen Analytics-API (siehe inject.js).
 */
(() => {
  "use strict";

  const NS = "YTSC";
  const LOG = (...a) => console.debug("[YT-Karten]", ...a);

  // ---------------------------------------------------------------- Bridge
  const pending = new Map();
  let reqSeq = 0;

  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.source !== NS + "-PAGE") return;
    if (d.cmd === "analyticsResult" || d.cmd === "statusResult") {
      const cb = pending.get(d.reqId);
      if (cb) {
        pending.delete(d.reqId);
        cb(d);
      }
    } else if (d.cmd === "harvest") {
      applyMetrics(d.metrics || {}, true); // Live-Ernte -> frisch
    } else if (d.cmd === "template" || (d.cmd === "ready" && d.seeded)) {
      analyticsSeeded = true;
      if (cardsOn) updateHint();
    }
  });

  function ask(cmd, extra = {}, timeout = 20000) {
    return new Promise((resolve) => {
      const reqId = ++reqSeq;
      pending.set(reqId, resolve);
      window.postMessage({ source: NS, cmd, reqId, ...extra }, location.origin);
      setTimeout(() => {
        if (pending.has(reqId)) {
          pending.delete(reqId);
          resolve(null);
        }
      }, timeout);
    });
  }

  // ---------------------------------------------------------------- Storage
  const CACHE_KEY = "ytsc_metrics_cache";
  const VIEW_KEY = "ytsc_cards_on";
  const ORDER_KEY = "ytsc_video_order"; // id -> { title, dateMs } (für Analytics-Navigation)
  const SETTINGS_KEY = "ytsc_settings";
  const DEFAULTS = { ctrGood: 5, ctrOk: 3, retGood: 50, retOk: 35, cardMin: 300, showPanel: true, watchPanel: true, squareMode: true };
  let metricsCache = {};
  let videoOrder = {};
  const SETTINGS = Object.assign({}, DEFAULTS);

  function applySettings() {
    try {
      document.documentElement.style.setProperty("--ytsc-card-min", SETTINGS.cardMin + "px");
    } catch (_) {}
    if (cardsOn) renderGrid();
    if (panelVideoId) renderAnPanel(panelVideoId);
  }

  function loadCache() {
    try {
      chrome.storage.local.get(
        [CACHE_KEY, ORDER_KEY, SETTINGS_KEY, "ytsc_cache_migr2", "ytsc_dash_range", "ytsc_trend_range"],
        (r) => {
        metricsCache = r[CACHE_KEY] || {};
        videoOrder = r[ORDER_KEY] || {};
        Object.assign(SETTINGS, r[SETTINGS_KEY] || {});
        if (r.ytsc_dash_range) dashRange = r.ytsc_dash_range;
        if (r.ytsc_trend_range) trendRange = r.ytsc_trend_range;
        // Altlasten bereinigen: CTR 0 ohne Impressionen = "noch keine Daten"
        // (YouTube liefert Impressionen/CTR mit 1–2 Tagen Verzögerung)
        let dirty = false;
        for (const id in metricsCache) {
          const m = metricsCache[id];
          if (m && m.ctr === 0 && !(m.impressions > 0)) {
            delete m.ctr;
            delete m.impressions;
            dirty = true;
          }
        }
        // Einmalige Migration: Retention war früher als Ratio (0..1) gespeichert,
        // jetzt einheitlich Prozent. Flag + <=1-Guard verhindern Doppel-Migration.
        if (!r.ytsc_cache_migr2) {
          for (const id in metricsCache) {
            const m = metricsCache[id];
            if (m && typeof m.retention === "number" && m.retention <= 1) {
              m.retention *= 100;
              dirty = true;
            }
          }
          try {
            chrome.storage.local.set({ ytsc_cache_migr2: true });
          } catch (_) {}
        }
        if (dirty) saveCache();
        applySettings();
      });
      chrome.storage.onChanged.addListener((ch, area) => {
        if (area !== "local") return;
        if (ch[SETTINGS_KEY]) {
          Object.assign(SETTINGS, DEFAULTS, ch[SETTINGS_KEY].newValue || {});
          applySettings();
        }
        if (ch[CACHE_KEY] && ch[CACHE_KEY].newValue === undefined) metricsCache = {};
        if (ch[ORDER_KEY] && ch[ORDER_KEY].newValue === undefined) videoOrder = {};
      });
    } catch (_) {}
  }
  function saveCache() {
    try {
      chrome.storage.local.set({ [CACHE_KEY]: metricsCache });
    } catch (_) {}
  }
  loadCache();

  // ---------------------------------------------------------------- Zahlen
  function parseCount(text) {
    if (text == null) return null;
    text = String(text).trim().toLowerCase();
    if (!/[\d]/.test(text)) return null; // "—", "Anzeigen deaktiviert" etc.
    const mult = /mrd/.test(text)
      ? 1e9
      : /mio/.test(text)
      ? 1e6
      : /tsd/.test(text)
      ? 1e3
      : 1;
    let num = text.replace(/[^\d.,]/g, "");
    if (mult > 1) num = num.replace(/\./g, "").replace(",", ".");
    else num = num.replace(/\.(?=\d{3}\b)/g, "").replace(",", ".");
    const v = parseFloat(num);
    return isFinite(v) ? Math.round(v * mult) : null;
  }

  function parseDuration(t) {
    if (!t) return null;
    const p = t.split(":").map(Number);
    if (p.some((n) => isNaN(n))) return null;
    return p.reduce((a, b) => a * 60 + b, 0);
  }

  function parseDateMs(s) {
    if (!s) return null;
    const m = s.match(/(\d{1,2})\.(\d{1,2})\.(\d{2,4})/); // DD.MM.YYYY
    if (!m) return null;
    let y = +m[3];
    if (y < 100) y += 2000;
    return new Date(y, +m[2] - 1, +m[1]).getTime();
  }

  function fmtCount(n) {
    if (n == null) return "—";
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(".", ",") + " Mio.";
    if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(".", ",") + " Tsd.";
    return String(n);
  }
  // Alle Metrik-Werte sind einheitlich PROZENT (inject.js normalisiert an der
  // Quelle) – hier wird nie mehr umgerechnet.
  function fmtPct(v) {
    if (v == null) return "—";
    return v.toFixed(v < 1 ? 2 : 1).replace(".", ",") + " %";
  }
  function fmtDuration(sec) {
    if (sec == null) return "—";
    sec = Math.round(sec);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(s).padStart(2, "0");
  }
  function fmtWatch(sec) {
    if (sec == null) return "—";
    const h = sec / 3600;
    if (h >= 1) return h.toFixed(h >= 10 ? 0 : 1).replace(".", ",") + " Std";
    const m = sec / 60;
    if (m >= 1) return Math.round(m) + " Min";
    return Math.round(sec) + " Sek";
  }
  function dateId(d) {
    d = d || new Date();
    return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
  }
  // "02.07.2026" -> "02.07.26" (Jahrhundert weg)
  function fmtDateShort(s) {
    if (!s) return "—";
    return s.replace(/(\d{1,2}\.\d{1,2}\.)(\d{2})(\d{2})/, "$1$3");
  }
  // Tage seit Veröffentlichung
  function daysOnline(dateMs) {
    if (!dateMs) return null;
    return Math.max(0, Math.floor((Date.now() - dateMs) / 86400000));
  }
  function fmtDaysOnline(dateMs) {
    const d = daysOnline(dateMs);
    if (d == null) return "—";
    if (d === 0) return "heute";
    if (d === 1) return "1 Tag";
    return d + " Tage";
  }

  // ---------------------------------------------------------------- Scraping
  function listContainer() {
    return document.querySelector(".video-table-content");
  }

  // Grid IN den Tabellen-Container vor den Pager hängen (kein Geister-Abstand,
  // Pager sitzt unter den Karten).
  function placeGrid(grid, list) {
    list = list || listContainer();
    if (!list || !grid) return;
    const footer = list.querySelector("#footer-container");
    if (footer) list.insertBefore(grid, footer);
    else list.appendChild(grid);
  }

  function scrapeRows() {
    const rows = [...document.querySelectorAll("ytcp-video-row")];
    const out = [];
    for (const r of rows) {
      const a = r.querySelector('a[href*="/video/"]');
      const m = ((a && a.getAttribute("href")) || "").match(/\/video\/([\w-]{11})/);
      if (!m) continue;
      const id = m[1];

      const cellText = (c) => {
        const e = r.querySelector(".tablecell-" + c);
        return e ? e.innerText.replace(/\n/g, " ").trim() : null;
      };

      // Dauer: Badge-Overlay (m:ss) im Video-Zelleninhalt
      let duration = null;
      const vcell = r.querySelector(".tablecell-video") || r;
      for (const e of vcell.querySelectorAll("*")) {
        if (e.children.length) continue;
        const t = (e.textContent || "").trim();
        if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(t)) {
          duration = t;
          break;
        }
      }

      let date = cellText("date");
      if (date)
        date = date
          .replace(/\s*(Veröffentlicht|Entwurf|Published|Draft).*$/i, "")
          .trim();

      const data = {
        id,
        title:
          (r.querySelector("#video-title") || {}).textContent?.trim() ||
          "(ohne Titel)",
        // hq720 ist echtes 16:9 (kein 4:3-Letterboxing wie hqdefault -> keine
        // schwarzen Balken); Fallback auf mqdefault (auch 16:9) via onerror.
        thumb: `https://i.ytimg.com/vi/${id}/hq720.jpg`,
        href: `https://studio.youtube.com/video/${id}/analytics/tab-overview/period-default`,
        views: parseCount(cellText("views")),
        comments: parseCount(cellText("comments")),
        likes: parseCount(cellText("likes")),
        date,
        dateMs: parseDateMs(date),
        visibility: cellText("visibility"),
        duration: parseDuration(duration),
        ctr: null,
        retention: null,
        avgDuration: null,
        watchTime: null,
        watchTimeToday: null,
      };

      const cached = metricsCache[id];
      if (cached) {
        if (cached.ctr != null) data.ctr = cached.ctr;
        if (cached.retention != null) data.retention = cached.retention;
        if (cached.avgDuration != null) data.avgDuration = cached.avgDuration;
        if (cached.watchTime != null) data.watchTime = cached.watchTime;
        // "Heute"-Wert nur, wenn er wirklich von heute stammt
        if (cached.watchTimeToday != null && cached.todayDate === dateId())
          data.watchTimeToday = cached.watchTimeToday;
        // Studios Tabellen-Aufrufe hängen oft hinterher; die geernteten
        // Analytics-Views sind frischer. Aufrufe wachsen nur -> Maximum nehmen.
        if (cached.views != null && (data.views == null || cached.views > data.views))
          data.views = cached.views;
      }
      out.push(data);
    }

    // Videoverzeichnis pflegen (für Analytics-Navigation + Dashboard-Insights;
    // wächst über alle Seiten). Dauer + Sichtbarkeit für Filter mitspeichern.
    let orderChanged = false;
    for (const r of out) {
      const cur = videoOrder[r.id];
      if (
        !cur ||
        cur.title !== r.title ||
        cur.dateMs !== r.dateMs ||
        cur.duration !== r.duration ||
        cur.visibility !== r.visibility
      ) {
        videoOrder[r.id] = {
          title: r.title,
          dateMs: r.dateMs,
          duration: r.duration,
          visibility: r.visibility,
        };
        orderChanged = true;
      }
    }
    if (orderChanged) {
      try {
        chrome.storage.local.set({ [ORDER_KEY]: videoOrder });
      } catch (_) {}
    }
    return out;
  }

  // ---------------------------------------------------------------- State
  let cardsOn = false;
  let currentRows = [];
  let sortKey = "date";
  let sortDir = -1;
  let filterText = "";
  let analyticsSeeded = false;
  // Auswahl für den Vergleich: id -> Zeilen-Snapshot. Als Map, damit die
  // Auswahl auch über Seitenwechsel (Pagination) hinweg erhalten bleibt.
  const selectedData = new Map();
  let panelVideoId = null; // aktuell im Analytics-Panel gezeigtes Video
  let panelHidden = false; // Panel für diese Sitzung ausgeblendet
  let dashRange = "all"; // Zeitraum der Dashboard-Insights: all|year|month|week
  let trendRange = "all"; // Zeitraum der Entwicklungs-Karte (eigener Zustand)
  let panelReq = { id: null, t: 0, tries: 0 }; // Nachlade-Versuche fürs Panel-Video

  // fresh=true: Live-Ernte -> überschreibt vorhandene Werte (neuer gewinnt).
  // fresh=false: Cache-Rücklauf aus inject.js (Session-Cache, evtl. älter als
  // unser persistenter Cache) -> füllt nur Lücken, überschreibt NIE.
  // Aufrufe wachsen nur -> immer Maximum, unabhängig von fresh.
  function applyMetrics(metrics, fresh) {
    let changed = false;
    for (const id in metrics) {
      const mm = metrics[id];
      if (!mm) continue;
      const cur = metricsCache[id] || (metricsCache[id] = {});
      for (const k in mm) {
        if (k === "t" || k === "ts" || mm[k] == null) continue;
        if (k === "views") {
          if (cur.views == null || mm.views > cur.views) {
            cur.views = mm.views;
            changed = true;
          }
        } else if (fresh || cur[k] == null) {
          if (cur[k] !== mm[k]) changed = true;
          cur[k] = mm[k];
        }
      }
      cur.ts = Date.now();
      // Zeilen/Auswahl spiegeln immer den (autoritativen) Cache
      const applyTo = (o) => {
        if (!o) return;
        if (cur.ctr != null) o.ctr = cur.ctr;
        if (cur.retention != null) o.retention = cur.retention;
        if (cur.avgDuration != null) o.avgDuration = cur.avgDuration;
        if (cur.watchTime != null) o.watchTime = cur.watchTime;
        if (cur.watchTimeToday != null && cur.todayDate === dateId())
          o.watchTimeToday = cur.watchTimeToday;
        if (cur.views != null && (o.views == null || cur.views > o.views)) o.views = cur.views;
      };
      applyTo(currentRows.find((r) => r.id === id));
      applyTo(selectedData.get(id));
    }
    saveCache();
    if (changed && cardsOn) {
      renderGrid();
      updateHint();
    }
    if (panelVideoId && metrics[panelVideoId]) renderAnPanel(panelVideoId);
    if (document.getElementById("ytsc-dash")) renderDashCard();
    if (document.getElementById("ytsc-trend")) renderTrendCard();
  }

  // ---------------------------------------------------------------- UI
  // Reiner DOM-Aufbau – YouTube Studio erzwingt Trusted Types, daher KEIN
  // innerHTML und keine inline-Eventhandler verwenden.
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function ensureToolbar() {
    if (document.getElementById("ytsc-toolbar")) return;
    const list = listContainer();
    if (!list || !list.parentElement) return;

    const bar = el("div", "ytsc-toolbar");
    bar.id = "ytsc-toolbar";

    const toggle = el("button", "ytsc-btn ytsc-toggle", "▦ Karten");
    toggle.addEventListener("click", () => setCards(!cardsOn));

    const search = el("input", "ytsc-search");
    search.placeholder = "Titel filtern…";
    search.addEventListener("input", () => {
      filterText = search.value.toLowerCase();
      if (cardsOn) renderGrid();
    });

    const sort = el("select", "ytsc-sort");
    [
      ["date", "Neueste"],
      ["views", "Aufrufe"],
      ["ctr", "CTR"],
      ["retention", "Retention"],
      ["watchTimeToday", "WT heute"],
      ["watchTime", "WT gesamt"],
      ["comments", "Kommentare"],
      ["likes", "Likes"],
      ["duration", "Dauer"],
      ["title", "Titel"],
    ].forEach(([v, label]) => {
      const o = el("option", null, label);
      o.value = v;
      sort.appendChild(o);
    });
    sort.value = sortKey;
    sort.addEventListener("change", () => {
      sortKey = sort.value;
      sortDir = sortKey === "title" ? 1 : -1;
      if (cardsOn) renderGrid();
    });

    const loadBtn = el("button", "ytsc-btn", "↻ Aktualisieren");
    loadBtn.addEventListener("click", () => loadAnalytics(loadBtn));

    const csvBtn = el("button", "ytsc-btn", "⬇ CSV");
    csvBtn.title = "Aktuelle Ansicht (oder Auswahl) als CSV exportieren";
    csvBtn.addEventListener("click", exportCsv);

    const cmpBtn = el("button", "ytsc-btn ytsc-compare", "⊞ Vergleichen");
    cmpBtn.id = "ytsc-compare-btn";
    cmpBtn.style.display = "none";
    cmpBtn.addEventListener("click", openCompare);

    const clearBtn = el("button", "ytsc-btn ytsc-clear", "✕");
    clearBtn.id = "ytsc-clear-btn";
    clearBtn.title = "Auswahl leeren";
    clearBtn.style.display = "none";
    clearBtn.addEventListener("click", () => {
      selectedData.clear();
      renderGrid();
    });

    const hint = el("span", "ytsc-hint");
    hint.id = "ytsc-hint";

    bar.append(toggle, search, sort, loadBtn, csvBtn, cmpBtn, clearBtn, hint);

    const grid = el("div", "ytsc-grid");
    grid.id = "ytsc-grid";
    grid.hidden = true;

    list.parentElement.insertBefore(bar, list);
    placeGrid(grid, list);

    // Liste paginiert/filtert -> Karten neu aufbauen (eigene Grid-Mutationen ignorieren)
    if (!ensureToolbar._obs) {
      ensureToolbar._obs = new MutationObserver((muts) => {
        if (!cardsOn) return;
        const g = document.getElementById("ytsc-grid");
        if (g && muts.every((m) => g === m.target || g.contains(m.target))) return;
        clearTimeout(ensureToolbar._t);
        ensureToolbar._t = setTimeout(() => {
          const fresh = scrapeRows();
          if (fresh.length) {
            currentRows = fresh;
            renderGrid();
          }
        }, 300);
      });
      ensureToolbar._obs.observe(list, { childList: true, subtree: true });
      ensureToolbar._watched = list;
    }
  }

  function setCards(on) {
    cardsOn = on;
    try {
      chrome.storage.local.set({ [VIEW_KEY]: on });
    } catch (_) {}
    const grid = document.getElementById("ytsc-grid");
    const toggle = document.querySelector(".ytsc-toggle");
    const list = listContainer();
    if (toggle) toggle.classList.toggle("active", on);
    if (grid) grid.hidden = !on;
    // Nur Header + Zeilen ausblenden – der Pager (#footer-container) bleibt sichtbar.
    if (list) list.classList.toggle("ytsc-rows-hidden", on);
    if (on) {
      currentRows = scrapeRows();
      renderGrid();
      loadAnalytics(null, true); // aus Cache/Harvest auffüllen
    }
  }

  function hasAny(key) {
    return currentRows.some((r) => r[key] != null);
  }

  function sortedRows() {
    let rows = currentRows.slice();
    if (filterText) rows = rows.filter((r) => r.title.toLowerCase().includes(filterText));
    rows.sort((a, b) => {
      if (sortKey === "title") return a.title.localeCompare(b.title) * sortDir;
      const av = sortKey === "date" ? a.dateMs : a[sortKey];
      const bv = sortKey === "date" ? b.dateMs : b[sortKey];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return (av - bv) * sortDir;
    });
    return rows;
  }

  function chipEl(label, value, cls) {
    const c = el("div", "ytsc-chip" + (cls ? " " + cls : ""));
    c.append(el("span", "ytsc-chip-label", label), el("span", "ytsc-chip-val", value));
    return c;
  }

  function pctClass(p, good, ok) {
    if (p == null) return "muted";
    return p >= good ? "good" : p >= ok ? "ok" : "warn";
  }

  // Sichtbarkeit -> Ampel-Punkt: grün öffentlich, gelb nicht gelistet, rot privat.
  function statusClass(v) {
    if (!v) return "draft";
    if (/öffentlich|public/i.test(v)) return "public";
    if (/nicht gelistet|unlisted/i.test(v)) return "unlisted";
    if (/privat|private/i.test(v)) return "private";
    return "draft";
  }

  function renderGrid() {
    let grid = document.getElementById("ytsc-grid");
    const list = listContainer();
    if (!grid) {
      if (!cardsOn || !list) return;
      grid = el("div", "ytsc-grid");
      grid.id = "ytsc-grid";
    }
    if (list && grid.parentElement !== list) placeGrid(grid, list); // selbstheilend
    grid.hidden = !cardsOn;
    const rows = sortedRows();
    const showLikes = hasAny("likes");
    grid.textContent = "";
    if (!rows.length) {
      grid.append(el("div", "ytsc-empty", "Keine Videos gefunden – evtl. lädt die Liste noch."));
      return;
    }
    for (const r of rows) {
      // Snapshot der Auswahl aktuell halten (frischere Metriken)
      if (selectedData.has(r.id)) selectedData.set(r.id, r);

      const card = el("div", "ytsc-card");
      if (selectedData.has(r.id)) card.classList.add("ytsc-selected");

      // Auswahl-Checkbox (für den Vergleich, seitenübergreifend)
      const sel = el("label", "ytsc-sel");
      const cb = el("input");
      cb.type = "checkbox";
      cb.checked = selectedData.has(r.id);
      cb.addEventListener("click", (ev) => ev.stopPropagation());
      cb.addEventListener("change", () => {
        if (cb.checked) selectedData.set(r.id, r);
        else selectedData.delete(r.id);
        card.classList.toggle("ytsc-selected", cb.checked);
        updateCompareBtn();
      });
      sel.append(cb);
      card.append(sel);

      const thumb = el("a", "ytsc-thumb");
      thumb.href = r.href;
      thumb.title = "Analytics öffnen";
      const img = el("img");
      img.loading = "lazy";
      img.src = r.thumb;
      img.addEventListener("error", () => {
        if (!img.dataset.fb) {
          img.dataset.fb = "1";
          img.src = `https://i.ytimg.com/vi/${r.id}/mqdefault.jpg`;
        }
      });
      thumb.append(img);
      if (r.duration != null) thumb.append(el("span", "ytsc-dur", fmtDuration(r.duration)));
      if (r.visibility) {
        const dot = el("span", "ytsc-status " + statusClass(r.visibility));
        dot.title = r.visibility;
        thumb.append(dot);
      }
      card.append(thumb);

      const body = el("div", "ytsc-body");
      const title = el("a", "ytsc-title", r.title);
      title.href = r.href;
      title.title = r.title;
      body.append(title);

      const ctrP = r.ctr;
      const retP = r.retention;
      const keys = el("div", "ytsc-keys");
      const ctrChip = chipEl("CTR", fmtPct(r.ctr), "key " + pctClass(ctrP, SETTINGS.ctrGood, SETTINGS.ctrOk));
      if (r.ctr == null)
        ctrChip.title = "Noch keine Daten – YouTube liefert Impressionen/CTR mit 1–2 Tagen Verzögerung";
      keys.append(ctrChip);
      keys.append(chipEl("Retention", fmtPct(r.retention), "key " + pctClass(retP, SETTINGS.retGood, SETTINGS.retOk)));
      body.append(keys);

      const chips = el("div", "ytsc-chips");
      chips.append(chipEl("Aufrufe", fmtCount(r.views)));
      chips.append(chipEl("Kommentare", fmtCount(r.comments)));
      if (showLikes) chips.append(chipEl("Likes", fmtCount(r.likes)));
      body.append(chips);

      // Vierer-Zeile: WT heute | WT gesamt | Online (Tage) | Datum (kurz)
      const chips3 = el("div", "ytsc-chips ytsc-chips-3 ytsc-chips-4");
      const wtToday = chipEl("WT heute", fmtWatch(r.watchTimeToday));
      wtToday.title = "Wiedergabezeit heute (seit 0 Uhr)";
      const wtTotal = chipEl("WT gesamt", fmtWatch(r.watchTime));
      wtTotal.title = "Wiedergabezeit gesamt";
      const online = chipEl("Online", fmtDaysOnline(r.dateMs));
      online.title = "Tage seit Veröffentlichung";
      chips3.append(wtToday, wtTotal, online, chipEl("Datum", fmtDateShort(r.date)));
      body.append(chips3);

      card.append(body);
      grid.append(card);
    }
    updateCompareBtn();
  }

  // ---------------------------------------------------------------- Vergleich
  function updateCompareBtn() {
    const b = document.getElementById("ytsc-compare-btn");
    const c = document.getElementById("ytsc-clear-btn");
    const n = selectedData.size;
    if (b) {
      b.style.display = n >= 2 ? "" : "none";
      b.textContent = `⊞ Vergleichen (${n})`;
    }
    if (c) c.style.display = n >= 1 ? "" : "none";
  }

  function metricPct(r, key) {
    return r[key]; // Werte sind bereits Prozent
  }

  function fmtMetric(key, r) {
    switch (key) {
      case "ctr": return fmtPct(r.ctr);
      case "retention": return fmtPct(r.retention);
      case "views": return fmtCount(r.views);
      case "comments": return fmtCount(r.comments);
      case "duration": return fmtDuration(r.duration);
      case "avgDuration": return fmtDuration(r.avgDuration);
      case "watchTime": return fmtWatch(r.watchTime);
      case "date": return r.date || "—";
      default: return "—";
    }
  }

  function closeCompare() {
    const b = document.getElementById("ytsc-modal-back");
    if (b) b.remove();
  }

  function openCompare() {
    closeCompare();
    const rows = [...selectedData.values()];
    if (rows.length < 2) return;

    const back = el("div", "ytsc-modal-back");
    back.id = "ytsc-modal-back";
    back.addEventListener("click", (e) => {
      if (e.target === back) closeCompare();
    });

    const panel = el("div", "ytsc-modal");
    const head = el("div", "ytsc-modal-head");
    head.append(el("div", "ytsc-modal-title", `Vergleich – ${rows.length} Videos`));
    const close = el("button", "ytsc-btn", "Schließen");
    close.addEventListener("click", closeCompare);
    head.append(close);
    panel.append(head);

    const table = el("table", "ytsc-cmp");
    const headRow = el("tr");
    headRow.append(el("th", "ytsc-cmp-corner"));
    rows.forEach((r) => {
      const th = el("th");
      const img = el("img", "ytsc-cmp-thumb");
      img.src = `https://i.ytimg.com/vi/${r.id}/mqdefault.jpg`;
      th.append(img);
      const t = el("div", "ytsc-cmp-vtitle", r.title);
      t.title = r.title;
      th.append(t);
      headRow.append(th);
    });
    table.append(headRow);

    // [key, Label, highlight=größer-ist-besser]
    const METRICS = [
      ["ctr", "CTR", true],
      ["retention", "Retention", true],
      ["avgDuration", "Ø Wiedergabedauer", true],
      ["watchTime", "Watchtime", true],
      ["views", "Aufrufe", true],
      ["comments", "Kommentare", true],
      ["duration", "Dauer", false],
      ["date", "Datum", false],
    ];
    METRICS.forEach(([key, label, highlight]) => {
      const tr = el("tr");
      tr.append(el("th", "ytsc-cmp-rowlabel", label));
      let best = null;
      if (highlight) {
        const vals = rows
          .map((r) => (key === "ctr" || key === "retention" ? metricPct(r, key) : r[key]))
          .filter((v) => v != null);
        if (vals.length) best = Math.max(...vals);
      }
      rows.forEach((r) => {
        const td = el("td", null, fmtMetric(key, r));
        if (highlight && best != null) {
          const v = key === "ctr" || key === "retention" ? metricPct(r, key) : r[key];
          if (v != null && v === best) td.classList.add("ytsc-cmp-best");
        }
        tr.append(td);
      });
      table.append(tr);
    });
    panel.append(table);
    back.append(panel);
    document.body.appendChild(back);
  }

  // ---------------------------------------------------------------- CSV-Export
  function csvEscape(s) {
    return '"' + String(s ?? "").replace(/"/g, '""') + '"';
  }
  function csvPct(v) {
    if (v == null) return "";
    return v.toFixed(2).replace(".", ","); // Prozent, deutsches Excel
  }

  function exportCsv() {
    if (!selectedData.size && !currentRows.length) currentRows = scrapeRows();
    const rows = selectedData.size ? [...selectedData.values()] : sortedRows();
    if (!rows.length) return;
    const head = ["Titel", "Video-ID", "Aufrufe", "Kommentare", "CTR %", "Retention %", "Watchtime (Sek.)", "Ø Wiedergabedauer (Sek.)", "Dauer (Sek.)", "Datum", "Sichtbarkeit"];
    const lines = [head.join(";")];
    for (const r of rows) {
      lines.push(
        [
          csvEscape(r.title),
          r.id,
          r.views ?? "",
          r.comments ?? "",
          csvPct(r.ctr),
          csvPct(r.retention),
          r.watchTime != null ? Math.round(r.watchTime) : "",
          r.avgDuration != null ? Math.round(r.avgDuration) : "",
          r.duration ?? "",
          csvEscape(r.date || ""),
          csvEscape(r.visibility || ""),
        ].join(";")
      );
    }
    // BOM, damit Excel Umlaute korrekt liest
    const blob = new Blob(["\uFEFF" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "yt-studio-videos-" + new Date().toISOString().slice(0, 10) + ".csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  // ------------------------------------------------- Analytics-Seiten-Panel
  // Auf jeder Video-Analytics-Seite: kleines Panel mit den Karten-Metriken des
  // Videos + Navigation zum nächst neueren/älteren Video. Jeder Besuch füttert
  // nebenbei die passive Ernte (inject.js) – Navigation = Daten sammeln.
  function orderedIds() {
    return Object.entries(videoOrder)
      .sort((a, b) => (b[1].dateMs || 0) - (a[1].dateMs || 0))
      .map(([id]) => id);
  }

  function analyticsHref(id) {
    return `https://studio.youtube.com/video/${id}/analytics/tab-overview/period-default`;
  }

  function pctOf(v) {
    return v; // Werte sind bereits Prozent
  }

  function renderAnPanel(vid) {
    if (panelHidden || !SETTINGS.showPanel) return;
    panelVideoId = vid;
    let p = document.getElementById("ytsc-anpanel");
    if (!p) {
      p = el("div", "ytsc-anpanel");
      p.id = "ytsc-anpanel";
      const head = el("div", "ytsc-anpanel-head");
      head.append(el("span", "ytsc-anpanel-title", "▦ Karten-Metriken"));
      const x = el("button", "ytsc-anpanel-x", "✕");
      x.title = "Für diese Sitzung ausblenden";
      x.addEventListener("click", () => {
        panelHidden = true;
        p.remove();
      });
      head.append(x);
      p.append(head);
      const body = el("div", "ytsc-anpanel-body");
      p.append(body);
      document.body.appendChild(p);
    }
    const body = p.querySelector(".ytsc-anpanel-body");
    body.textContent = "";

    const info = videoOrder[vid];
    if (info && info.title) body.append(el("div", "ytsc-anpanel-vtitle", info.title));

    const m = metricsCache[vid] || {};
    const chips = el("div", "ytsc-anpanel-chips");
    chips.append(chipEl("CTR", fmtPct(m.ctr), "key " + pctClass(pctOf(m.ctr), SETTINGS.ctrGood, SETTINGS.ctrOk)));
    chips.append(chipEl("Retention", fmtPct(m.retention), "key " + pctClass(pctOf(m.retention), SETTINGS.retGood, SETTINGS.retOk)));
    if (m.views != null) chips.append(chipEl("Aufrufe", fmtCount(m.views)));
    if (m.impressions != null) chips.append(chipEl("Impressionen", fmtCount(m.impressions)));
    const wtT = chipEl("WT heute", fmtWatch(m.todayDate === dateId() ? m.watchTimeToday : null));
    wtT.title = "Wiedergabezeit heute (seit 0 Uhr)";
    const wtA = chipEl("WT gesamt", fmtWatch(m.watchTime));
    wtA.title = "Wiedergabezeit gesamt";
    chips.append(wtT, wtA);
    body.append(chips);

    const ids = orderedIds();
    const i = ids.indexOf(vid);
    const nav = el("div", "ytsc-anpanel-nav");
    const newer = el("button", "ytsc-btn", "‹ Neueres");
    const older = el("button", "ytsc-btn", "Älteres ›");
    newer.disabled = i <= 0;
    older.disabled = i < 0 || i >= ids.length - 1;
    newer.title = i > 0 ? (videoOrder[ids[i - 1]] || {}).title || "" : "";
    older.title = i >= 0 && i < ids.length - 1 ? (videoOrder[ids[i + 1]] || {}).title || "" : "";
    newer.addEventListener("click", () => {
      if (i > 0) location.href = analyticsHref(ids[i - 1]);
    });
    older.addEventListener("click", () => {
      if (i >= 0 && i < ids.length - 1) location.href = analyticsHref(ids[i + 1]);
    });
    nav.append(newer, older);
    body.append(nav);
  }

  function removeAnPanel() {
    const p = document.getElementById("ytsc-anpanel");
    if (p) p.remove();
    panelVideoId = null;
  }

  // ------------------------------------------------- Dashboard-Insights
  // Füllt die leere rechte Spalte des Kanal-Dashboards mit einer Insights-
  // Karte aus dem Metrik-Cache: Ø CTR/Retention, Top- und Flop-Videos.
  const INSIGHT_MIN_DURATION = 120; // nur echte Videos ab 2 Minuten
  // Zeiträume: gefiltert wird nach VERÖFFENTLICHUNGSDATUM (Videos aus dem
  // Zeitraum); CTR/Retention pro Video sind weiterhin Lifetime-Werte.
  const DASH_RANGES = [
    ["all", "Immer", 0],
    ["year", "Jahr", 365],
    ["month", "Monat", 30],
    ["week", "Woche", 7],
  ];

  function insightRows(rangeKey) {
    const range = DASH_RANGES.find((r) => r[0] === rangeKey) || DASH_RANGES[0];
    const cutoff = range[2] ? Date.now() - range[2] * 86400000 : 0;
    const rows = [];
    for (const id in metricsCache) {
      const m = metricsCache[id];
      if (!m || (m.ctr == null && m.retention == null)) continue;
      const o = videoOrder[id];
      // Nur öffentliche Videos ab 2 Minuten. Shorts (kurz), Private, Entwürfe
      // und Einträge ohne bekannte Metadaten (kein Titel/Dauer) bleiben draußen.
      if (!o || !o.title) continue;
      if (o.duration == null || o.duration < INSIGHT_MIN_DURATION) continue;
      if (!o.visibility || !/öffentlich|public/i.test(o.visibility)) continue;
      if (cutoff && (!o.dateMs || o.dateMs < cutoff)) continue;
      rows.push({ id, title: o.title, dateMs: o.dateMs || 0, ctr: m.ctr ?? null, retention: m.retention ?? null });
    }
    return rows;
  }

  function colorFor(v, good, ok) {
    const c = pctClass(v, good, ok);
    return c === "good" ? "#3ddc84" : c === "ok" ? "#ffd24c" : c === "warn" ? "#ff6b6b" : "rgba(128,128,128,.8)";
  }

  // Zeitraum-Pills (Immer/Jahr/Monat/Woche) – von Insights- und Trend-Karte genutzt
  function rangePills(current, onSelect) {
    const wrap = el("div", "ytsc-dash-ranges");
    for (const [key, label] of DASH_RANGES) {
      const b = el("button", "ytsc-dash-range" + (current === key ? " active" : ""), label);
      b.addEventListener("click", () => onSelect(key));
      wrap.append(b);
    }
    return wrap;
  }

  function renderDashCard() {
    const col =
      document.querySelector("ytcd-card-column.right-column") ||
      [...document.querySelectorAll("ytcd-card-column")].pop();
    if (!col) return;
    let card = document.getElementById("ytsc-dash");
    if (!card) {
      card = el("div", "ytsc-dash");
      card.id = "ytsc-dash";
      col.prepend(card);
    }
    card.textContent = "";
    card.append(el("div", "ytsc-dash-title", "Karten-Insights"));

    // Zeitraum-Buttons (nach Veröffentlichungsdatum)
    card.append(
      rangePills(dashRange, (key) => {
        dashRange = key;
        try {
          chrome.storage.local.set({ ytsc_dash_range: key });
        } catch (_) {}
        renderDashCard();
      })
    );

    // Watchtime heute (Kanal): Summe über alle geladenen Videos mit
    // Heute-Wert – unabhängig von den Zeitraum-Pills, gleicher Video-Filter.
    const tId = dateId();
    let wtSum = 0,
      wtN = 0;
    for (const id in metricsCache) {
      const m = metricsCache[id];
      if (!m || m.watchTimeToday == null || m.todayDate !== tId) continue;
      const o = videoOrder[id];
      if (!o || !o.title || o.duration == null || o.duration < INSIGHT_MIN_DURATION) continue;
      if (!o.visibility || !/öffentlich|public/i.test(o.visibility)) continue;
      wtSum += m.watchTimeToday;
      wtN++;
    }
    if (wtN > 0) {
      const wt = el("div", "ytsc-dash-chip ytsc-dash-wt");
      wt.title = "Summe der Wiedergabezeit heute (seit 0 Uhr) über die geladenen Videos – ↻ in der Videoliste aktualisiert";
      wt.append(el("span", "ytsc-dash-chip-l", "WT heute (Kanal)"));
      wt.append(el("span", "ytsc-dash-chip-v", fmtWatch(wtSum)));
      wt.append(el("span", "ytsc-dash-wt-sub", `aus ${wtN} Videos · seit 0 Uhr`));
      card.append(wt);
    }

    const rows = insightRows(dashRange);
    const rangeLabel = (DASH_RANGES.find((r) => r[0] === dashRange) || DASH_RANGES[0])[1];
    if (!rows.length) {
      card.append(el("div", "ytsc-dash-sub", "Keine Daten im Zeitraum"));
      card.append(
        el(
          "div",
          "ytsc-dash-empty",
          dashRange === "all"
            ? "Öffne Inhalte → Videos, aktiviere ▦ Karten und lade ↻ CTR/Retention – die Insights erscheinen dann hier."
            : "In diesem Zeitraum wurden keine (geladenen) Videos veröffentlicht – wähle einen längeren Zeitraum."
        )
      );
      return;
    }
    card.append(
      el(
        "div",
        "ytsc-dash-sub",
        `Ø aus ${rows.length} Videos` + (dashRange === "all" ? "" : ` · veröffentlicht: ${rangeLabel}`)
      )
    );

    const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
    const aC = avg(rows.filter((r) => r.ctr != null).map((r) => r.ctr));
    const aR = avg(rows.filter((r) => r.retention != null).map((r) => r.retention));

    const grid = el("div", "ytsc-dash-avg");
    const bigChip = (label, v, good, ok) => {
      const c = el("div", "ytsc-dash-chip");
      c.append(el("span", "ytsc-dash-chip-l", label));
      const val = el("span", "ytsc-dash-chip-v", fmtPct(v));
      val.style.color = colorFor(v, good, ok);
      c.append(val);
      return c;
    };
    grid.append(bigChip("Ø CTR", aC, SETTINGS.ctrGood, SETTINGS.ctrOk));
    grid.append(bigChip("Ø Retention", aR, SETTINGS.retGood, SETTINGS.retOk));
    card.append(grid);

    const listSection = (title, items, key, color) => {
      if (!items.length) return;
      card.append(el("div", "ytsc-dash-sec", title));
      for (const r of items) {
        const row = el("div", "ytsc-dash-row");
        const a = el("a", "ytsc-dash-link", r.title);
        a.href = analyticsHref(r.id);
        a.title = r.title;
        const v = el("span", "ytsc-dash-val", fmtPct(r[key]));
        v.style.color = color;
        row.append(a, v);
        card.append(row);
      }
    };
    const byCtr = rows.filter((r) => r.ctr != null).sort((a, b) => b.ctr - a.ctr);
    const byRet = rows.filter((r) => r.retention != null).sort((a, b) => b.retention - a.retention);
    listSection("Top CTR", byCtr.slice(0, 3), "ctr", "#3ddc84");
    listSection("Top Retention", byRet.slice(0, 3), "retention", "#3ddc84");
    if (byCtr.length > 5) listSection("Schwächste CTR", byCtr.slice(-2).reverse(), "ctr", "#ff6b6b");
  }

  // ------------------------------------------------- Dashboard-Trend-Karte
  // CTR-/Retention-Verlauf über die Videos (chronologisch nach Datum),
  // geglättet per zentriertem gleitendem Durchschnitt; Rohwerte blass dahinter.
  function movingAvg(vals, win) {
    const half = Math.floor(win / 2);
    return vals.map((_, i) => {
      let s = 0,
        n = 0;
      for (let j = i - half; j <= i + half; j++) {
        if (j >= 0 && j < vals.length && vals[j] != null) {
          s += vals[j];
          n++;
        }
      }
      return n ? s / n : null;
    });
  }

  const SVG_NS = "http://www.w3.org/2000/svg";
  function svgEl(tag, attrs) {
    const e = document.createElementNS(SVG_NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }

  function trendChart(rows, key, color) {
    const pts = rows.filter((r) => r[key] != null);
    if (pts.length < 3) return null;
    const vals = pts.map((r) => r[key]);
    // Fensterbreite wächst sanft mit der Datenmenge (3..7)
    const win = Math.max(3, Math.min(7, Math.round(pts.length / 5)));
    const smooth = movingAvg(vals, win);
    const all = vals.concat(smooth.filter((v) => v != null));
    let min = Math.min(...all);
    let max = Math.max(...all);
    const pad = (max - min) * 0.12 || 1;
    min -= pad;
    max += pad;
    const W = 100,
      H = 36;
    const x = (i) => (pts.length === 1 ? W / 2 : (i / (pts.length - 1)) * W);
    const y = (v) => H - ((v - min) / (max - min)) * H;
    const toPoints = (arr) =>
      arr
        .map((v, i) => (v == null ? null : x(i).toFixed(2) + "," + y(v).toFixed(2)))
        .filter(Boolean)
        .join(" ");
    const svg = svgEl("svg", {
      viewBox: `0 0 ${W} ${H}`,
      preserveAspectRatio: "none",
      class: "ytsc-trend-svg",
    });
    svg.append(
      svgEl("polyline", {
        points: toPoints(vals),
        fill: "none",
        stroke: color,
        "stroke-width": "1",
        opacity: "0.25",
        "vector-effect": "non-scaling-stroke",
      })
    );
    svg.append(
      svgEl("polyline", {
        points: toPoints(smooth),
        fill: "none",
        stroke: color,
        "stroke-width": "2.2",
        "stroke-linejoin": "round",
        "stroke-linecap": "round",
        "vector-effect": "non-scaling-stroke",
      })
    );
    return { svg, last: smooth[smooth.length - 1], firstMs: pts[0].dateMs, lastMs: pts[pts.length - 1].dateMs, n: pts.length };
  }

  function fmtDay(ms) {
    if (!ms) return "";
    const d = new Date(ms);
    return String(d.getDate()).padStart(2, "0") + "." + String(d.getMonth() + 1).padStart(2, "0") + "." + String(d.getFullYear() % 100).padStart(2, "0");
  }

  function renderTrendCard() {
    const col =
      document.querySelector("ytcd-card-column.right-column") ||
      [...document.querySelectorAll("ytcd-card-column")].pop();
    if (!col) return;
    let card = document.getElementById("ytsc-trend");
    if (!card) {
      card = el("div", "ytsc-dash");
      card.id = "ytsc-trend";
      const ins = document.getElementById("ytsc-dash");
      if (ins) ins.after(card);
      else col.prepend(card);
    }
    card.textContent = "";
    card.append(el("div", "ytsc-dash-title", "Entwicklung"));

    // Zeitraum-Pills (eigener Zustand, unabhängig von den Insights)
    card.append(
      rangePills(trendRange, (key) => {
        trendRange = key;
        try {
          chrome.storage.local.set({ ytsc_trend_range: key });
        } catch (_) {}
        renderTrendCard();
      })
    );

    const rows = insightRows(trendRange)
      .filter((r) => r.dateMs)
      .sort((a, b) => a.dateMs - b.dateMs);

    const ctr = trendChart(rows, "ctr", "#6ea8ff");
    const ret = trendChart(rows, "retention", "#3ddc84");
    if (!ctr && !ret) {
      card.append(el("div", "ytsc-dash-sub", "Zu wenige Daten im Zeitraum"));
      card.append(
        el(
          "div",
          "ytsc-dash-empty",
          trendRange === "all"
            ? "Ab 3 Videos mit CTR/Retention erscheint hier der geglättete Verlauf – lade Werte über ↻ in der Videoliste."
            : "Für einen Verlauf braucht es mind. 3 Videos im Zeitraum – wähle einen längeren Zeitraum."
        )
      );
      return;
    }
    card.append(el("div", "ytsc-dash-sub", "geglättet (gleitender Ø) · chronologisch"));

    const section = (label, t, color) => {
      if (!t) return;
      const head = el("div", "ytsc-trend-sec");
      head.append(el("span", "ytsc-trend-name", label));
      const v = el("span", "ytsc-trend-val", "zuletzt " + fmtPct(t.last));
      v.style.color = color;
      head.append(v);
      card.append(head);
      card.append(t.svg);
      const axis = el("div", "ytsc-trend-axis");
      axis.append(el("span", null, fmtDay(t.firstMs)), el("span", null, `${t.n} Videos`), el("span", null, fmtDay(t.lastMs)));
      card.append(axis);
    };
    section("CTR-Verlauf", ctr, "#6ea8ff");
    section("Retention-Verlauf", ret, "#3ddc84");
  }

  function updateHint() {
    const hint = document.getElementById("ytsc-hint");
    if (!hint) return;
    const have = currentRows.filter((r) => r.ctr != null || r.retention != null).length;
    if (!analyticsSeeded && have === 0) {
      hint.textContent =
        "Öffne einmal die Analytics eines Videos – dann lädt ↻ CTR/Retention für alle.";
    } else if (have < currentRows.length) {
      hint.textContent = `${have}/${currentRows.length} geladen – ↻ lädt fehlende nach`;
    } else {
      hint.textContent = `${have}/${currentRows.length} mit CTR/Retention`;
    }
  }

  async function loadAnalytics(btn, silent) {
    if (!currentRows.length) currentRows = scrapeRows();
    const ids = currentRows.map((r) => r.id);
    if (btn) {
      btn.disabled = true;
      btn.textContent = "lädt…";
    }
    // Button-Klick => replay (alle Videos via Template); Auto => nur Cache.
    const res = await ask("getAnalytics", { videoIds: ids, replay: !silent });
    if (btn) {
      btn.disabled = false;
      btn.textContent = "↻ Aktualisieren";
    }
    if (res) {
      analyticsSeeded = !!res.seeded;
      if (res.metrics) applyMetrics(res.metrics, false); // Cache-Rücklauf -> nur Lücken füllen
    }
    updateHint();
  }

  // ------------------------------------------- Immer 50 Zeilen pro Seite
  // Studios Default ist 30. Das zugehörige ytcp-text-menu existiert im DOM
  // auch bei geschlossenem Dropdown – Klick aufs "50"-Item wählt direkt
  // (live verifiziert). Cooldown verhindert Klick-Schleifen.
  let pageSizeLastTry = 0;
  function ensurePageSize50() {
    if (Date.now() - pageSizeLastTry < 8000) return;
    const sel = document.querySelector("#footer-container ytcp-select");
    if (!sel) return;
    const cur = (sel.querySelector(".dropdown-trigger-text") || {}).textContent?.trim();
    if (!/^\d+$/.test(cur || "") || cur === "50") return;
    // Es gibt mehrere ytcp-text-menu-Kandidaten im DOM (teils Templates).
    // In ALLEN passenden (nur 10/30/50-Menüs) das 50er-Item klicken –
    // die falschen sind No-ops, das richtige schaltet um.
    const menus = [...document.querySelectorAll("ytcp-text-menu")].filter((m) => {
      const t = [...m.querySelectorAll("tp-yt-paper-item")].map((i) => i.textContent.trim());
      return t.length > 0 && t.length <= 5 && t.includes("50") && t.includes("30");
    });
    let clicked = false;
    for (const m of menus) {
      const item = [...m.querySelectorAll("tp-yt-paper-item")].find((i) => i.textContent.trim() === "50");
      if (item) {
        item.click();
        clicked = true;
      }
    }
    if (clicked) pageSizeLastTry = Date.now();
  }

  // ---------------------------------------------------------------- Routing
  function isVideosPage() {
    return /\/videos(\/|$|\?)/.test(location.pathname + location.search);
  }

  function cleanup() {
    const bar = document.getElementById("ytsc-toolbar");
    const grid = document.getElementById("ytsc-grid");
    if (bar) bar.remove();
    if (grid) grid.remove();
    const list = listContainer();
    if (list) list.classList.remove("ytsc-rows-hidden");
    cardsOn = false;
  }

  function tick() {
    // Analytics-Panel auf Video-Analytics-Seiten
    const am = location.pathname.match(/\/video\/([\w-]{11})\/analytics/);
    if (am) {
      if (!panelHidden && SETTINGS.showPanel) {
        if (!document.getElementById("ytsc-anpanel") || panelVideoId !== am[1]) {
          renderAnPanel(am[1]);
        }
      }
      // Fehlende Werte (CTR/Watchtime heute) fürs aktuelle Video selbst
      // nachladen – max. 3 Versuche, alle 6 s (Template braucht evtl. kurz).
      const m = metricsCache[am[1]] || {};
      const missing = m.ctr == null || m.watchTimeToday == null || m.todayDate !== dateId();
      if (panelReq.id !== am[1]) panelReq = { id: am[1], t: 0, tries: 0 };
      if (missing && panelReq.tries < 3 && Date.now() - panelReq.t > 6000) {
        panelReq.t = Date.now();
        panelReq.tries++;
        ask("getAnalytics", { videoIds: [am[1]], replay: true });
      }
    } else if (document.getElementById("ytsc-anpanel")) {
      removeAnPanel();
    }

    // Dashboard-Insights + Trend (Kanal-Dashboard: /channel/<id>)
    if (/^\/channel\/[\w-]+\/?$/.test(location.pathname)) {
      if (document.querySelector("ytcd-card-column")) {
        if (!document.getElementById("ytsc-dash")) renderDashCard();
        if (!document.getElementById("ytsc-trend")) renderTrendCard();
      }
    } else {
      for (const id of ["ytsc-dash", "ytsc-trend"]) {
        const d = document.getElementById(id);
        if (d) d.remove();
      }
    }

    if (!isVideosPage()) {
      if (document.getElementById("ytsc-toolbar")) cleanup();
      return;
    }
    ensurePageSize50();
    if (document.querySelector("ytcp-video-row") && !document.getElementById("ytsc-toolbar")) {
      ensureToolbar();
      scrapeRows(); // Videoverzeichnis (Titel/Dauer/Sichtbarkeit) auch ohne Karten-Modus auffrischen
      try {
        chrome.storage.local.get([VIEW_KEY], (r) => {
          if (r[VIEW_KEY]) setCards(true);
        });
      } catch (_) {}
    }

    // Selbstheilung: Studio ersetzt beim Navigieren/Sortieren manchmal den
    // kompletten Tabellen-Container -> Klasse und Observer neu anbringen,
    // sonst sind Karten UND native Liste gleichzeitig sichtbar.
    const list = listContainer();
    if (cardsOn && list) {
      if (!list.classList.contains("ytsc-rows-hidden")) {
        list.classList.add("ytsc-rows-hidden");
        currentRows = scrapeRows();
        renderGrid();
      }
      if (ensureToolbar._obs && ensureToolbar._watched !== list) {
        try {
          ensureToolbar._obs.disconnect();
        } catch (_) {}
        ensureToolbar._obs.observe(list, { childList: true, subtree: true });
        ensureToolbar._watched = list;
      }
    }
  }

  setInterval(tick, 1000);
  tick();
  LOG("bereit");
})();
