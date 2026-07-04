/* watch.js — MAIN world auf www.youtube.com.
 * Karten-Stats-Panel auf Watch-Pages, kategorisiert:
 *   MOMENTUM    Hero mit AKTUELLER Geschwindigkeit aus gesammelten Snapshots
 *               (echte Δ Views/Δ Zeit statt Lifetime-Ø) + Trend-Pfeil + Sparkline
 *   ENGAGEMENT  Like-/Kommentar-Quote (Ampel), Likes exakt
 *   REICHWEITE  Views/Abo, Länder-Verfügbarkeit, Kategorie
 *   METADATEN   exakter Upload-Zeitpunkt, Titel-/Beschreibungslänge, Links/Hashtags
 *   TAGS        einsehen + kopieren     THUMBNAIL  HD/SD-Links
 *
 * Datensammlung: pro Besuch wird ein Snapshot {views, likes, comments, t}
 * über die Bridge (square.js, ISOLATED world) in chrome.storage abgelegt.
 * Nur Dinge, die auf der Seite NICHT direkt sichtbar sind.
 */
(() => {
  "use strict";

  let enabled = true;
  let hidden = false;
  let currentVid = null;
  let tagsExpanded = false;
  let hist = null; // Snapshots des aktuellen Videos (aus der Bridge)
  let lastSnapSent = 0;

  // ---------------------------------------------------------------- Bridge
  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d) return;
    if (d.source === "YTSC-SET") {
      enabled = !d.settings || d.settings.watchPanel !== false;
      if (!enabled) removePanel();
    } else if (d.source === "YTSC-HIST" && d.vid === currentVid) {
      hist = Array.isArray(d.hist) ? d.hist : [];
      const data = collect();
      if (data) render(data);
    }
  });

  function post(msg) {
    try {
      window.postMessage(msg, location.origin);
    } catch (_) {}
  }

  // ---------------------------------------------------------------- Helpers
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  const SVG_NS = "http://www.w3.org/2000/svg";
  function svgEl(tag, attrs) {
    const e = document.createElementNS(SVG_NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }

  function parseNum(t) {
    if (!t) return null;
    t = String(t).toLowerCase();
    const mult = /mrd/.test(t) ? 1e9 : /mio/.test(t) ? 1e6 : 1;
    const m = t.match(/[\d][\d.,\s]*/);
    if (!m) return null;
    const num = m[0].replace(/\s/g, "").replace(/\./g, "").replace(",", ".");
    const v = parseFloat(num);
    return isFinite(v) ? Math.round(v * mult) : null;
  }

  function fmtInt(n) {
    return n == null ? "—" : Math.round(n).toLocaleString("de-DE");
  }
  function fmtPct(v) {
    if (v == null) return "—";
    return v.toFixed(v < 1 ? 2 : v < 10 ? 1 : 0).replace(".", ",") + " %";
  }
  const WEEKDAYS = ["So.", "Mo.", "Di.", "Mi.", "Do.", "Fr.", "Sa."];
  function fmtStamp(ms) {
    const d = new Date(ms);
    return (
      WEEKDAYS[d.getDay()] + " " +
      String(d.getDate()).padStart(2, "0") + "." + String(d.getMonth() + 1).padStart(2, "0") + "." + d.getFullYear() +
      " · " + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0") + " Uhr"
    );
  }
  function fmtAgo(ms) {
    const min = ms / 60000;
    if (min < 60) return "vor " + Math.max(1, Math.round(min)) + " Min";
    const h = min / 60;
    if (h < 48) return "vor " + Math.round(h) + " Std";
    return "vor " + Math.round(h / 24) + " Tagen";
  }
  function cls(v, good, ok) {
    if (v == null) return "";
    return v >= good ? " good" : v >= ok ? " ok" : " warn";
  }
  function urlVid() {
    const m = location.search.match(/[?&]v=([\w-]{11})/);
    return m ? m[1] : null;
  }

  // ---------------------------------------------------------------- Daten
  function collect() {
    const vid = urlVid();
    if (!vid) return null;
    const mp = document.getElementById("movie_player");
    const pr = mp && mp.getPlayerResponse ? mp.getPlayerResponse() : null;
    const vd = (pr && pr.videoDetails) || {};
    if (!vd.videoId || vd.videoId !== vid) return null;
    const mf = (pr.microformat && pr.microformat.playerMicroformatRenderer) || {};

    const views = vd.viewCount != null ? parseInt(vd.viewCount, 10) : null;
    const publish = mf.publishDate ? new Date(mf.publishDate).getTime() : null;
    const hours = publish ? Math.max((Date.now() - publish) / 3600000, 1) : null;

    let likes = mf.likeCount != null ? parseInt(mf.likeCount, 10) : null;
    if (likes == null) {
      const likeBtn = document.querySelector("like-button-view-model button, #segmented-like-button button");
      if (likeBtn) likes = parseNum(likeBtn.getAttribute("aria-label"));
    }
    let comments = null;
    const cc = document.querySelector("ytd-comments-header-renderer #count");
    if (cc) comments = parseNum(cc.textContent);
    let subs = null;
    const sc = document.querySelector("#owner-sub-count");
    if (sc) subs = parseNum(sc.textContent);

    // Echte aktuelle Geschwindigkeit aus Snapshots: ältesten Snapshot suchen,
    // der mind. 30 Min zurückliegt, und Δ Views / Δ Zeit rechnen.
    let nowVph = null, delta = null, deltaAgo = null;
    if (views != null && Array.isArray(hist) && hist.length) {
      const MIN_GAP = 30 * 60 * 1000;
      let ref = null;
      for (let i = hist.length - 1; i >= 0; i--) {
        if (Date.now() - hist[i].t >= MIN_GAP && hist[i].v != null) {
          ref = hist[i];
          break;
        }
      }
      if (!ref && hist[0] && Date.now() - hist[0].t >= MIN_GAP) ref = hist[0];
      if (ref) {
        const dt = Date.now() - ref.t;
        delta = views - ref.v;
        deltaAgo = dt;
        nowVph = delta / (dt / 3600000);
      }
    }

    const desc = vd.shortDescription || "";
    return {
      vid, views, publish,
      vph: views != null && hours ? views / hours : null,
      nowVph, delta, deltaAgo,
      likes, comments,
      likeRate: likes != null && views ? (likes / views) * 100 : null,
      commentRate: comments != null && views ? (comments / views) * 100 : null,
      viewsPerSub: views != null && subs ? (views / subs) * 100 : null,
      category: mf.category || null,
      countries: Array.isArray(mf.availableCountries) ? mf.availableCountries.length : null,
      unlisted: !!mf.isUnlisted,
      keywords: vd.keywords || [],
      titleLen: (vd.title || "").length,
      descLen: desc.length,
      descLinks: (desc.match(/https?:\/\//g) || []).length,
      hashtags: ((vd.title || "") + " " + desc).match(/#[\wäöüß]+/gi)?.length || 0,
    };
  }

  // ---------------------------------------------------------------- Panel
  function removePanel() {
    const p = document.getElementById("ytsc-watch");
    if (p) p.remove();
  }

  function chip(label, value, valueCls, title) {
    const c = el("div", "ytsc-w-chip");
    if (title) c.title = title;
    c.append(el("span", "ytsc-w-l", label), el("span", "ytsc-w-v" + (valueCls || ""), value));
    return c;
  }
  function metaRow(label, value) {
    const r = el("div", "ytsc-w-row");
    r.append(el("span", "ytsc-w-rl", label), el("span", "ytsc-w-rv", value));
    return r;
  }
  function section(name) {
    const s = el("div", "ytsc-w-sec");
    s.append(el("span", "ytsc-w-secname", name));
    return s;
  }

  function sparkline(values, color) {
    if (values.length < 3) return null;
    const W = 100, H = 24;
    let min = Math.min(...values), max = Math.max(...values);
    if (max === min) max = min + 1;
    const x = (i) => (i / (values.length - 1)) * W;
    const y = (v) => H - 2 - ((v - min) / (max - min)) * (H - 4);
    const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none", class: "ytsc-w-spark" });
    svg.append(
      svgEl("polyline", {
        points: values.map((v, i) => x(i).toFixed(1) + "," + y(v).toFixed(1)).join(" "),
        fill: "none", stroke: color, "stroke-width": "2",
        "stroke-linejoin": "round", "stroke-linecap": "round", "vector-effect": "non-scaling-stroke",
      })
    );
    return svg;
  }

  function copyText(text, btn) {
    const done = () => {
      btn.textContent = "kopiert ✓";
      setTimeout(() => (btn.textContent = "kopieren"), 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => fallback());
    } else fallback();
    function fallback() {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); done(); } catch (_) {}
      ta.remove();
    }
  }

  function render(d) {
    const host = document.querySelector("#secondary-inner") || document.querySelector("#below");
    if (!host) return;
    let p = document.getElementById("ytsc-watch");
    if (!p) {
      p = el("div", "ytsc-watch");
      p.id = "ytsc-watch";
      host.prepend(p);
    } else if (p.parentElement !== host) {
      host.prepend(p);
    }
    p.textContent = "";

    // Header
    const head = el("div", "ytsc-w-head");
    head.append(el("span", "ytsc-w-title", "Karten-Stats"));
    if (d.unlisted) head.append(el("span", "ytsc-w-badge", "nicht gelistet"));
    const x = el("button", "ytsc-w-x", "✕");
    x.title = "Für diese Sitzung ausblenden";
    x.addEventListener("click", () => { hidden = true; removePanel(); });
    head.append(x);
    p.append(head);

    // ---------- MOMENTUM (Hero) ----------
    p.append(section("Momentum"));
    const hero = el("div", "ytsc-w-hero");
    if (d.nowVph != null) {
      const trend = d.vph ? d.nowVph / d.vph : 1;
      const arrow = trend >= 1.15 ? "↗" : trend <= 0.85 ? "↘" : "→";
      const arrowCls = trend >= 1.15 ? " good" : trend <= 0.85 ? " warn" : "";
      const big = el("div", "ytsc-w-big");
      big.append(el("span", "ytsc-w-bignum" + arrowCls, fmtInt(d.nowVph)));
      big.append(el("span", "ytsc-w-bigunit", "Views/Std aktuell " + arrow));
      hero.append(big);
      hero.append(
        el("div", "ytsc-w-heroline", `Seit letztem Besuch (${fmtAgo(d.deltaAgo)}): +${fmtInt(d.delta)} Aufrufe`)
      );
    } else {
      const big = el("div", "ytsc-w-big");
      big.append(el("span", "ytsc-w-bignum accent", fmtInt(d.vph)));
      big.append(el("span", "ytsc-w-bigunit", "Views/Std · Ø seit Upload"));
      hero.append(big);
      hero.append(
        el("div", "ytsc-w-heroline ytsc-w-dim", hist && hist.length ? "Sammle Verlauf … (echtes Tempo ab ~30 Min zwischen zwei Besuchen)" : "Erster Besuch – ab jetzt wird der Verlauf dieses Videos gesammelt")
      );
    }
    hero.append(
      el("div", "ytsc-w-heroline ytsc-w-dim", `Ø seit Upload: ${fmtInt(d.vph)}/Std · ${d.vph != null ? fmtInt(d.vph * 24) : "—"}/Tag`)
    );
    if (hist && hist.length >= 3) {
      const sp = sparkline(hist.map((s) => s.v).filter((v) => v != null), "#6ea8ff");
      if (sp) {
        hero.append(sp);
        hero.append(el("div", "ytsc-w-heroline ytsc-w-dim", `${hist.length} Besuche erfasst · seit ${fmtAgo(Date.now() - hist[0].t).replace("vor ", "")}`));
      }
    }
    p.append(hero);

    // ---------- ENGAGEMENT ----------
    p.append(section("Engagement"));
    const g1 = el("div", "ytsc-w-grid");
    g1.append(chip("Like-Quote", fmtPct(d.likeRate), cls(d.likeRate, 4, 2), "grün ≥ 4 % · gelb ≥ 2 %"));
    g1.append(chip("Komm.-Quote", fmtPct(d.commentRate), cls(d.commentRate, 0.5, 0.2), d.comments == null ? "Lädt, sobald die Kommentare geladen sind" : "grün ≥ 0,5 % · gelb ≥ 0,2 %"));
    g1.append(chip("Likes (exakt)", fmtInt(d.likes), "", "Exakte Zahl – der Button rundet"));
    p.append(g1);

    // ---------- REICHWEITE ----------
    p.append(section("Reichweite"));
    const g2 = el("div", "ytsc-w-grid");
    g2.append(chip("Views/Abo", fmtPct(d.viewsPerSub), cls(d.viewsPerSub, 100, 30), "Über 100 % = Video trägt über die eigenen Abonnenten hinaus"));
    g2.append(chip("Länder", d.countries != null ? fmtInt(d.countries) : "—", "", "In wie vielen Ländern das Video verfügbar ist"));
    g2.append(chip("Kategorie", d.category || "—"));
    p.append(g2);

    // ---------- METADATEN ----------
    p.append(section("Metadaten"));
    const meta = el("div", "ytsc-w-meta");
    if (d.publish) meta.append(metaRow("Upload", fmtStamp(d.publish)));
    meta.append(metaRow("Titel / Beschreibung", `${d.titleLen} / ${d.descLen} Zeichen`));
    meta.append(metaRow("Links · Hashtags", `${d.descLinks} · ${d.hashtags}`));
    p.append(meta);

    // ---------- TAGS ----------
    const tHead = section(`Tags · ${d.keywords.length}`);
    if (d.keywords.length) {
      const copy = el("button", "ytsc-w-btn", "kopieren");
      copy.addEventListener("click", () => copyText(d.keywords.join(", "), copy));
      tHead.append(copy);
    }
    p.append(tHead);
    if (d.keywords.length) {
      const wrap = el("div", "ytsc-w-tags");
      const show = tagsExpanded ? d.keywords : d.keywords.slice(0, 8);
      for (const k of show) wrap.append(el("span", "ytsc-w-tag", k));
      if (!tagsExpanded && d.keywords.length > 8) {
        const more = el("button", "ytsc-w-tag ytsc-w-more", `+${d.keywords.length - 8}`);
        more.addEventListener("click", () => { tagsExpanded = true; render(d); });
        wrap.append(more);
      }
      p.append(wrap);
    } else {
      p.append(el("div", "ytsc-w-none", "Keine Tags gesetzt"));
    }

    // ---------- THUMBNAIL ----------
    const thumbs = section("Thumbnail");
    for (const [label, file] of [["HD ↗", "maxresdefault"], ["SD ↗", "sddefault"]]) {
      const a = el("a", "ytsc-w-btn", label);
      a.href = `https://i.ytimg.com/vi/${d.vid}/${file}.jpg`;
      a.target = "_blank";
      a.rel = "noopener";
      thumbs.append(a);
    }
    p.append(thumbs);
  }

  // ---------------------------------------------------------------- Loop
  function tick() {
    if (!enabled || hidden) return;
    const vid = urlVid();
    if (!vid) {
      removePanel();
      currentVid = null;
      hist = null;
      return;
    }
    if (vid !== currentVid) {
      currentVid = vid;
      tagsExpanded = false;
      hist = null;
      lastSnapSent = 0;
      removePanel();
      post({ source: "YTSC-GETHIST", vid });
    }
    const d = collect();
    if (!d) return;
    render(d);

    // Snapshot senden (Sammeln): einmal pro Besuch, erneut wenn Kommentare
    // nachgeladen wurden (max. alle 60 s)
    if (d.views != null && Date.now() - lastSnapSent > 60000) {
      lastSnapSent = Date.now();
      post({
        source: "YTSC-SNAP",
        snap: { vid: d.vid, t: Date.now(), v: d.views, l: d.likes, c: d.comments },
      });
    }
  }

  window.addEventListener("yt-navigate-finish", () => setTimeout(tick, 300));
  setInterval(tick, 3000);
  setTimeout(tick, 1500);
})();
