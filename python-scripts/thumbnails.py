"""
Pedefo - Thumbnail Generator
Generiert Vorschaubilder für PDF-Seiten mit Poppler (pdftoppm)
"""

import sys
import json
import os
import base64
import tempfile
import subprocess
from pathlib import Path

try:
    from PyPDF2 import PdfReader
except ImportError:
    pass


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


def get_poppler_path():
    """Ermittle den Pfad zu Poppler"""
    # Zuerst Umgebungsvariable prüfen (von Electron gesetzt)
    env_path = os.environ.get('POPPLER_PATH')
    if env_path and os.path.exists(env_path):
        return env_path
    
    script_dir = Path(__file__).parent
    
    # Im Development: relativ zum Script im electron-app Ordner
    dev_path = script_dir.parent / "electron-app" / "poppler" / "poppler-25.12.0" / "Library" / "bin"
    if dev_path.exists():
        return str(dev_path)
    
    # Im Build: extraResources/poppler
    # Das Script liegt in resources/python-scripts, Poppler in resources/poppler
    build_path = script_dir.parent / "poppler" / "poppler-25.12.0" / "Library" / "bin"
    if build_path.exists():
        return str(build_path)
    
    # Alternative Build-Struktur
    alt_build_path = script_dir.parent.parent / "poppler" / "poppler-25.12.0" / "Library" / "bin"
    if alt_build_path.exists():
        return str(alt_build_path)
    
    # Weitere mögliche Pfade (System-Installation)
    possible_paths = [
        r"C:\Program Files\poppler\Library\bin",
        r"C:\Program Files\poppler-25.12.0\Library\bin",
        r"C:\poppler\bin",
    ]
    for p in possible_paths:
        if os.path.exists(p):
            return p
    
    return None


def get_page_count(pdf_path):
    """Gibt die Seitenanzahl zurück"""
    try:
        reader = PdfReader(pdf_path)
        return len(reader.pages)
    except:
        return 0


def generate_thumbnails(pdf_path, dpi=72):
    """Generiert Thumbnails für alle Seiten mit pdftoppm"""
    if not os.path.exists(pdf_path):
        response(False, f"Datei nicht gefunden: {pdf_path}")
        return
    
    poppler_path = get_poppler_path()
    if not poppler_path:
        response(False, "Poppler nicht gefunden", {
            "hint": "Poppler sollte im electron-app/poppler Ordner sein"
        })
        return
    
    pdftoppm_exe = os.path.join(poppler_path, "pdftoppm.exe")
    
    if not os.path.exists(pdftoppm_exe):
        response(False, f"pdftoppm.exe nicht gefunden: {pdftoppm_exe}")
        return
    
    page_count = get_page_count(pdf_path)
    
    with tempfile.TemporaryDirectory() as temp_dir:
        output_prefix = os.path.join(temp_dir, "page")
        
        try:
            # pdftoppm ausführen
            cmd = [
                pdftoppm_exe,
                "-png",           # PNG-Format
                "-r", str(dpi),   # Auflösung (72 DPI für kleine Thumbnails)
                pdf_path,
                output_prefix
            ]
            
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=300
            )
            
            if result.returncode != 0:
                response(False, f"pdftoppm Fehler: {result.stderr}")
                return
            
            # Generierte Bilder sammeln
            thumbnails = []
            png_files = sorted(Path(temp_dir).glob("page-*.png"))
            
            for i, png_file in enumerate(png_files):
                with open(png_file, "rb") as f:
                    img_data = f.read()
                    b64_data = base64.b64encode(img_data).decode("utf-8")
                    thumbnails.append({
                        "page": i + 1,
                        "data": f"data:image/png;base64,{b64_data}"
                    })
            
            response(True, "Thumbnails generiert", {
                "page_count": len(thumbnails),
                "thumbnails": thumbnails,
                "method": "poppler"
            })
            
        except subprocess.TimeoutExpired:
            response(False, "Timeout bei der Thumbnail-Generierung")
        except Exception as e:
            response(False, f"Fehler: {str(e)}")


def check_poppler():
    """Prüft ob Poppler verfügbar ist"""
    poppler_path = get_poppler_path()
    if poppler_path:
        pdftoppm = os.path.join(poppler_path, "pdftoppm.exe")
        if os.path.exists(pdftoppm):
            response(True, "Poppler verfügbar", {"path": poppler_path})
        else:
            response(False, "pdftoppm.exe nicht gefunden", {"path": poppler_path})
    else:
        response(False, "Poppler nicht gefunden")


def generate_single_thumbnail(pdf_path, page_number, dpi=72):
    """Generiert ein Thumbnail für eine einzelne Seite"""
    if not os.path.exists(pdf_path):
        response(False, f"Datei nicht gefunden: {pdf_path}")
        return
    
    poppler_path = get_poppler_path()
    if not poppler_path:
        response(False, "Poppler nicht gefunden")
        return
    
    pdftoppm_exe = os.path.join(poppler_path, "pdftoppm.exe")
    
    if not os.path.exists(pdftoppm_exe):
        response(False, f"pdftoppm.exe nicht gefunden")
        return
    
    with tempfile.TemporaryDirectory() as temp_dir:
        output_prefix = os.path.join(temp_dir, "page")
        
        try:
            # pdftoppm für einzelne Seite ausführen
            cmd = [
                pdftoppm_exe,
                "-png",
                "-r", str(dpi),
                "-f", str(page_number),  # Erste Seite
                "-l", str(page_number),  # Letzte Seite (gleich = nur eine)
                pdf_path,
                output_prefix
            ]
            
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=60
            )
            
            if result.returncode != 0:
                response(False, f"pdftoppm Fehler: {result.stderr}")
                return
            
            # Generierte Bilder finden
            png_files = list(Path(temp_dir).glob("page-*.png"))
            
            if png_files:
                with open(png_files[0], "rb") as f:
                    img_data = f.read()
                    b64_data = base64.b64encode(img_data).decode("utf-8")
                    response(True, "Thumbnail generiert", {
                        "page": page_number,
                        "data": f"data:image/png;base64,{b64_data}"
                    })
            else:
                response(False, f"Kein Thumbnail für Seite {page_number} generiert")
                
        except subprocess.TimeoutExpired:
            response(False, "Timeout")
        except Exception as e:
            response(False, f"Fehler: {str(e)}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        response(False, "Kein Befehl angegeben. Verfügbar: generate, generate_single, check")
        sys.exit(1)
    
    cmd = sys.argv[1]
    
    try:
        if cmd == "generate":
            if len(sys.argv) < 3:
                response(False, "Benötigt: generate <pdf_path> [dpi]")
            else:
                pdf_path = sys.argv[2]
                dpi = int(sys.argv[3]) if len(sys.argv) > 3 else 72
                generate_thumbnails(pdf_path, dpi)
        
        elif cmd == "generate_single":
            if len(sys.argv) < 4:
                response(False, "Benötigt: generate_single <pdf_path> <page_number> [dpi]")
            else:
                pdf_path = sys.argv[2]
                page_number = int(sys.argv[3])
                dpi = int(sys.argv[4]) if len(sys.argv) > 4 else 72
                generate_single_thumbnail(pdf_path, page_number, dpi)
        
        elif cmd == "check":
            check_poppler()
        
        else:
            response(False, f"Unbekannter Befehl: {cmd}")
    
    except Exception as e:
        response(False, f"Fehler: {str(e)}")
