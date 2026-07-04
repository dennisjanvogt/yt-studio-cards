/* Service Worker: hält das Icon-Badge aktuell.
 * Badge = heutige Kanal-Watchtime (Summe über die geladenen Videos,
 * gleicher Filter wie die Dashboard-Insights: öffentlich, >= 2 Minuten).
 * Aktualisiert sich bei jeder Cache-Änderung (Ernte/↻ in Studio). */

const CACHE_KEY = "ytsc_metrics_cache";
const ORDER_KEY = "ytsc_video_order";
const MIN_DURATION = 120;

function dateId(d) {
  d = d || new Date();
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

function badgeText(sec) {
  if (!sec || sec <= 0) return "";
  const h = sec / 3600;
  if (h >= 10) return Math.round(h) + "h";
  if (h >= 1) return h.toFixed(1).replace(".", ",") + "h";
  const m = Math.round(sec / 60);
  return (m || 1) + "m";
}

function updateBadge() {
  chrome.storage.local.get([CACHE_KEY, ORDER_KEY], (r) => {
    const cache = r[CACHE_KEY] || {};
    const order = r[ORDER_KEY] || {};
    const tId = dateId();
    let sum = 0,
      n = 0;
    for (const id in cache) {
      const m = cache[id];
      if (!m || m.watchTimeToday == null || m.todayDate !== tId) continue;
      const o = order[id];
      if (!o || !o.title || o.duration == null || o.duration < MIN_DURATION) continue;
      if (!o.visibility || !/öffentlich|public/i.test(o.visibility)) continue;
      sum += m.watchTimeToday;
      n++;
    }
    chrome.action.setBadgeBackgroundColor({ color: "#d31e19" });
    if (chrome.action.setBadgeTextColor) {
      try {
        chrome.action.setBadgeTextColor({ color: "#ffffff" });
      } catch (_) {}
    }
    chrome.action.setBadgeText({ text: badgeText(sum) });
    chrome.action.setTitle({
      title: sum > 0 ? `WT heute (Kanal): ${Math.round(sum / 60)} Min · aus ${n} Videos` : "YT Studio Karten",
    });
  });
}

chrome.runtime.onInstalled.addListener(updateBadge);
chrome.runtime.onStartup.addListener(updateBadge);
chrome.storage.onChanged.addListener((ch, area) => {
  if (area === "local" && (ch[CACHE_KEY] || ch[ORDER_KEY])) updateBadge();
});
updateBadge();
