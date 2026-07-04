/* Eckig-Modus-Schalter: setzt die Klasse ytsc-square auf <html>, wenn die
 * Einstellung aktiv ist (Standard: an). Läuft auf youtube.com UND studio.
 * Live-Umschalten über chrome.storage.onChanged (Popup-Einstellung). */
(() => {
  "use strict";
  const apply = (s) =>
    document.documentElement.classList.toggle("ytsc-square", !s || s.squareMode !== false);
  try {
    chrome.storage.local.get(["ytsc_settings"], (r) => apply(r.ytsc_settings));
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area === "local" && ch.ytsc_settings) apply(ch.ytsc_settings.newValue);
    });
  } catch (_) {}
})();
