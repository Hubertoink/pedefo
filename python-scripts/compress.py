"""
Pedefo - PDF Compression
Komprimiert PDF-Dateien mit Ghostscript oder Python-Fallback
"""

import sys
import json
import os
import subprocess
import shutil
import glob
import re
import threading


def response(success, message, data=None):
    """Standardisierte JSON-Antwort"""
    import sys
    result = {
        "success": success,
        "message": message
    }
    if data:
        result["data"] = data
    
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass
    
    try:
        print(json.dumps(result, ensure_ascii=False))
    except Exception:
        print(json.dumps(result, ensure_ascii=True))


def progress(percent, message, stage=None, current=None, total=None):
    """Sendet eine Fortschrittsmeldung als JSON-Zeile an Electron."""
    payload = {
        "type": "progress",
        "percent": max(0, min(100, int(round(percent)))),
        "message": message
    }
    if stage:
        payload["stage"] = stage
    if current is not None:
        payload["current"] = current
    if total is not None:
        payload["total"] = total

    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass

    try:
        print(json.dumps(payload, ensure_ascii=False), flush=True)
    except Exception:
        print(json.dumps(payload, ensure_ascii=True), flush=True)


def get_file_size_mb(file_path):
    """Gibt die Dateigröße in MB zurück"""
    if os.path.exists(file_path):
        return os.path.getsize(file_path) / (1024 * 1024)
    return 0


def get_page_count(input_file):
    try:
        from PyPDF2 import PdfReader
        reader = PdfReader(input_file)
        return len(reader.pages)
    except Exception:
        return None


def find_ghostscript():
    """Findet den Ghostscript-Pfad"""
    # Windows: gswin64c oder gswin32c
    gs_names = ['gswin64c', 'gswin32c', 'gs']
    
    for gs_name in gs_names:
        gs_path = shutil.which(gs_name)
        if gs_path:
            return gs_path
    
    # Windows: typische Installationspfade dynamisch scannen (gs10.x etc.)
    # Beispiel: C:\Program Files\gs\gs10.03.1\bin\gswin64c.exe
    program_files_candidates = [
        os.environ.get('ProgramFiles'),
        os.environ.get('ProgramFiles(x86)'),
        r"C:\Program Files",
        r"C:\Program Files (x86)",
    ]

    def _version_key(path_str: str):
        # Extrahiere Version aus ...\gs10.03.1\...
        m = re.search(r"\\gs(?P<v>\d+(?:\.\d+){1,3})\\", path_str)
        if not m:
            return (0, 0, 0, 0)
        parts = [int(p) for p in m.group('v').split('.') if p.isdigit()]
        while len(parts) < 4:
            parts.append(0)
        return tuple(parts[:4])

    possible_paths = []
    for base in program_files_candidates:
        if not base:
            continue
        possible_paths.extend(glob.glob(os.path.join(base, 'gs', 'gs*', 'bin', 'gswin64c.exe')))
        possible_paths.extend(glob.glob(os.path.join(base, 'gs', 'gs*', 'bin', 'gswin32c.exe')))

    possible_paths = [p for p in possible_paths if os.path.exists(p)]
    if possible_paths:
        possible_paths.sort(key=_version_key, reverse=True)
        return possible_paths[0]
    
    return None


def compress_with_ghostscript(input_file, output_file, quality="ebook", total_pages=None):
    """Komprimiert PDF mit Ghostscript"""
    gs_path = find_ghostscript()
    
    if not gs_path:
        return False, "Ghostscript nicht gefunden. Bitte installiere Ghostscript."

    progress(12, "Ghostscript wird gestartet...", "ghostscript", 0, total_pages)
    
    # Quality-Stufen: screen (72dpi), ebook (150dpi), printer (300dpi), prepress (300dpi+)
    quality_map = {
        "low": "screen",      # Kleinste Größe, niedrigste Qualität
        "medium": "ebook",    # Gute Balance
        "high": "printer",    # Hohe Qualität
        "maximum": "prepress" # Maximale Qualität
    }
    
    gs_quality = quality_map.get(quality, quality)
    
    gs_cmd = [
        gs_path,
        "-sDEVICE=pdfwrite",
        "-dCompatibilityLevel=1.4",
        f"-dPDFSETTINGS=/{gs_quality}",
        "-dNOPAUSE",
        "-dBATCH",
        f"-sOutputFile={output_file}",
        input_file
    ]
    
    try:
        process = subprocess.Popen(
            gs_cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            errors="replace"
        )

        output_lines = []
        last_page = 0
        timed_out = {"expired": False}

        def kill_on_timeout():
            timed_out["expired"] = True
            try:
                process.kill()
            except Exception:
                pass

        timer = threading.Timer(300, kill_on_timeout)
        timer.start()

        try:
            for line in process.stdout or []:
                output_lines.append(line)
                match = re.search(r"\bPage\s+(\d+)\b", line)
                if match:
                    last_page = int(match.group(1))
                    if total_pages:
                        percent = 12 + (last_page / total_pages) * 76
                        progress(percent, f"Seite {last_page} von {total_pages} wird komprimiert...", "ghostscript", last_page, total_pages)
                    else:
                        progress(35, f"Seite {last_page} wird komprimiert...", "ghostscript", last_page, None)

            returncode = process.wait()
        finally:
            timer.cancel()

        if timed_out["expired"]:
            return False, "Timeout bei der Kompression"
        
        if returncode == 0 and os.path.exists(output_file):
            progress(92, "Komprimierte Datei wird geprüft...", "finalize", total_pages, total_pages)
            return True, "Erfolgreich mit Ghostscript komprimiert"
        else:
            return False, f"Ghostscript Fehler: {''.join(output_lines).strip()}"
    except Exception as e:
        return False, f"Fehler: {str(e)}"


