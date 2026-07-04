/* ISOLATED-World-Helfer auf youtube.com + Studio:
 * 1. Eckig-Modus: Klasse ytsc-square auf <html> (Standard: an).
 * 2. Settings-Bridge: postet Einstellungen in die MAIN world (watch.js).
 * 3. Snapshot-Sammler: nimmt Video-Snapshots aus watch.js entgegen und
 *    persistiert sie in chrome.storage (MAIN world hat kein chrome.*).
 *    Schema: ytsc_watch_hist = { videoId: [{t, v, l, c}, ...] }
 *    - Upsert: Snapshots < 10 Min Abstand werden zusammengefasst
 *    - Limits: max. 40 Snapshots pro Video, max. 300 Videos (älteste fliegen)
 */
(() => {
  "use strict";

  const HIST_KEY = "ytsc_watch_hist";
  const SNAP_BUCKET_MS = 10 * 60 * 1000;
  const MAX_SNAPS = 40;
  const MAX_VIDEOS = 300;

  const applySquare = (s) =>
    document.documentElement.classList.toggle("ytsc-square", !s || s.squareMode !== false);

  const send = (msg) => {
    try {
      window.postMessage(msg, location.origin);
    } catch (_) {}
  };
  const sendSettings = (s) => send({ source: "YTSC-SET", settings: s || {} });

  try {
    chrome.storage.local.get(["ytsc_settings"], (r) => {
      applySquare(r.ytsc_settings);
      sendSettings(r.ytsc_settings);
      setTimeout(() => sendSettings(r.ytsc_settings), 2500); // MAIN world evtl. später dran
    });
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area === "local" && ch.ytsc_settings) {
        applySquare(ch.ytsc_settings.newValue);
        sendSettings(ch.ytsc_settings.newValue);
      }
    });
  } catch (_) {}

  // ---- Snapshot-Bridge ----------------------------------------------------
  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d) return;

    if (d.source === "YTSC-GETHIST" && d.vid) {
      try {
        chrome.storage.local.get([HIST_KEY], (r) => {
          const hist = (r[HIST_KEY] || {})[d.vid] || [];
          send({ source: "YTSC-HIST", vid: d.vid, hist });
        });
      } catch (_) {}
    }

    if (d.source === "YTSC-SNAP" && d.snap && /^[\w-]{11}$/.test(d.snap.vid || "")) {
      const s = d.snap;
      try {
        chrome.storage.local.get([HIST_KEY], (r) => {
          const all = r[HIST_KEY] || {};
          const arr = all[s.vid] || [];
          const entry = { t: s.t, v: s.v ?? null, l: s.l ?? null, c: s.c ?? null };
          const last = arr[arr.length - 1];
          if (last && s.t - last.t < SNAP_BUCKET_MS) {
            // gleicher Besuch: aktualisieren statt anhängen (z. B. Kommentare nachgeladen)
            arr[arr.length - 1] = {
              t: last.t,
              v: entry.v ?? last.v,
              l: entry.l ?? last.l,
              c: entry.c ?? last.c,
            };
          } else {
            arr.push(entry);
            if (arr.length > MAX_SNAPS) arr.splice(0, arr.length - MAX_SNAPS);
          }
          all[s.vid] = arr;

          // Global begrenzen: älteste (zuletzt besuchte) Videos entfernen
          const ids = Object.keys(all);
          if (ids.length > MAX_VIDEOS) {
            ids
              .sort((a, b) => {
                const la = all[a][all[a].length - 1]?.t || 0;
                const lb = all[b][all[b].length - 1]?.t || 0;
                return la - lb;
              })
              .slice(0, ids.length - MAX_VIDEOS)
              .forEach((id) => delete all[id]);
          }
          chrome.storage.local.set({ [HIST_KEY]: all }, () => {
            send({ source: "YTSC-HIST", vid: s.vid, hist: all[s.vid] });
          });
        });
      } catch (_) {}
    }
  });
})();
