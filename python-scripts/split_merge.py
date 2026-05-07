"""
Pedefo - Split/Merge PDF Operations
Funktionen zum Aufteilen und Zusammenführen von PDF-Dateien
"""

import sys
import json
import os

try:
    from PyPDF2 import PdfMerger, PdfReader, PdfWriter
except ImportError:
    print(json.dumps({
        "success": False,
        "message": "PyPDF2 ist nicht installiert. Bitte führe 'pip install PyPDF2' aus."
    }))
    sys.exit(1)


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


def merge_pdfs(files, output):
    """Führt mehrere PDF-Dateien zusammen"""
    try:
        merger = PdfMerger()
        for f in files:
            if not os.path.exists(f):
                response(False, f"Datei nicht gefunden: {f}")
                return
            merger.append(f)
        
        merger.write(output)
        merger.close()
        response(True, f"PDF erfolgreich zusammengeführt", {
            "output": output,
            "merged_files": len(files)
        })
    except Exception as e:
        response(False, f"Fehler beim Zusammenführen: {str(e)}")


def split_pdf(input_file, start, end, output):
    """Extrahiert Seiten aus einer PDF (1-basierte Seitenzahlen)"""
    try:
        if not os.path.exists(input_file):
            response(False, f"Datei nicht gefunden: {input_file}")
            return
        
        reader = PdfReader(input_file)
        total_pages = len(reader.pages)
        
        # Konvertiere zu 0-basierten Index
        start_idx = max(0, start - 1)
        end_idx = min(end, total_pages)
        
        if start_idx >= end_idx:
            response(False, "Ungültiger Seitenbereich")
            return
        
        writer = PdfWriter()
        for i in range(start_idx, end_idx):
            writer.add_page(reader.pages[i])
        
        with open(output, "wb") as f:
            writer.write(f)
        
        response(True, f"PDF erfolgreich geteilt", {
            "output": output,
            "pages_extracted": end_idx - start_idx,
            "page_range": f"{start}-{end}"
        })
    except Exception as e:
        response(False, f"Fehler beim Teilen: {str(e)}")


def remove_pages(input_file, pages_to_remove, output):
    """Entfernt bestimmte Seiten aus einer PDF (1-basierte Seitenzahlen)"""
    try:
        if not os.path.exists(input_file):
            response(False, f"Datei nicht gefunden: {input_file}")
            return
        
        reader = PdfReader(input_file)
        writer = PdfWriter()
        total_pages = len(reader.pages)
        
        # Konvertiere zu 0-basierten Indizes
        pages_to_remove_idx = set(p - 1 for p in pages_to_remove if 0 < p <= total_pages)
        
        pages_kept = 0
        for i in range(total_pages):
            if i not in pages_to_remove_idx:
                writer.add_page(reader.pages[i])
                pages_kept += 1
        
        if pages_kept == 0:
            response(False, "Keine Seiten übrig nach dem Entfernen")
            return
        
        with open(output, "wb") as f:
            writer.write(f)
        
        response(True, f"Seiten erfolgreich entfernt", {
            "output": output,
            "pages_removed": len(pages_to_remove_idx),
            "pages_remaining": pages_kept
        })
    except Exception as e:
        response(False, f"Fehler beim Entfernen: {str(e)}")


def rotate_pages(input_file, pages, rotation, output):
    """Rotiert bestimmte Seiten einer PDF"""
    try:
        if not os.path.exists(input_file):
            response(False, f"Datei nicht gefunden: {input_file}")
            return
        
        reader = PdfReader(input_file)
        writer = PdfWriter()
        total_pages = len(reader.pages)
        
        # Konvertiere zu 0-basierten Indizes
        pages_to_rotate = set(p - 1 for p in pages if 0 < p <= total_pages)
        
        for i in range(total_pages):
            page = reader.pages[i]
            if i in pages_to_rotate:
                page.rotate(rotation)
            writer.add_page(page)
        
        with open(output, "wb") as f:
            writer.write(f)
        
        response(True, f"Seiten erfolgreich rotiert", {
            "output": output,
            "pages_rotated": len(pages_to_rotate),
            "rotation": rotation
        })
    except Exception as e:
        response(False, f"Fehler beim Rotieren: {str(e)}")


def get_page_count(input_file):
    """Gibt die Seitenanzahl einer PDF zurück"""
    try:
        if not os.path.exists(input_file):
            response(False, f"Datei nicht gefunden: {input_file}")
            return
        
        reader = PdfReader(input_file)
        response(True, "Seitenanzahl ermittelt", {
            "pages": len(reader.pages),
            "file": input_file
        })
    except Exception as e:
        response(False, f"Fehler: {str(e)}")


def _is_contiguous_unrotated_pages(pages):
    if not pages:
        return False

    expected = pages[0]['originalNumber']
    for page_info in pages:
        if page_info.get('rotation', 0) != 0:
            return False
        if page_info['originalNumber'] != expected:
            return False
        expected += 1
    return True


