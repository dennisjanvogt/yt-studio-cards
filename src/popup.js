/* Popup: Mini-Dashboard (WT heute, Ø CTR/Retention, Top-Video heute) aus dem
 * chrome.storage-Cache + Einstellungen. Gleicher Video-Filter wie die
 * Dashboard-Insights: öffentlich, >= 2 Minuten, Titel bekannt. */
(() => {
  "use strict";

  const DEFAULTS = { ctrGood: 5, ctrOk: 3, retGood: 50, retOk: 35, cardMin: 300, showPanel: true, watchPanel: true, squareMode: true };
  const MIN_DURATION = 120;
  const $ = (id) => document.getElementById(id);

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function dateId(d) {
    d = d || new Date();
    return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
  }
  function fmtWatch(sec) {
    if (sec == null) return "—";
    const h = sec / 3600;
    if (h >= 1) return h.toFixed(h >= 10 ? 0 : 1).replace(".", ",") + " Std";
    const m = sec / 60;
    if (m >= 1) return Math.round(m) + " Min";
    return Math.round(sec) + " Sek";
  }
  function fmtPct(v) {
    if (v == null) return "—";
    return v.toFixed(v < 1 ? 2 : 1).replace(".", ",") + " %";
  }
  function colorFor(v, good, ok) {
    if (v == null) return "rgba(255,255,255,.5)";
    return v >= good ? "#3ddc84" : v >= ok ? "#ffd24c" : "#ff6b6b";
  }

  // ------------------------------------------------------- Mini-Dashboard
  function renderStats(cache, order, settings) {
    const box = $("stats");
    box.textContent = "";
    const tId = dateId();

    const rows = [];
    for (const id in cache) {
      const m = cache[id];
      if (!m) continue;
      const o = order[id];
      if (!o || !o.title || o.duration == null || o.duration < MIN_DURATION) continue;
      if (!o.visibility || !/öffentlich|public/i.test(o.visibility)) continue;
      rows.push({
        id,
        title: o.title,
        ctr: m.ctr ?? null,
        retention: m.retention ?? null,
        wtToday: m.todayDate === tId ? m.watchTimeToday ?? null : null,
      });
    }

    if (!rows.length) {
      box.append(
        el("div", "empty", "Noch keine Daten. Öffne in Studio Inhalte → Videos und lade ↻ CTR/Retention – dann erscheinen hier die Kanal-Stats.")
      );
      return;
    }

    // WT heute (Kanal)
    const withWt = rows.filter((r) => r.wtToday != null);
    const wtSum = withWt.reduce((s, r) => s + r.wtToday, 0);
    if (withWt.length) {
      const b = el("div", "wt-banner");
      b.append(el("div", "l", "WT heute (Kanal)"));
      b.append(el("div", "v", fmtWatch(wtSum)));
      b.append(el("div", "s", `aus ${withWt.length} Videos · seit 0 Uhr`));
      box.append(b);
    }

    // Ø CTR / Ø Retention
    const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
    const aC = avg(rows.filter((r) => r.ctr != null).map((r) => r.ctr));
    const aR = avg(rows.filter((r) => r.retention != null).map((r) => r.retention));
    if (aC != null || aR != null) {
      const grid = el("div", "avg");
      const chip = (label, v, good, ok) => {
        const c = el("div", "chip");
        c.append(el("div", "l", label));
        const val = el("div", "v", fmtPct(v));
        val.style.color = colorFor(v, good, ok);
        c.append(val);
        return c;
      };
      grid.append(chip("Ø CTR", aC, settings.ctrGood, settings.ctrOk));
      grid.append(chip("Ø Retention", aR, settings.retGood, settings.retOk));
      box.append(grid);
    }

    // Top-Video heute (nach Watchtime)
    const top = withWt.sort((a, b) => b.wtToday - a.wtToday)[0];
    if (top) {
      const t = el("div", "top");
      t.append(el("div", "l", "Top-Video heute"));
      const a = el("a", null, top.title);
      a.href = `https://studio.youtube.com/video/${top.id}/analytics/tab-overview/period-default`;
      a.target = "_blank";
      a.rel = "noopener";
      a.title = top.title;
      t.append(a);
      t.append(el("span", "val", fmtWatch(top.wtToday)));
      box.append(t);
    }
  }

  // ---------------------------------------------------------- Einstellungen
  function flash(msg) {
    $("status").textContent = msg;
    setTimeout(() => ($("status").textContent = ""), 1800);
  }

  chrome.storage.local.get(["ytsc_settings", "ytsc_metrics_cache", "ytsc_video_order"], (r) => {
    const s = Object.assign({}, DEFAULTS, r.ytsc_settings || {});
    $("ctrGood").value = s.ctrGood;
    $("ctrOk").value = s.ctrOk;
    $("retGood").value = s.retGood;
    $("retOk").value = s.retOk;
    $("cardMin").value = String(s.cardMin);
    $("showPanel").checked = !!s.showPanel;
    $("watchPanel").checked = !!s.watchPanel;
    $("squareMode").checked = !!s.squareMode;
    renderStats(r.ytsc_metrics_cache || {}, r.ytsc_video_order || {}, s);
  });

  $("save").addEventListener("click", () => {
    const num = (id, fb) => {
      const v = parseFloat($(id).value);
      return isFinite(v) && v >= 0 ? v : fb;
    };
    const s = {
      ctrGood: num("ctrGood", DEFAULTS.ctrGood),
      ctrOk: num("ctrOk", DEFAULTS.ctrOk),
      retGood: num("retGood", DEFAULTS.retGood),
      retOk: num("retOk", DEFAULTS.retOk),
      cardMin: parseInt($("cardMin").value, 10) || DEFAULTS.cardMin,
      showPanel: $("showPanel").checked,
      watchPanel: $("watchPanel").checked,
      squareMode: $("squareMode").checked,
    };
    chrome.storage.local.set({ ytsc_settings: s }, () => flash("Gespeichert ✓"));
  });

  $("clearCache").addEventListener("click", () => {
    chrome.storage.local.remove(["ytsc_metrics_cache", "ytsc_video_order", "ytsc_watch_hist"], () => {
      flash("Cache geleert ✓");
      renderStats({}, {}, DEFAULTS);
    });
  });
})();
