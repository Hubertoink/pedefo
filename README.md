# 📄 Pedefo – Desktop PDF Editor & Reader

Pedefo ist eine lokale Electron-App zum schnellen Bearbeiten, Lesen und Extrahieren von PDFs. Keine Cloud, alles on-device mit Poppler/ Python-Backends.

![Electron](https://img.shields.io/badge/Electron-28-blue)
![Python](https://img.shields.io/badge/Python-3.9+-green)
![License](https://img.shields.io/badge/License-MIT-yellow)

## ✨ Funktionen

- 📂 **PDF laden per Drag & Drop** (lokal, offline)
- 🖼 **Raster-Ansicht**: Seiten duplizieren, löschen, drehen, neu anordnen, andere PDFs einfügen, Split-Marker setzen
- 📑 **Leseansicht mit Outline**: Kapitel anzeigen, aktive Kapitel automatisch hervorheben, Seitenbereiche pro Kapitel sehen
- 📤 **Kapitel/Seiten exportieren**: Kapitel-Export über Outline-Icon (verwendet berechnete Seitenbereiche), Auswahl-Export, Bereichs-Export
- 🗜 **Komprimieren**: Ghostscript (optional) für bessere Reduktion, PyPDF2 als Fallback
- 🖼 **Thumbnails**: Poppler-generiert, lazy loading; High-Res für Reader/Vollbild
- 🧭 **Vollbild-Viewer**: Navigation per Pfeiltasten, Outline-Anzeige mit Export-Buttons
- 🔔 **Toasts**: Erfolgsmeldungen mit „Öffnen“-Button nach Export
- 🧩 **Python-Bridge**: Split/Merge/Rotate/Compress/Outline via Python-Skripte

## 🛠 Voraussetzungen

- Node.js 18+
- Python 3.9+
- (Optional) Ghostscript für beste Kompression
- Poppler ist im Repo gebundled (`electron-app/poppler/`)

## 🚀 Schnellstart

```bash
cd pdf-app

# JS-Dependencies
npm install

# Python-Dependencies
pip install -r python-scripts/requirements.txt

# Starten (Entwicklung)

```

## 🧭 Bedienung (Kurzfassung)

- **PDF öffnen**: Datei in die Startfläche ziehen oder auswählen.
- **Raster-Ansicht**: Seiten anklicken/Shift-Range, Aktionen über Karten-Buttons oder Toolbar (Duplizieren, Löschen, Drehen). Split-Punkte über „Trennen“-Icon zwischen Seiten.
- **Leseansicht**: Outline rechts zeigt Kapitel inkl. Seitenbereich (z. B. `S. 29-133`), aktives Kapitel wird hervorgehoben. Klick springt zur Seite. Export-Icon exportiert den gesamten Kapitelbereich; Erfolgstoast bietet „Öffnen“ an.
- **Auswahl-Export**: Seiten markieren → „Extrahieren“. Bereichs-Export über Dialog.
- **Komprimieren**: Toolbar → Qualität wählen → exportieren.
- **Vollbild-Viewer**: Klick auf Vollbild-Button; Navigation mit ← → (oder ↑/↓/Space). Outline mit Export-Icons verfügbar.

## 🧱 Projektstruktur

```
pdf-app/
├─ electron-app/
│  ├─ index.html       # UI-Layout
│  ├─ renderer.js      # Frontend-Logik (Views, Outline, Export, Thumbs)
│  ├─ styles.css       # Styling
│  ├─ main.js          # Electron Main (IPC, Python Bridge)
│  └─ preload.js       # Sichere IPC-Bridge
├─ python-scripts/
│  ├─ split_merge.py   # Split/Merge/Rotate/Remove/Build
│  ├─ compress.py      # Kompression
│  ├─ thumbnails.py    # Thumbnails (Poppler)
│  └─ utils.py         # Outline/Info
├─ assets/             # Icons/Static
└─ package.json
```

## 🏗 Build (Installer)

```bash
# Windows
npm run build:win

# macOS
npm run build:mac

# Linux
npm run build:linux
```

Output landet unter `dist/`.

## 🔧 Troubleshooting

- **Python nicht gefunden**: Stelle sicher, dass `python` im PATH liegt (`python --version`).
- **Ghostscript nicht installiert**: Kompression funktioniert trotzdem, aber weniger effektiv. Installiere GS für bessere Ergebnisse.
- **Outline leer**: PDF hat kein TOC oder Poppler/`utils.py` liefert keins; App zeigt Placeholder.

## 📜 Lizenz

MIT License

---

Made with ❤️ for local, fast PDF work.
npm run build:win
