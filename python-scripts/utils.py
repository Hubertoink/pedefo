"""
Pedefo - PDF Utility Functions
Hilfsfunktionen für PDF-Operationen
"""

import os
import json
import sys


def get_pdf_info(pdf_path):
    """Gibt Informationen über eine PDF-Datei zurück"""
    try:
        from PyPDF2 import PdfReader
        reader = PdfReader(pdf_path)
        info = {
            "path": pdf_path,
            "filename": os.path.basename(pdf_path),
            "pages": len(reader.pages),
            "metadata": {}
        }
        
        if reader.metadata:
            info["metadata"] = {
                "title": reader.metadata.get("/Title", ""),
                "author": reader.metadata.get("/Author", ""),
                "subject": reader.metadata.get("/Subject", ""),
                "creator": reader.metadata.get("/Creator", "")
            }
        
        return info
    except Exception as e:
        return {"error": str(e)}


def validate_pdf(pdf_path):
    """Prüft ob eine Datei eine gültige PDF ist"""
    if not os.path.exists(pdf_path):
        return {"valid": False, "error": "Datei existiert nicht"}
    
    if not pdf_path.lower().endswith('.pdf'):
        return {"valid": False, "error": "Keine PDF-Datei"}
    
    try:
        from PyPDF2 import PdfReader
        reader = PdfReader(pdf_path)
        _ = len(reader.pages)
        return {"valid": True}
    except Exception as e:
        return {"valid": False, "error": str(e)}


def _outline_page_number(reader, destination):
    """Ermittelt die Seitennummer (1-basiert) für ein Outline-Ziel."""
    # Direkter Versuch über PyPDF2 API
    try:
        return reader.get_destination_page_number(destination) + 1
    except Exception:
        pass

    # Fallback: Destination-Objekt mit .page Attribut
    try:
        page_obj = getattr(destination, "page", None)
        if page_obj is not None:
            return reader.pages.index(page_obj) + 1
    except Exception:
        pass

    # Fallback: Dictionary mit /Page Referenz
    try:
        if isinstance(destination, dict) and "/Page" in destination:
            page_obj = destination["/Page"]
            return reader.pages.index(page_obj) + 1
    except Exception:
        pass

    return None


def _get_title(item):
    """Zieht den Titel aus Bookmark-Objekten oder Dicts."""
    # Dict mit /Title
    if isinstance(item, dict):
        raw = item.get("/Title", "")
    else:
        try:
            raw = getattr(item, "title", "")
        except Exception:
            raw = ""

    if not raw:
        return ""

    try:
        txt = str(raw)
    except Exception:
        txt = ""

    # Zeilenumbrüche / Wagenrücklauf in PDFs -> Leerzeichen
    return txt.replace("\r", " ").strip()


def _parse_outline_items(items, reader):
    """Konvertiert PyPDF2 Outlines in einfache Dicts mit Kindern."""
    result = []
    last_entry = None

    for item in items:
        # PyPDF2 repräsentiert Kinder oft als geschachtelte Listen
        if isinstance(item, list):
            if last_entry is not None:
                last_entry["children"] = _parse_outline_items(item, reader)
            else:
                result.extend(_parse_outline_items(item, reader))
            continue

        title = _get_title(item)
        page_num = _outline_page_number(reader, item)

        entry = {
            "title": title,
            "page": page_num,
            "children": []
        }

        # Manche Destination-Objekte haben bereits children
        try:
            child_items = getattr(item, "children", None)
            if child_items:
                entry["children"] = _parse_outline_items(child_items, reader)
        except Exception:
            pass

        result.append(entry)
        last_entry = entry

    return result


def _get_outline_items(reader):
    """Liest die Outline-Struktur kompatibel mit verschiedenen PyPDF2-Versionen."""
    candidates = []
    for attr in ["outlines", "outline"]:
        try:
            val = getattr(reader, attr, None)
            if val:
                candidates.append(val)
        except Exception:
            continue

    # Ältere Versionen
    try:
        val = reader.getOutlines()  # type: ignore[attr-defined]
        if val:
            candidates.append(val)
    except Exception:
        pass

    for outlines in candidates:
        try:
            if outlines:
                return outlines
        except Exception:
            continue
    return None


def get_outline(pdf_path):
    """Liest das Inhaltsverzeichnis (Outline) einer PDF."""
    if not os.path.exists(pdf_path):
        return {"error": "Datei existiert nicht"}

    try:
        from PyPDF2 import PdfReader
        reader = PdfReader(pdf_path, strict=False)
        outlines = _get_outline_items(reader)

        if not outlines:
            return {"outline": []}

        try:
            parsed = _parse_outline_items(outlines, reader)
        except Exception:
            parsed = []
        return {"outline": parsed}
    except Exception as e:
        return {"error": str(e)}


def get_file_size(file_path):
    """Gibt die Dateigröße in lesbarem Format zurück"""
    if not os.path.exists(file_path):
        return "0 B"
    
    size = os.path.getsize(file_path)
    for unit in ['B', 'KB', 'MB', 'GB']:
        if size < 1024:
            return f"{size:.2f} {unit}"
        size /= 1024
    return f"{size:.2f} TB"


def response(success, message, data=None):
    """Standardisierte JSON-Antwort für Electron"""
    import sys
    result = {
        "success": success,
        "message": message
    }
    if data:
        result["data"] = data
    
    # Ensure UTF-8 encoding for Windows console
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass
    
    try:
        output = json.dumps(result, ensure_ascii=False)
        print(output)
    except Exception as e:
        # Fallback: use ensure_ascii=True if Unicode fails
        output = json.dumps(result, ensure_ascii=True)
        print(output)
    
    return result


if __name__ == "__main__":
    if len(sys.argv) < 2:
        response(False, "Kein Befehl angegeben")
        sys.exit(1)
    
    cmd = sys.argv[1]
    
    if cmd == "info" and len(sys.argv) >= 3:
        info = get_pdf_info(sys.argv[2])
        if "error" in info:
            response(False, info["error"])
        else:
            response(True, "PDF-Info abgerufen", info)

    elif cmd == "outline" and len(sys.argv) >= 3:
        result = get_outline(sys.argv[2])
        if "error" in result:
            response(False, result["error"])
        else:
            response(True, "Outline gelesen", result)
    
    elif cmd == "validate" and len(sys.argv) >= 3:
        result = validate_pdf(sys.argv[2])
        response(result["valid"], result.get("error", "PDF ist gültig"))
    
    elif cmd == "size" and len(sys.argv) >= 3:
        size = get_file_size(sys.argv[2])
        response(True, f"Dateigröße: {size}", {"size": size})
    
    else:
        response(False, "Unbekannter Befehl oder fehlende Parameter")
