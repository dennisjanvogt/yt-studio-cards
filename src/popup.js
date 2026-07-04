/* Einstellungen der Extension (chrome.storage.local -> ytsc_settings).
 * content.js liest die Werte live über chrome.storage.onChanged. */
(() => {
  "use strict";

  const DEFAULTS = { ctrGood: 5, ctrOk: 3, retGood: 50, retOk: 35, cardMin: 300, showPanel: true, squareMode: true };
  const $ = (id) => document.getElementById(id);

  function flash(msg) {
    $("status").textContent = msg;
    setTimeout(() => ($("status").textContent = ""), 1800);
  }

  chrome.storage.local.get(["ytsc_settings"], (r) => {
    const s = Object.assign({}, DEFAULTS, r.ytsc_settings || {});
    $("ctrGood").value = s.ctrGood;
    $("ctrOk").value = s.ctrOk;
    $("retGood").value = s.retGood;
    $("retOk").value = s.retOk;
    $("cardMin").value = String(s.cardMin);
    $("showPanel").checked = !!s.showPanel;
    $("squareMode").checked = !!s.squareMode;
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
      squareMode: $("squareMode").checked,
    };
    chrome.storage.local.set({ ytsc_settings: s }, () => flash("Gespeichert ✓"));
  });

  $("clearCache").addEventListener("click", () => {
    chrome.storage.local.remove(["ytsc_metrics_cache", "ytsc_video_order"], () =>
      flash("Cache geleert ✓")
    );
  });
})();
