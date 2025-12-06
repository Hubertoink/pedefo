"""
Pedefo - PDF Compression
Komprimiert PDF-Dateien mit Ghostscript oder Python-Fallback
"""

import sys
import json
import os
import subprocess
import shutil


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


def get_file_size_mb(file_path):
    """Gibt die Dateigröße in MB zurück"""
    if os.path.exists(file_path):
        return os.path.getsize(file_path) / (1024 * 1024)
    return 0


def find_ghostscript():
    """Findet den Ghostscript-Pfad"""
    # Windows: gswin64c oder gswin32c
    gs_names = ['gswin64c', 'gswin32c', 'gs']
    
    for gs_name in gs_names:
        gs_path = shutil.which(gs_name)
        if gs_path:
            return gs_path
    
    # Typische Windows-Installationspfade
    possible_paths = [
        r"C:\Program Files\gs\gs10.02.1\bin\gswin64c.exe",
        r"C:\Program Files\gs\gs10.01.2\bin\gswin64c.exe",
        r"C:\Program Files\gs\gs10.00.0\bin\gswin64c.exe",
        r"C:\Program Files\gs\gs9.56.1\bin\gswin64c.exe",
        r"C:\Program Files (x86)\gs\gs9.56.1\bin\gswin32c.exe",
    ]
    
    for path in possible_paths:
        if os.path.exists(path):
            return path
    
    return None


def compress_with_ghostscript(input_file, output_file, quality="ebook"):
    """Komprimiert PDF mit Ghostscript"""
    gs_path = find_ghostscript()
    
    if not gs_path:
        return False, "Ghostscript nicht gefunden. Bitte installiere Ghostscript."
    
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
        "-dQUIET",
        "-dBATCH",
        f"-sOutputFile={output_file}",
        input_file
    ]
    
    try:
        result = subprocess.run(gs_cmd, capture_output=True, text=True, timeout=300)
        
        if result.returncode == 0 and os.path.exists(output_file):
            return True, "Erfolgreich mit Ghostscript komprimiert"
        else:
            return False, f"Ghostscript Fehler: {result.stderr}"
    except subprocess.TimeoutExpired:
        return False, "Timeout bei der Kompression"
    except Exception as e:
        return False, f"Fehler: {str(e)}"


def compress_with_pypdf(input_file, output_file):
    """Fallback-Kompression mit PyPDF2 (weniger effektiv)"""
    try:
        from PyPDF2 import PdfReader, PdfWriter
        
        reader = PdfReader(input_file)
        writer = PdfWriter()
        
        for page in reader.pages:
            page.compress_content_streams()
            writer.add_page(page)
        
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
    
    original_size = get_file_size_mb(input_file)
    
    # Versuche zuerst Ghostscript
    success, message = compress_with_ghostscript(input_file, output_file, quality)
    
    # Fallback zu PyPDF2 wenn Ghostscript fehlschlägt
    if not success:
        gs_error = message
        success, message = compress_with_pypdf(input_file, output_file)
        if success:
            message += f" (Ghostscript nicht verfügbar: {gs_error})"
    
    if success and os.path.exists(output_file):
        new_size = get_file_size_mb(output_file)
        reduction = ((original_size - new_size) / original_size * 100) if original_size > 0 else 0
        
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
