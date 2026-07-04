# YT Studio Karten – CTR & Retention

Chrome-Extension, die im **Inhalte → Videos**-Tab von YouTube Studio eine
**Karten-Ansicht** hinzufügt: großes Thumbnail, und **CTR + Retention** als
hervorgehobene Keys direkt nebeneinander – für mehrere Videos auf einen Blick.

## Installieren

1. `chrome://extensions` öffnen
2. **Entwicklermodus** (oben rechts) einschalten
3. **Entpackte Erweiterung laden** → diesen Ordner (`yt-studio-cards`) auswählen
4. Auf <https://studio.youtube.com> gehen, **Inhalte → Videos** öffnen
5. Oben in der Toolbar auf **▦ Karten** klicken

## CTR & Retention laden

CTR und Retention stehen im Inhalte-Tab **nicht** im DOM – die liefert nur das
interne Analytics-API von Studio. Die Extension greift dafür die Auth/Session der
laufenden Seite ab (kein extra Login, kein OAuth) und lädt die Werte nach.

Die Extension liest dafür Studios internen Endpoint
`youtubei/v1/yta_web/get_screen` / `get_cards` **passiv mit**: Was du in Studio an
Analytics öffnest, wird geparst und pro Video lokal (`chrome.storage`) gecacht.
Kein Auth-Trick, kein Extra-Request.

So füllst du die Karten:
1. Ein Video öffnen → dessen **Analytics**, Tab **Reichweite** (CTR/Impressionen)
   und/oder **Interaktion** (Retention)
2. Zurück zu **Inhalte → Videos** – die Werte stehen jetzt auf der Karte des Videos
3. Für weitere Videos wiederholen

Warum kein „alle auf einmal"? `get_screen` ist **screen-gebunden** – es liefert
immer die Daten des gerade betrachteten Videos und ignoriert einen Video-Filter.
Ein Replay für fremde Videos würde also falsche Werte liefern; deshalb wird nur
geerntet, was du tatsächlich öffnest. Mehrvideo-Tabellen (z. B. Analytics →
Inhalte, erweiterter Modus) werden, sofern sie als Tabelle geliefert werden,
zeilenweise mitgeerntet.

Danach werden die Werte pro Video geholt, farblich bewertet (grün/gelb/rot) und
lokal gecacht (`chrome.storage`), sodass sie beim nächsten Mal sofort da sind.

## Funktionen

**Inhalte → Videos (auch Shorts/Live-Tabs):**
- Karten-Grid mit großem 16:9-Thumbnail, Dauer-Badge und Status-Ampel
  (grün öffentlich, gelb nicht gelistet, rot privat)
- **CTR** und **Retention** hervorgehoben, Ampel-Farben (Schwellwerte einstellbar)
- Chips: Aufrufe, Kommentare, Datum – feste Raster-Plätze, zeilengleiche Karten
- Sortieren (Neueste, Aufrufe, CTR, Retention, …), Titel-Filter
- Pagination bleibt nutzbar (Pager unter dem Grid), Karten ziehen beim Blättern nach
- **Mehrfachauswahl + Vergleich** (seitenübergreifend): Checkbox auf der Karte →
  „⊞ Vergleichen" öffnet eine Tabelle, Bestwerte grün markiert
- **⬇ CSV-Export** der aktuellen Ansicht bzw. der Auswahl (Excel-tauglich, `;`-getrennt)

**Video-Analytics-Seiten:**
- Floating-Panel unten rechts mit den Karten-Metriken (CTR, Retention, Aufrufe,
  Impressionen) des Videos
- **‹ Neueres / Älteres ›**: direkt zum nächsten Video-Analytics springen –
  jeder Besuch füttert nebenbei den Metrik-Cache