def _normalize_chapters(chapters, total_pages):
    normalized = []
    if not isinstance(chapters, list):
        return normalized

    for chapter in chapters:
        if not isinstance(chapter, dict):
            continue
        title = str(chapter.get('title', '')).strip()
        if not title:
            continue
        try:
            page_number = int(chapter.get('page', 0))
        except Exception:
            continue
        if 1 <= page_number <= total_pages:
            normalized.append({
                'title': title[:200],
                'page': page_number
            })

    return normalized


def _add_outline_item(writer, title, page_index):
    if hasattr(writer, 'add_outline_item'):
        writer.add_outline_item(title, page_index)
    elif hasattr(writer, 'addBookmark'):
        writer.addBookmark(title, page_index)


def build_pdf(operations_json, output):
    """
    Baut eine PDF aus mehreren Quellen mit Rotationen zusammen.
    operations_json: JSON-Array von Objekten mit {sourceFile, pages: [{originalNumber, rotation}]}
    oder Objekt {operations, chapters}, wobei chapters PDF-Outlines erzeugt.
    """
    try:
        import json as json_module
        payload = json_module.loads(operations_json)
        if isinstance(payload, dict):
            operations = payload.get('operations', [])
            chapters = payload.get('chapters', [])
        else:
            operations = payload
            chapters = []
        
        writer = PdfWriter()
        total_pages = 0
        
        for op in operations:
            source_file = op['sourceFile']
            
            if not os.path.exists(source_file):
                response(False, f"Datei nicht gefunden: {source_file}")
                return
            
            pages = op.get('pages', [])

            if _is_contiguous_unrotated_pages(pages):
                start_idx = max(0, pages[0]['originalNumber'] - 1)
                end_idx = pages[-1]['originalNumber']
                writer.append(source_file, pages=(start_idx, end_idx), import_outline=False)
                total_pages += end_idx - start_idx
                continue

            reader = PdfReader(source_file)
            
            for page_info in pages:
                page_num = page_info['originalNumber'] - 1  # 0-basiert
                rotation = page_info.get('rotation', 0)
                
                if 0 <= page_num < len(reader.pages):
                    page = reader.pages[page_num]
                    
                    if rotation != 0:
                        page.rotate(rotation)
                    
                    writer.add_page(page)
                    total_pages += 1
        
        if total_pages == 0:
            response(False, "Keine Seiten zum Speichern")
            return

        normalized_chapters = _normalize_chapters(chapters, total_pages)
        for chapter in normalized_chapters:
            _add_outline_item(writer, chapter['title'], chapter['page'] - 1)
        
        with open(output, "wb") as f:
            writer.write(f)
        
        response(True, "PDF erfolgreich erstellt", {
            "output": output,
            "pages": total_pages,
            "chapters": len(normalized_chapters)
        })
    except Exception as e:
        response(False, f"Fehler beim Erstellen: {str(e)}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        response(False, "Kein Befehl angegeben. Verfügbar: merge, split, remove, rotate, count")
        sys.exit(1)
    
    cmd = sys.argv[1]
    
    try:
        if cmd == "merge":
            # merge file1.pdf file2.pdf ... output.pdf
            if len(sys.argv) < 4:
                response(False, "Mindestens 2 Eingabedateien und 1 Ausgabedatei benötigt")
            else:
                merge_pdfs(sys.argv[2:-1], sys.argv[-1])
        
        elif cmd == "split":
            # split input.pdf start end output.pdf
            if len(sys.argv) < 6:
                response(False, "Benötigt: input.pdf start end output.pdf")
            else:
                split_pdf(sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), sys.argv[5])
        
        elif cmd == "remove":
            # remove input.pdf "1,3,5" output.pdf
            if len(sys.argv) < 5:
                response(False, "Benötigt: input.pdf pages output.pdf")
            else:
                pages = [int(p.strip()) for p in sys.argv[3].split(",")]
                remove_pages(sys.argv[2], pages, sys.argv[4])
        
        elif cmd == "rotate":
            # rotate input.pdf "1,2,3" 90 output.pdf
            if len(sys.argv) < 6:
                response(False, "Benötigt: input.pdf pages rotation output.pdf")
            else:
                pages = [int(p.strip()) for p in sys.argv[3].split(",")]
                rotate_pages(sys.argv[2], pages, int(sys.argv[4]), sys.argv[5])
        
        elif cmd == "count":
            # count input.pdf
            if len(sys.argv) < 3:
                response(False, "Benötigt: input.pdf")
            else:
                get_page_count(sys.argv[2])
        
        elif cmd == "build":
            # build operations_json output.pdf
            if len(sys.argv) < 4:
                response(False, "Benötigt: operations_json output.pdf")
            else:
                build_pdf(sys.argv[2], sys.argv[3])
        
        else:
            response(False, f"Unbekannter Befehl: {cmd}")
    
    except Exception as e:
        response(False, f"Fehler: {str(e)}")
