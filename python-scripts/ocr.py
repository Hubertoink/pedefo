"""
Pedefo - OCR helper
Creates searchable PDFs from scanned PDF pages using Poppler and Tesseract.
"""

import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PyPDF2 import PdfReader, PdfWriter


def response(success, message, data=None):
    result = {"success": success, "message": message}
    if data:
        result["data"] = data

    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    print(json.dumps(result, ensure_ascii=True))


def progress(percent, message, stage="ocr", current=None, total=None):
    payload = {
        "type": "progress",
        "percent": max(0, min(100, int(percent))),
        "message": message,
        "stage": stage,
    }
    if current is not None:
        payload["current"] = current
    if total is not None:
        payload["total"] = total
    print(json.dumps(payload, ensure_ascii=True), flush=True)


def get_poppler_path():
    env_path = os.environ.get("POPPLER_PATH")
    if env_path and os.path.exists(env_path):
        return env_path

    script_dir = Path(__file__).parent
    candidates = [
        script_dir.parent / "electron-app" / "poppler" / "poppler-25.12.0" / "Library" / "bin",
        script_dir.parent / "poppler" / "poppler-25.12.0" / "Library" / "bin",
        script_dir.parent.parent / "poppler" / "poppler-25.12.0" / "Library" / "bin",
        Path(r"C:\Program Files\poppler\Library\bin"),
        Path(r"C:\Program Files\poppler-25.12.0\Library\bin"),
        Path(r"C:\poppler\bin"),
    ]

    for candidate in candidates:
        if candidate.exists():
            return str(candidate)

    return None


def find_tesseract():
    env_cmd = os.environ.get("TESSERACT_CMD") or os.environ.get("TESSERACT_PATH")
    if env_cmd and os.path.exists(env_cmd):
        return env_cmd

    path_cmd = shutil.which("tesseract")
    if path_cmd:
        return path_cmd

    candidates = [
        Path(r"C:\Program Files\Tesseract-OCR\tesseract.exe"),
        Path(r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe"),
    ]
    for candidate in candidates:
        if candidate.exists():
            return str(candidate)

    return None


def find_tessdata_path(tesseract_cmd=None):
    env_path = os.environ.get("TESSDATA_PREFIX")
    if env_path and os.path.exists(env_path):
        return env_path

    script_dir = Path(__file__).parent
    candidates = [
        Path.cwd() / "tessdata",
        Path.cwd().parent / "tessdata",
        Path(sys.executable).parent / "tessdata",
        Path(sys.executable).parent.parent / "tessdata",
        script_dir.parent / "tessdata",
        script_dir.parent.parent / "tessdata",
    ]

    if tesseract_cmd:
        candidates.append(Path(tesseract_cmd).parent / "tessdata")

    candidates.extend([
        Path(r"C:\Program Files\Tesseract-OCR\tessdata"),
        Path(r"C:\Program Files (x86)\Tesseract-OCR\tessdata"),
    ])

    for candidate in candidates:
        if candidate.exists() and any(candidate.glob("*.traineddata")):
            return str(candidate)

    return None


def check_ocr_dependencies():
    poppler_path = get_poppler_path()
    pdftoppm = os.path.join(poppler_path, "pdftoppm.exe") if poppler_path else None
    tesseract = find_tesseract()
    tessdata_path = find_tessdata_path(tesseract)

    missing = []
    if not pdftoppm or not os.path.exists(pdftoppm):
        missing.append("Poppler/pdftoppm")
    if not tesseract:
        missing.append("Tesseract OCR")

    try:
        import PIL  # noqa: F401
        import pytesseract  # noqa: F401
    except Exception as exc:
        missing.append(f"Python-OCR-Abhängigkeiten ({exc})")

    if missing:
        return {
            "ok": False,
            "missing": missing,
            "poppler_path": poppler_path,
            "tesseract_path": tesseract,
        }

    return {
        "ok": True,
        "missing": [],
        "poppler_path": poppler_path,
        "tesseract_path": tesseract,
        "tessdata_path": tessdata_path,
        "languages": get_tesseract_languages(tesseract, tessdata_path),
    }


def check_ocr_ready(lang="deu"):
    deps = check_ocr_dependencies()
    if not deps["ok"]:
        return deps

    languages = set(deps.get("languages") or [])
    missing_languages = [language for language in required_languages(lang) if language not in languages]
    if missing_languages:
        return {
            **deps,
            "ok": False,
            "missing_languages": missing_languages,
            "hint": "Für deutsche Umlaute muss die Sprache 'deu' installiert sein.",
        }

    return deps


def get_tesseract_languages(tesseract_cmd, tessdata_path=None):
    if not tesseract_cmd:
        return []
    try:
        cmd = [tesseract_cmd]
        if tessdata_path:
            cmd.extend(["--tessdata-dir", tessdata_path])
        cmd.append("--list-langs")

        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=20,
        )
        if result.returncode != 0:
            return []
        return [
            line.strip()
            for line in result.stdout.splitlines()
            if line.strip() and not line.lower().startswith("list of available")
        ]
    except Exception:
        return []