**Watch-Pages auf youtube.com (Recherche, vidIQ-Style):**
Kategorisiertes Panel oben in der Sidebar jedes Videos (auch fremder Kanäle) –
zeigt bewusst nur, was auf der Seite NICHT sichtbar ist:
- **Momentum**: Hero mit **aktueller Geschwindigkeit** (echte Δ Views/Δ Zeit aus
  selbst gesammelten Snapshots!) inkl. Trend-Pfeil vs. Lifetime-Ø und Sparkline
- **Engagement**: Like-/Kommentar-Quote (Ampel-Benchmarks), Likes exakt
- **Reichweite**: Views/Abo (>100 % = trägt über die eigene Bubble), Länder-
  Verfügbarkeit, Kategorie
- **Metadaten**: exakter Upload-Zeitpunkt (Wochentag + Uhrzeit), Titel-/
  Beschreibungslänge, Links & Hashtags
- **Tags** einsehen + kopieren, **Thumbnail** HD/SD
- **Datensammlung**: pro Besuch wird ein Snapshot (Views/Likes/Kommentare)
  gespeichert (max. 40/Video, 300 Videos) – je öfter du ein Video besuchst,
  desto präziser das Momentum. Abschaltbar in den Einstellungen.

**Extension-Icon (überall in Chrome):**
- **Badge** zeigt die heutige Kanal-Watchtime direkt am Icon (z. B. „2,4h")
- **Popup = Mini-Dashboard**: WT heute (Kanal), Ø CTR/Retention (ampelgefärbt),
  Top-Video heute mit Direktlink in dessen Analytics – ohne Studio öffnen zu müssen
- Einstellungen darunter: Ampel-Schwellwerte, Kartengröße, Analytics-Panel,
  Eckig-Modus (alle Rundungen auf YouTube + Studio entfernen), Cache leeren

**Karten & Watchtime:**
- Karten zeigen zusätzlich **WT heute (seit 0 Uhr)** und **WT gesamt** pro Video
  (heutiges Zeitfenster via `screenConfig.timePeriod.dateIdRange`, live verifiziert)
- Sortierung auch nach WT heute / WT gesamt
- Dashboard-Insights mit WT-heute-Banner (Kanal-Summe) und geglätteten
  CTR-/Retention-Trend-Graphen, je mit Zeitraum-Filter (Immer/Jahr/Monat/Woche)

## Architektur

| Datei            | World    | Aufgabe |
|------------------|----------|---------|
| `src/inject.js`  | MAIN     | `fetch`/XHR mitlesen → Auth + Analytics-Antworten ernten; Template-Replay für CTR/Retention |
| `src/content.js` | ISOLATED | Seite erkennen, DOM scrapen, Karten-UI rendern, Bridge zur MAIN-world |
| `src/cards.css`  | –        | Styling (Dark/Light) |

Kommunikation läuft über `window.postMessage` mit Namespace `YTSC`.

## Bekannte Grenzen / Justierung

YouTube Studio nutzt obfuskierte Web-Components und ein undokumentiertes internes
API – beides ändert sich ohne Ankündigung. Robustheit ist bewusst eingebaut
(Spalten werden über Header-Position statt CSS-Klassen erkannt; das Analytics-Schema
wird aus echten Requests gelernt statt fest verdrahtet). Trotzdem gilt:

- **Metriken in den Karten fehlen (Aufrufe/Likes „—“):** Die Spaltenerkennung in
  `detectColumns()` / `scrapeRows()` (`src/content.js`) ist der Punkt zum Nachschärfen.
- **CTR/Retention bleiben „—“ trotz Vorlage:** Die Token in `TOKENS` und der Parser
  `harvestFromResponse()` (`src/inject.js`) müssen ans aktuelle Response-Schema
  angepasst werden. Echte Werte findest du im **Netzwerk-Tab** (DevTools) unter
  `youtubei/v1/analytics/...` – Response anschauen, Metrik-Keys übernehmen.

Nur für den Eigenbedarf gedacht (nutzt interne Endpoints – nicht für Verteilung im Store).