def compress_with_pypdf(input_file, output_file, total_pages=None):
    """Fallback-Kompression mit PyPDF2 (weniger effektiv)"""
    try:
        from PyPDF2 import PdfReader, PdfWriter
        
        reader = PdfReader(input_file)
        writer = PdfWriter()
        page_count = total_pages or len(reader.pages)
        progress(12, "Basis-Kompression wird gestartet...", "pypdf", 0, page_count)
        
        for index, page in enumerate(reader.pages, start=1):
            page.compress_content_streams()
            writer.add_page(page)
            percent = 12 + (index / page_count) * 76 if page_count else 55
            progress(percent, f"Seite {index} von {page_count} wird komprimiert...", "pypdf", index, page_count)
        
        progress(92, "Komprimierte Datei wird geschrieben...", "finalize", page_count, page_count)
        with open(output_file, "wb") as f:
            writer.write(f)
        
        return True, "Komprimiert mit PyPDF2 (Basis-Kompression)"
    except ImportError:
        return False, "PyPDF2 nicht installiert"
    except Exception as e:
        return False, f"PyPDF2 Fehler: {str(e)}"


def compress_pdf(input_file, output_file, quality="medium"):
    """Hauptfunktion zur PDF-Kompression"""
    if not os.path.exists(input_file):
        response(False, f"Datei nicht gefunden: {input_file}")
        return
    
    progress(5, "PDF wird analysiert...", "prepare")
    original_size = get_file_size_mb(input_file)
    total_pages = get_page_count(input_file)
    if total_pages:
        progress(10, f"{total_pages} Seiten gefunden", "prepare", 0, total_pages)
    else:
        progress(10, "Seiten werden vorbereitet...", "prepare")
    
    # Versuche zuerst Ghostscript
    success, message = compress_with_ghostscript(input_file, output_file, quality, total_pages)
    
    # Fallback zu PyPDF2 wenn Ghostscript fehlschlägt
    if not success:
        gs_error = message
        progress(12, "Fallback-Kompression wird gestartet...", "pypdf", 0, total_pages)
        success, message = compress_with_pypdf(input_file, output_file, total_pages)
        if success:
            message += f" (Ghostscript nicht verfügbar: {gs_error})"
    
    if success and os.path.exists(output_file):
        new_size = get_file_size_mb(output_file)
        reduction = ((original_size - new_size) / original_size * 100) if original_size > 0 else 0
        progress(100, "Kompression abgeschlossen", "done", total_pages, total_pages)
        
        response(True, message, {
            "output": output_file,
            "original_size_mb": round(original_size, 2),
            "new_size_mb": round(new_size, 2),
            "reduction_percent": round(reduction, 1),
            "quality": quality
        })
    else:
        response(False, message)


def check_ghostscript():
    """Prüft ob Ghostscript verfügbar ist"""
    gs_path = find_ghostscript()
    if gs_path:
        response(True, "Ghostscript gefunden", {"path": gs_path})
    else:
        response(False, "Ghostscript nicht gefunden", {
            "install_hint": "Lade Ghostscript von https://ghostscript.com/releases/gsdnld.html herunter"
        })


if __name__ == "__main__":
    if len(sys.argv) < 2:
        response(False, "Kein Befehl angegeben. Verfügbar: compress, check")
        sys.exit(1)
    
    cmd = sys.argv[1]
    
    try:
        if cmd == "compress":
            # compress input.pdf output.pdf [quality]
            if len(sys.argv) < 4:
                response(False, "Benötigt: input.pdf output.pdf [quality: low/medium/high/maximum]")
            else:
                quality = sys.argv[4] if len(sys.argv) > 4 else "medium"
                compress_pdf(sys.argv[2], sys.argv[3], quality)
        
        elif cmd == "check":
            check_ghostscript()
        
        else:
            response(False, f"Unbekannter Befehl: {cmd}")
    
    except Exception as e:
        response(False, f"Fehler: {str(e)}")
