/*
 * inject.js — MAIN world. Holt CTR & Retention aus Studios internem Analytics-API
 * (yta_web/get_screen) und füllt damit ALLE Videos, sobald du EIN Video-Analytics
 * geöffnet hast.
 *
 * Mechanik (verifiziert):
 *  1. Beim Öffnen eines Video-Analytics wird die echte get_screen-Anfrage als
 *     Template mitgeschnitten (URL, Header, Body) und in sessionStorage abgelegt
 *     (überlebt SPA-Navigation im Tab).
 *  2. Replay pro Video: die im Template enthaltene Video-ID wird im GESAMTEN Body
 *     gegen die Ziel-ID getauscht (auch entity_id -> Screen rebindet aufs Zielvideo).
 *     Für andere Metriken wird zusätzlich der Tab getauscht
 *     (OVERVIEW -> Retention/Views, REACH -> CTR/Impressionen).
 *  3. Antwort (cards-Format) wird geparst:
 *       keyMetricCardData.keyMetricTabs[].primaryContent {metric,total}
 *       audienceRetentionHighlightsCardData.videosData[0].metricTotals.avgPercentageWatched
 */
(() => {
  "use strict";

  const NS = "YTSC";
  const TPL_KEY = "ytsc_tpl";
  const AN_KEY = "ytsc_an_"; // pro-Video Analytics-Cache (sessionStorage)
  const TABS = ["OVERVIEW", "REACH"]; // Overview: Retention/Views ; Reach: CTR/Impressionen
  const MAXC = 3;

  const origFetch = window.fetch.bind(window);
  let template = null; // { url, method, headers, body, capturedId }

  try {
    const s = sessionStorage.getItem(TPL_KEY);
    if (s) template = JSON.parse(s);
  } catch (_) {}

  // Einmalige Migration: Retention war früher als Ratio (0..1) gespeichert,
  // jetzt einheitlich Prozent. Doppelt-Migration durch Flag + <=1-Guard verhindert.
  try {
    if (!sessionStorage.getItem("ytsc_an_migr2")) {
      for (let i = sessionStorage.length - 1; i >= 0; i--) {
        const k = sessionStorage.key(i);
        if (!k || !k.startsWith(AN_KEY)) continue;
        const c = JSON.parse(sessionStorage.getItem(k) || "{}");
        if (typeof c.retention === "number" && c.retention <= 1) {
          c.retention *= 100;
          sessionStorage.setItem(k, JSON.stringify(c));
        }
      }
      sessionStorage.setItem("ytsc_an_migr2", "1");
    }
  } catch (_) {}

  const ENUM_TO_KEY = {
    EXTERNAL_VIEWS: "views",
    VIDEO_THUMBNAIL_IMPRESSIONS: "impressions",
    VIDEO_THUMBNAIL_IMPRESSIONS_VTR: "ctr", // Prozent
    EXTERNAL_WATCH_TIME: "watchTime", // Millisekunden -> wird zu Sekunden
  };

  function dateId(d) {
    d = d || new Date();
    return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
  }

  const BAD_HEADERS = new Set([
    "host", "content-length", "origin", "referer", "cookie", "user-agent",
    "accept-encoding", "connection", "accept-language", "sec-fetch-mode",
    "sec-fetch-site", "sec-fetch-dest", "sec-ch-ua", "sec-ch-ua-mobile",
    "sec-ch-ua-platform",
  ]);
  function cleanHeaders(h) {
    const o = {};
    for (const k in h) if (!BAD_HEADERS.has(k.toLowerCase())) o[k] = h[k];
    return o;
  }
  function headersToObj(h) {
    const o = {};
    if (!h) return o;
    try {
      if (h instanceof Headers) h.forEach((v, k) => (o[k] = v));
      else if (Array.isArray(h)) h.forEach(([k, v]) => (o[k] = v));
      else Object.assign(o, h);
    } catch (_) {}
    return o;
  }
  function currentVideoId() {
    const m = location.pathname.match(/\/video\/([A-Za-z0-9_-]{11})(\/|$)/);
    return m ? m[1] : null;
  }
  function isScreen(url) {
    return !!url && url.indexOf("/youtubei/v1/") !== -1 && /get_screen/i.test(url);
  }

  // ---- Parser: cards-Format -> Metriken ---------------------------------
  function parseScreen(json) {
    const out = {};
    if (!json || !Array.isArray(json.cards)) return out;
    for (const card of json.cards) {
      const km = card.keyMetricCardData;
      if (km && Array.isArray(km.keyMetricTabs)) {
        for (const tab of km.keyMetricTabs) {
          const pc = tab.primaryContent || {};
          const metric = pc.metric || (tab.metricTabConfig && tab.metricTabConfig.metric);
          const total = typeof pc.total === "number" ? pc.total : null;
          const key = ENUM_TO_KEY[metric];
          if (key && total != null && out[key] == null) out[key] = total;
        }
      }
      const ar = card.audienceRetentionHighlightsCardData;
      if (ar && Array.isArray(ar.videosData) && ar.videosData[0]) {
        const mt = ar.videosData[0].metricTotals || {};
        // Einheiten (live verifiziert): VTR kommt als PROZENT (3.88 = 3,88 %),
        // avgPercentageWatched als RATIO (0.4035 = 40,35 %). Wir speichern
        // einheitlich Prozent – Anzeige rechnet nie mehr um.
        if (typeof mt.avgPercentageWatched === "number" && out.retention == null)
          out.retention = mt.avgPercentageWatched * 100;
        if (typeof mt.avgViewDurationMillis === "number" && out.avgDuration == null)
          out.avgDuration = mt.avgViewDurationMillis / 1000;
      }
    }
    if (out.watchTime != null) out.watchTime = out.watchTime / 1000; // ms -> Sekunden
    // Frische Videos: Impressionen/CTR laufen YouTube-seitig 1–2 Tage nach.
    // CTR 0 OHNE Impressionen heißt "noch keine Daten", nicht echte 0 –
    // nicht cachen, damit ein späteres ↻ den echten Wert nachlädt.
    if (out.ctr === 0 && !(out.impressions > 0)) {
      delete out.ctr;
      delete out.impressions;
    }
    return out;
  }

  // 0-CTR-Altlasten im Cache als "keine Daten" bereinigen
  function scrubNoData(c) {
    if (c && c.ctr === 0 && !(c.impressions > 0)) {
      delete c.ctr;
      delete c.impressions;
    }
    return c;
  }

  // ---- Template lernen ---------------------------------------------------
  function learn(url, method, headers, body) {
    const vid = currentVideoId();
    if (!vid || typeof body !== "string" || !body.length) return;
    template = { url, method: method || "POST", headers: headers || {}, body, capturedId: vid };
    try {
      sessionStorage.setItem(TPL_KEY, JSON.stringify(template));
    } catch (_) {}
    post("template", { capturedId: vid });
  }

  // ---- fetch / XHR hooken ------------------------------------------------
  window.fetch = function (input, init) {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    try {
      if (isScreen(url) && init && typeof init.body === "string") {
        learn(url, init.method, headersToObj(init.headers), init.body);
        // passiv: aktuelles Video sofort parsen
        const vid = currentVideoId();
        const p = origFetch(input, init);
        p.then((res) =>
          res.clone().json().then((j) => {
            const m = parseScreen(j);
            if (vid && Object.keys(m).length) {
              mergeCache(vid, m);
              post("harvest", { metrics: { [vid]: m } });
            }
          }).catch(() => {})
        ).catch(() => {});
        return p;
      }
    } catch (_) {}
    return origFetch(input, init);
  };

  try {
    const XO = XMLHttpRequest.prototype.open;
    const XS = XMLHttpRequest.prototype.send;
    const XH = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__u = url; this.__m = method; this.__h = {};
      return XO.apply(this, arguments);
    };
    XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
      try { (this.__h = this.__h || {})[k] = v; } catch (_) {}
      return XH.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function (body) {
      const url = this.__u || "";
      if (isScreen(url) && typeof body === "string" && body.length) {
        learn(url, this.__m, this.__h || {}, body);
        const vid = currentVideoId();
        this.addEventListener("load", () => {
          try {
            const m = parseScreen(JSON.parse(this.responseText));
            if (vid && Object.keys(m).length) {
              mergeCache(vid, m);
              post("harvest", { metrics: { [vid]: m } });
            }
          } catch (_) {}
        });
      }
      return XS.apply(this, arguments);
    };
  } catch (_) {}

  // ---- pro-Video Cache ---------------------------------------------------
  function anGet(vid) {
    try {
      const s = sessionStorage.getItem(AN_KEY + vid);
      if (s) return scrubNoData(JSON.parse(s));
    } catch (_) {}
    return null;
  }
  function mergeCache(vid, partial) {
    const cur = anGet(vid) || {};
    // Neue Werte ERSETZEN alte (frischer gewinnt) – nur null füllt nicht.
    for (const k in partial) if (partial[k] != null) cur[k] = partial[k];
    cur.t = Date.now();
    try {
      sessionStorage.setItem(AN_KEY + vid, JSON.stringify(cur));
    } catch (_) {}
    return cur;
  }
  const FRESH_MS = 30 * 60 * 1000; // ↻ refresht Werte, die älter als 30 min sind
  function isFresh(c) {
    return c && c.t && Date.now() - c.t < FRESH_MS;
  }
  function hasCore(vid) {
    const c = anGet(vid);
    return (
      c &&
      c.ctr != null &&
      c.retention != null &&
      isFresh(c) &&
      c.watchTimeToday != null &&
      c.todayDate === dateId(new Date())
    );
  }

  // ---- Replay pro Video (Overview + Reach) -------------------------------
  async function fetchVideo(vid) {
    const merged = anGet(vid) || {};
    const fresh = isFresh(merged);
    for (const tab of TABS) {
      if (tab === "OVERVIEW" && merged.retention != null && fresh) continue;
      if (tab === "REACH" && merged.ctr != null && fresh) continue;
      try {
        const res = await origFetch(template.url, {
          method: template.method || "POST",
          headers: cleanHeaders(template.headers),
          body: buildScreenBody(vid, tab, null),
          credentials: "include",
        });
        if (!res.ok) continue;
        const part = parseScreen(await res.json());
        for (const k in part) if (part[k] != null) merged[k] = part[k];
      } catch (_) {}
    }

    // Heutige Wiedergabezeit (seit 0 Uhr): OVERVIEW-Query mit heutigem
    // Datumsfenster (screenConfig.timePeriod.dateIdRange, live verifiziert);
    // aus der Antwort NUR watchTime übernehmen.
    const t0 = dateId(new Date());
    const t1 = dateId(new Date(Date.now() + 86400000));
    if (!(merged.watchTimeToday != null && merged.todayDate === t0 && fresh)) {
      try {
        const res = await origFetch(template.url, {
          method: template.method || "POST",
          headers: cleanHeaders(template.headers),
          body: buildScreenBody(vid, "OVERVIEW", [t0, t1]),
          credentials: "include",
        });
        if (res.ok) {
          const part = parseScreen(await res.json());
          if (part.watchTime != null) {
            merged.watchTimeToday = part.watchTime;
            merged.todayDate = t0;
          }
        }
      } catch (_) {}
    }

    mergeCache(vid, merged);
    return merged;
  }

  // Replay-Body bauen: Video-ID überall tauschen (String), dann Tab und
  // optional das Datumsfenster als echtes JSON setzen (robust gegen
  // Key-Reihenfolge; Struktur live verifiziert: screenConfig.timePeriod /
  // desktopState.tabId).
  function buildScreenBody(vid, tab, todayRange) {
    let str = template.body;
    if (template.capturedId && template.capturedId !== vid)
      str = str.split(template.capturedId).join(vid);
    try {
      const b = JSON.parse(str);
      if (b.desktopState) b.desktopState.tabId = "ANALYTICS_TAB_ID_" + tab;
      else b.desktopState = { tabId: "ANALYTICS_TAB_ID_" + tab };
      if (todayRange && b.screenConfig) {
        b.screenConfig.timePeriod = {
          dateIdRange: { inclusiveStart: todayRange[0], exclusiveEnd: todayRange[1] },
        };
      }
      return JSON.stringify(b);
    } catch (_) {
      // Fallback: alter String-Tausch (sollte nie nötig sein)
      return str.split("ANALYTICS_TAB_ID_OVERVIEW").join("ANALYTICS_TAB_ID_" + tab);
    }
  }

  async function replayAll(videoIds) {
    const todo = videoIds.filter((id) => /^[A-Za-z0-9_-]{11}$/.test(id) && !hasCore(id));
    let i = 0;
    async function worker() {
      while (i < todo.length) {
        const vid = todo[i++];
        const m = await fetchVideo(vid);
        if (m && Object.keys(m).length) post("harvest", { metrics: { [vid]: m } });
      }
    }
    await Promise.all(Array.from({ length: Math.min(MAXC, todo.length) }, worker));
  }

  // ---- Bridge ------------------------------------------------------------
  function cachedFor(videoIds) {
    const out = {};
    for (const id of videoIds) {
      const c = anGet(id);
      if (c) out[id] = c;
    }
    return out;
  }

  function post(cmd, payload) {
    window.postMessage(Object.assign({ source: NS + "-PAGE", cmd }, payload || {}), location.origin);
  }

  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.source !== NS) return;
    if (d.cmd === "getAnalytics") {
      const metrics = cachedFor(d.videoIds || []);
      post("analyticsResult", { reqId: d.reqId, metrics, seeded: !!template });
      if (d.replay && template) replayAll(d.videoIds || []);
    }
  });

  post("ready", { seeded: !!template });
})();