def required_languages(lang):
    return [part for part in (lang or "").split("+") if part and part != "osd"]


def render_page_to_image(pdftoppm, pdf_path, page_number, temp_dir, dpi):
    output_prefix = os.path.join(temp_dir, f"ocr_page_{page_number}")
    cmd = [
        pdftoppm,
        "-jpeg",
        "-jpegopt",
        "quality=78",
        "-r",
        str(dpi),
        "-f",
        str(page_number),
        "-l",
        str(page_number),
        pdf_path,
        output_prefix,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "Poppler konnte die Seite nicht rendern")

    image_files = sorted(Path(temp_dir).glob(f"ocr_page_{page_number}-*.jpg"))
    if not image_files:
        raise RuntimeError(f"Kein gerendertes Bild für Seite {page_number} gefunden")
    return str(image_files[0])


def create_searchable_pdf(input_path, output_path, lang="deu", dpi=200):
    deps = check_ocr_dependencies()
    if not deps["ok"]:
        response(False, "OCR ist nicht verfügbar", deps)
        return 1

    tessdata_path = deps.get("tessdata_path") or find_tessdata_path(deps["tesseract_path"])
    languages = set(get_tesseract_languages(deps["tesseract_path"], tessdata_path))
    missing_languages = [language for language in required_languages(lang) if language not in languages]
    if missing_languages:
        response(False, "Tesseract-Sprachdaten fehlen", {
            **deps,
            "missing_languages": missing_languages,
            "hint": "Für deutsche Umlaute muss die Sprache 'deu' installiert sein."
        })
        return 1

    import pytesseract

    pytesseract.pytesseract.tesseract_cmd = deps["tesseract_path"]
    if tessdata_path:
        os.environ["TESSDATA_PREFIX"] = tessdata_path
    pdftoppm = os.path.join(deps["poppler_path"], "pdftoppm.exe")

    if not os.path.exists(input_path):
        response(False, "PDF-Datei nicht gefunden")
        return 1

    reader = PdfReader(input_path, strict=False)
    total_pages = len(reader.pages)
    if total_pages == 0:
        response(False, "PDF enthält keine Seiten")
        return 1

    writer = PdfWriter()
    progress(3, "OCR wird vorbereitet...", "prepare", 0, total_pages)

    try:
        with tempfile.TemporaryDirectory() as temp_dir:
            for page_number in range(1, total_pages + 1):
                base_percent = 5 + int(((page_number - 1) / total_pages) * 90)
                progress(base_percent, f"Seite {page_number} von {total_pages} wird gerendert...", "render", page_number, total_pages)
                image_path = render_page_to_image(pdftoppm, input_path, page_number, temp_dir, dpi)

                progress(base_percent + 1, f"OCR für Seite {page_number} von {total_pages} läuft...", "ocr", page_number, total_pages)
                page_pdf = pytesseract.image_to_pdf_or_hocr(image_path, extension="pdf", lang=lang, config="--oem 1")
                page_reader = PdfReader(io.BytesIO(page_pdf), strict=False)
                writer.add_page(page_reader.pages[0])

        progress(97, "Durchsuchbare PDF wird geschrieben...", "write", total_pages, total_pages)
        with open(output_path, "wb") as output_file:
            writer.write(output_file)

        response(True, "OCR abgeschlossen", {
            "output": output_path,
            "pages": total_pages,
            "language": lang,
            "dpi": dpi,
        })
        return 0
    except Exception as exc:
        response(False, str(exc))
        return 1


if __name__ == "__main__":
    if len(sys.argv) < 2:
        response(False, "Kein Befehl angegeben")
        sys.exit(1)

    command = sys.argv[1]

    if command == "check":
        language = sys.argv[2] if len(sys.argv) >= 3 else "deu"
        deps = check_ocr_ready(language)
        if deps["ok"]:
            response(True, "OCR verfügbar", deps)
        elif deps.get("missing_languages"):
            response(False, "Tesseract-Sprachdaten fehlen", deps)
        else:
            response(False, "OCR benötigt Tesseract OCR", deps)
        sys.exit(0 if deps["ok"] else 1)

    if command == "ocr" and len(sys.argv) >= 4:
        input_pdf = sys.argv[2]
        output_pdf = sys.argv[3]
        language = sys.argv[4] if len(sys.argv) >= 5 else "deu"
        dpi_value = int(sys.argv[5]) if len(sys.argv) >= 6 else 200
        sys.exit(create_searchable_pdf(input_pdf, output_pdf, language, dpi_value))

    response(False, "Unbekannter Befehl oder fehlende Parameter")
    sys.exit(1)