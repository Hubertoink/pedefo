// ============================================
// Pedefo - Professional PDF Editor
// Main Renderer Process
// ============================================

// Application State
const state = {
    currentFile: null,
    pages: [],
    selectedPages: new Set(),
    isDirty: false,
    thumbnailsGenerating: false,  // Lock to prevent parallel thumbnail generation
    splitPoints: []              // page indices where a split starts (between pages)
};

// ============================================
// Utility Functions
// ============================================

function showToast(message, type = 'info', action = null) {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    
    const icons = {
        success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
        error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
        info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>'
    };
    
    toast.innerHTML = `
        <span class="toast-icon">${icons[type]}</span>
        <span class="toast-message">${message}</span>
    `;

    if (action && action.label && typeof action.onClick === 'function') {
        const btn = document.createElement('button');
        btn.className = 'toast-action';
        btn.textContent = action.label;
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            action.onClick();
        });
        toast.appendChild(btn);
    }
    
    container.appendChild(toast);
    
    setTimeout(() => {
        toast.classList.add('fade-out');
        setTimeout(() => toast.remove(), 200);
    }, 4000);
}

function showLoading(text = 'Verarbeite...') {
    const loading = document.getElementById('loading');
    document.getElementById('loading-text').textContent = text;
    loading.style.display = 'flex';
}

function hideLoading() {
    document.getElementById('loading').style.display = 'none';
}

function getBaseName(filePath) {
    return filePath.split(/[\\/]/).pop();
}

// ============================================
// Screen Management
// ============================================

function showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(screenId).classList.add('active');
    
    const isEditor = screenId === 'screen-editor';
    const isReader = screenId === 'screen-reader';
    const showControls = isEditor || isReader;
    
    document.getElementById('toolbar').style.display = showControls ? 'flex' : 'none';
    document.getElementById('btn-save').style.display = showControls ? 'flex' : 'none';
    document.getElementById('btn-new').style.display = showControls ? 'block' : 'none';
    document.getElementById('status-bar').style.display = isEditor ? 'flex' : 'none';
}

// ============================================
// Modal Management
// ============================================

function showModal(modalId) {
    document.getElementById('modal-overlay').style.display = 'flex';
    document.querySelectorAll('.modal').forEach(m => m.style.display = 'none');
    document.getElementById(`modal-${modalId}`).style.display = 'block';
}

function hideModal() {
    document.getElementById('modal-overlay').style.display = 'none';
}

// Modal event listeners
document.querySelectorAll('.modal-close, [data-modal-cancel]').forEach(btn => {
    btn.addEventListener('click', hideModal);
});

document.getElementById('modal-overlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) hideModal();
});

// ============================================
// File Upload
// ============================================

function setupUploadZone() {
    const dropzone = document.getElementById('upload-dropzone');
    
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        dropzone.addEventListener(eventName, (e) => {
            e.preventDefault();
            e.stopPropagation();
        });
    });
    
    ['dragenter', 'dragover'].forEach(eventName => {
        dropzone.addEventListener(eventName, () => dropzone.classList.add('dragover'));
    });
    
    ['dragleave', 'drop'].forEach(eventName => {
        dropzone.addEventListener(eventName, () => dropzone.classList.remove('dragover'));
    });
    
    dropzone.addEventListener('drop', (e) => {
        const files = Array.from(e.dataTransfer.files).filter(f => f.name.toLowerCase().endsWith('.pdf'));
        if (files.length > 0) {
            loadPDF(files[0].path);
        } else {
            showToast('Bitte eine PDF-Datei auswählen', 'error');
        }
    });
    
    dropzone.addEventListener('click', async () => {
        const files = await window.pedefo.openFiles();
        if (files && files.length > 0) {
            loadPDF(files[0]);
        }
    });
}

// ============================================
// PDF Loading & Page Rendering
// ============================================

async function loadPDF(filePath) {
    showLoading('Lade PDF...');
    
    try {
        // Get page count
        const result = await window.pedefo.pdf.getPageCount(filePath);
        
        if (!result.success) {
            throw new Error(result.message);
        }
        
        const pageCount = result.data.pages;
        
        state.currentFile = filePath;
        state.pages = [];
        state.selectedPages.clear();
        state.isDirty = false;
        outlineCache = {};
        readerHighResThumbnails = {};
        gridThumbConfig = {};
        
        // Create page objects
        for (let i = 1; i <= pageCount; i++) {
            state.pages.push({
                id: `page-${i}-${Date.now()}`,
                number: i,
                originalNumber: i,
                sourceFile: filePath,
                rotation: 0,
                thumbnail: null
            });
        }
        
        // Update UI
        document.getElementById('current-file-name').textContent = getBaseName(filePath);
        updateStatusBar();
        renderPages();
        showScreen('screen-editor');
        
        // Generate thumbnails with Poppler
        generateThumbnailsWithPoppler(filePath);
        
        showToast(`${pageCount} Seiten geladen`, 'success');
        
    } catch (error) {
        showToast(error.message, 'error');
    } finally {
        hideLoading();
    }
}

// Thumbnail Progress Functions
// Thumbnail progress UI removed (thumbnails load on demand now)
function showThumbnailProgress(text = 'Lade Vorschau...', percent = 0) {
    return;
}

function updateThumbnailProgress(current, total) {
    return;
}

function hideThumbnailProgress() {
    return;
}

// Grid Lazy Loading Helpers
function attachGridScrollHandler() {
    if (gridScrollHandlerAttached) return;
    const container = document.getElementById('pages-container');
    if (!container) return;
    container.addEventListener('scroll', () => scheduleGridThumbnailLoad());
    gridScrollHandlerAttached = true;
}

function scheduleGridThumbnailLoad() {
    if (gridLoadScheduled) return;
    gridLoadScheduled = true;
    requestAnimationFrame(() => {
        gridLoadScheduled = false;
        loadVisibleThumbnails();
    });
}

function loadVisibleThumbnails() {
    const visiblePages = getVisiblePagesInGrid();
    let started = 0;
    for (const pageInfo of visiblePages) {
        if (started >= 6) break; // Limit parallele Loads
        const page = state.pages.find(p => p.id === pageInfo.id);
        if (!page) continue;
        if (page.thumbnail) continue;
        if (gridThumbLoading.has(page.id)) continue;
        const cfg = gridThumbConfig[page.sourceFile];
        if (!cfg) continue;
        gridThumbLoading.add(page.id);
        started++;
        loadGridThumbnail(page, cfg.dpi, cfg.total)
            .finally(() => gridThumbLoading.delete(page.id));
    }
}

function getVisiblePagesInGrid() {
    const container = document.getElementById('pages-container');
    if (!container) return [];
    const visiblePages = [];
    const buffer = 200; // px buffer
    document.querySelectorAll('.page-card').forEach(card => {
        const rect = card.getBoundingClientRect();
        const pageId = card.dataset.pageId;
        const isVisible = rect.bottom > -buffer && rect.top < window.innerHeight + buffer;
        if (isVisible && pageId) {
            const index = state.pages.findIndex(p => p.id === pageId);
            if (index !== -1) visiblePages.push({ id: pageId, index });
        }
    });
    // Sort by index to load in reading order
    visiblePages.sort((a, b) => a.index - b.index);
    return visiblePages;
}

async function generateThumbnailsWithPoppler(filePath) {
    // Verhindere parallele Thumbnail-Generierung
    if (state.thumbnailsGenerating) {
        return;
    }
    
    state.thumbnailsGenerating = true;
    
    try {
        // Zeige Fortschrittsbalken
        showThumbnailProgress('Lade Vorschau...', 0);
        
        // Ermittle DPI basierend auf Seitenzahl
        const pageCount = state.pages.filter(p => p.sourceFile === filePath).length;
        let dpi = 36;
        if (pageCount > 200) {
            dpi = 24;  // Sehr niedrige DPI für große Dokumente
        } else if (pageCount > 100) {
            dpi = 30;
        }
        const total = pageCount;
        gridThumbConfig[filePath] = { dpi, total };

        // Erst sichtbare Seiten laden
        scheduleGridThumbnailLoad();

        // Scroll-Handler einmalig anhängen
        attachGridScrollHandler();

        // Hintergrund-Lader als Fallback: alle 400ms einen Versuch
        const bgInterval = setInterval(() => {
            const remaining = state.pages.some(p => p.sourceFile === filePath && !p.thumbnail);
            if (!remaining) {
                clearInterval(bgInterval);
                hideThumbnailProgress();
                return;
            }
            scheduleGridThumbnailLoad();
        }, 400);
        
    } catch (error) {
        hideThumbnailProgress();
    } finally {
        state.thumbnailsGenerating = false;
    }
}

async function loadGridThumbnail(page, dpi, totalPages) {
    try {
        const result = await window.pedefo.pdf.generateSingleThumbnail(
            page.sourceFile, 
            page.originalNumber, 
            dpi
        );
        
        if (result.success && result.data) {
            page.thumbnail = result.data.data;
            
            // Update thumbnail in DOM sofort
            const pageEl = document.querySelector(`[data-page-id="${page.id}"] .page-thumbnail`);
            if (pageEl) {
                pageEl.innerHTML = `<img src="${result.data.data}" alt="Seite ${page.number}">`;
            }
            
            // Fortschritt aktualisieren
            const loadedCount = state.pages.filter(p => p.sourceFile === page.sourceFile && p.thumbnail).length;
            updateThumbnailProgress(loadedCount, totalPages);
        }
    } catch (error) {
        // stille Fehler – nicht spammen
    }
}

function getVisiblePagesInGrid() {
    const container = document.getElementById('pages-container');
    if (!container) return [];
    
    const containerRect = container.getBoundingClientRect();
    const visiblePages = [];
    
    document.querySelectorAll('.page-card').forEach(card => {
        const rect = card.getBoundingClientRect();
        const pageId = card.dataset.pageId;
        
        // Prüfe ob Seite im Viewport ist (mit etwas Buffer)
        const isVisible = rect.bottom > -200 && rect.top < window.innerHeight + 200;
        
        if (isVisible && pageId) {
            const index = state.pages.findIndex(p => p.id === pageId);
            if (index !== -1) {
                visiblePages.push({ id: pageId, index });
            }
        }
    });
    
    return visiblePages;
}

function renderPages() {
    const container = document.getElementById('pages-container');
    container.innerHTML = '';
    
    state.pages.forEach((page, index) => {
        // Insert zone before first page
        if (index === 0) {
            const insertZone = createInsertZone(0);
            container.appendChild(insertZone);
        }
        
        const pageCard = createPageCard(page, index);
        container.appendChild(pageCard);
        
        // Insert zone after each page
        const insertZone = createInsertZone(index + 1);
        container.appendChild(insertZone);
    });
    
    updateSelectionBar();
    updateSplitIndicators();
}

function createPageCard(page, index) {
    const card = document.createElement('div');
    card.className = 'page-card' + (state.selectedPages.has(page.id) ? ' selected' : '');
    card.dataset.pageId = page.id;
    card.draggable = true;
    
    const thumbnailContent = page.thumbnail 
        ? `<img src="${page.thumbnail}" alt="Seite ${index + 1}" style="transform: rotate(${page.rotation}deg)">`
        : index + 1;
    
    card.innerHTML = `
        <div class="page-thumbnail-wrapper">
            <div class="page-checkbox ${state.selectedPages.has(page.id) ? 'visible' : ''}">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                    <polyline points="20 6 9 17 4 12"/>
                </svg>
            </div>
            <div class="page-thumbnail">${thumbnailContent}</div>
            <div class="page-actions">
                <button class="page-action-btn" data-action="rotate-left" title="Links drehen">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M2.5 2v6h6"/>
                        <path d="M2.5 8C5.5 3 11 1.5 16 4s8 9 6 15"/>
                    </svg>
                </button>
                <button class="page-action-btn" data-action="rotate-right" title="Rechts drehen">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M21.5 2v6h-6"/>
                        <path d="M21.5 8C18.5 3 13 1.5 8 4S0 13 2 19"/>
                    </svg>
                </button>
                <button class="page-action-btn" data-action="duplicate" title="Duplizieren">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <rect x="9" y="9" width="13" height="13" rx="2"/>
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                    </svg>
                </button>
                <button class="page-action-btn danger" data-action="delete" title="Löschen">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="3 6 5 6 21 6"/>
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>
                    </svg>
                </button>
            </div>
        </div>
        <span class="page-number">${index + 1}</span>
    `;
    
    // Checkbox click toggles selection
    card.querySelector('.page-checkbox').addEventListener('click', (e) => {
        e.stopPropagation();
        togglePageSelection(page.id);
    });

    // Click to select (additive by default)
    card.addEventListener('click', (e) => {
        if (e.target.closest('.page-actions')) return;
        
        if (e.shiftKey && state.selectedPages.size > 0) {
            // Shift-click for range selection
            const lastSelected = Array.from(state.selectedPages).pop();
            const lastIndex = state.pages.findIndex(p => p.id === lastSelected);
            const currentIndex = index;
            const [start, end] = [Math.min(lastIndex, currentIndex), Math.max(lastIndex, currentIndex)];
            
            for (let i = start; i <= end; i++) {
                state.selectedPages.add(state.pages[i].id);
            }
            updatePageSelectionUI();
            updateSelectionBar();
        } else {
            // Additive toggle (kein Ctrl nötig)
            togglePageSelection(page.id);
        }
    });
    
    // Page action buttons
    card.querySelectorAll('.page-action-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const action = btn.dataset.action;
            handlePageAction(action, page.id);
        });
    });
    
    // Drag & Drop
    setupPageDragDrop(card, page.id);
    
    return card;
}

function createInsertZone(insertIndex) {
    const zone = document.createElement('div');
    zone.className = 'insert-zone';
    zone.dataset.insertIndex = insertIndex;
    
    zone.innerHTML = `
        <div class="insert-drop-indicator"></div>
        <div class="insert-actions">
            <button class="insert-btn" title="PDF hier einfügen">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="12" y1="5" x2="12" y2="19"/>
                    <line x1="5" y1="12" x2="19" y2="12"/>
                </svg>
            </button>
            <button class="insert-split-btn" title="PDF hier trennen">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="6" cy="6" r="1"/>
                    <circle cx="6" cy="18" r="1"/>
                    <path d="M20 4L8.5 15.5"/>
                    <path d="M4 4l16 16"/>
                </svg>
            </button>
        </div>
    `;
    
    zone.querySelector('.insert-btn').addEventListener('click', () => {
        insertPDFAt(insertIndex);
    });
    
    zone.querySelector('.insert-split-btn').addEventListener('click', () => {
        toggleSplitPoint(insertIndex);
    });
    
    // Drag & Drop für Seiten-Neuordnung
    setupInsertZoneDragDrop(zone, insertIndex);
    
    return zone;
}

// ============================================
// Page Selection
// ============================================

function togglePageSelection(pageId) {
    if (state.selectedPages.has(pageId)) {
        state.selectedPages.delete(pageId);
    } else {
        state.selectedPages.add(pageId);
    }
    updatePageSelectionUI();
    updateSelectionBar();
}

function toggleSplitPoint(idx) {
    if (idx <= 0 || idx >= state.pages.length) return;
    const set = new Set(getSplitPointsSorted());
    if (set.has(idx)) {
        set.delete(idx);
    } else {
        set.add(idx);
    }
    state.splitPoints = Array.from(set);
    updateSplitIndicators();
}

function clampSplitPoints() {
    state.splitPoints = getSplitPointsSorted().filter(p => p < state.pages.length);
}

function updatePageSelectionUI() {
    document.querySelectorAll('.page-card').forEach(card => {
        const pageId = card.dataset.pageId;
        const isSelected = state.selectedPages.has(pageId);
        card.classList.toggle('selected', isSelected);
        
        // Update checkbox visibility
        const checkbox = card.querySelector('.page-checkbox');
        if (checkbox) {
            checkbox.classList.toggle('visible', isSelected);
        }
    });
}

function getSplitPointsSorted() {
    return Array.from(new Set(state.splitPoints))
        .filter(p => p > 0 && p < state.pages.length)
        .sort((a, b) => a - b);
}

function computeSplitParts() {
    const points = getSplitPointsSorted();
    const parts = [];
    let start = 0;
    points.forEach(p => {
        parts.push({ start, end: p });
        start = p;
    });
    parts.push({ start, end: state.pages.length });
    return parts;
}

function updateSplitIndicators() {
    const points = new Set(getSplitPointsSorted());
    document.querySelectorAll('.insert-zone').forEach(zone => {
        const idx = parseInt(zone.dataset.insertIndex, 10);
        const active = points.has(idx);
        zone.classList.toggle('split-active', active);
    });
    renderSplitPanel();
}

function pagesToOperations(pages) {
    const ops = [];
    let current = null;
    pages.forEach(p => {
        if (!current || current.sourceFile !== p.sourceFile) {
            current = { sourceFile: p.sourceFile, pages: [] };
            ops.push(current);
        }
        current.pages.push({ originalNumber: p.originalNumber, rotation: p.rotation });
    });
    return ops;
}

function getFileBaseName(path) {
    if (!path) return 'dokument';
    const base = getBaseName(path);
    return base.replace(/\.[^.]+$/, '') || 'dokument';
}

function sanitizeFilename(name) {
    return (name || 'datei')
        .toString()
        .trim()
        .replace(/[^a-zA-Z0-9-_]+/g, '_')
        .replace(/^_+|_+$/g, '') || 'datei';
}

function updateSelectionBar() {
    const bar = document.getElementById('selection-bar');
    const count = state.selectedPages.size;
    const fullscreenBtn = document.getElementById('btn-fullscreen-view');
    
    if (count > 0) {
        bar.style.display = 'flex';
        document.getElementById('selection-count').textContent = 
            count === 1 ? '1 Seite ausgewählt' : `${count} Seiten ausgewählt`;
        
        // Show fullscreen button
        if (fullscreenBtn) {
            fullscreenBtn.style.display = 'flex';
        }
    } else {
        bar.style.display = 'none';
        
        // Hide fullscreen button
        if (fullscreenBtn) {
            fullscreenBtn.style.display = 'none';
        }
    }
}

function renderSplitPanel() {
    const panel = document.getElementById('split-panel');
    if (!panel) return;

    const parts = computeSplitParts();
    const baseName = sanitizeFilename(getFileBaseName(state.currentFile));

    if (parts.length === 1) {
        panel.style.display = 'none';
        panel.innerHTML = '';
        return;
    }

    panel.style.display = 'flex';
    const list = parts.map((p, idx) => {
        const from = p.start + 1;
        const to = p.end;
        return `
            <div class="split-row">
                <div class="split-info">Teil ${idx + 1}: S. ${from}–${to}</div>
                <div class="split-actions">
                    ${idx < parts.length - 1 ? `<button class="split-remove" data-remove="${p.end}">✕</button>` : ''}
                    <button class="split-export" data-part="${idx}">Export</button>
                </div>
            </div>
        `;
    }).join('');

    panel.innerHTML = list;

    panel.querySelectorAll('.split-remove').forEach(btn => {
        btn.addEventListener('click', () => {
            const val = parseInt(btn.dataset.remove, 10);
            state.splitPoints = getSplitPointsSorted().filter(p => p !== val);
            updateSplitIndicators();
        });
    });

    panel.querySelectorAll('.split-export').forEach(btn => {
        btn.addEventListener('click', async () => {
            const idx = parseInt(btn.dataset.part, 10);
            const partsNow = computeSplitParts();
            const part = partsNow[idx];
            if (!part) return;
            await exportSplitPart(part, idx + 1, baseName);
        });
    });
}

async function exportSplitPart(part, number, baseName) {
    const pages = state.pages.slice(part.start, part.end);
    if (pages.length === 0) {
        showToast('Teil ist leer', 'error');
        return;
    }

    const ops = pagesToOperations(pages);
    const defaultName = `${baseName}_Teil${number}.pdf`;
    const output = await window.pedefo.saveFile(defaultName);
    if (!output) return;

    showLoading('Teil wird exportiert...');
    try {
        const res = await window.pedefo.pdf.buildPDF(ops, output);
        if (res.success) {
            showToast('Teil exportiert', 'success');
        } else {
            throw new Error(res.message || 'Fehler beim Export');
        }
    } catch (error) {
        showToast(error.message, 'error');
    } finally {
        hideLoading();
    }
}

function updateStatusBar() {
    document.getElementById('status-pages').textContent = `${state.pages.length} Seiten`;
}

// ============================================
// Page Actions
// ============================================

function handlePageAction(action, pageId) {
    const pageIds = state.selectedPages.has(pageId) 
        ? Array.from(state.selectedPages) 
        : [pageId];
    
    switch (action) {
        case 'rotate-left':
            rotatePagesBy(pageIds, -90);
            break;
        case 'rotate-right':
            rotatePagesBy(pageIds, 90);
            break;
        case 'duplicate':
            duplicatePages(pageIds);
            break;
        case 'delete':
            deletePages(pageIds);
            break;
    }
}

function rotatePagesBy(pageIds, degrees) {
    pageIds.forEach(id => {
        const page = state.pages.find(p => p.id === id);
        if (page) {
            page.rotation = (page.rotation + degrees + 360) % 360;
            
            // Update thumbnail rotation
            const img = document.querySelector(`[data-page-id="${id}"] .page-thumbnail img`);
            if (img) {
                img.style.transform = `rotate(${page.rotation}deg)`;
            }
        }
    });
    state.isDirty = true;
    showToast(`${pageIds.length} Seite(n) rotiert`, 'success');
}

function duplicatePages(pageIds) {
    const newPages = [];
    
    pageIds.forEach(id => {
        const pageIndex = state.pages.findIndex(p => p.id === id);
        const page = state.pages[pageIndex];
        
        if (page) {
            const newPage = {
                ...page,
                id: `page-dup-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
            };
            newPages.push({ index: pageIndex + 1, page: newPage });
        }
    });
    
    // Insert duplicates after originals (reverse order to maintain correct positions)
    newPages.reverse().forEach(({ index, page }) => {
        state.pages.splice(index, 0, page);
    });
    clampSplitPoints();
    
    state.isDirty = true;
    renderPages();
    updateStatusBar();
    showToast(`${pageIds.length} Seite(n) dupliziert`, 'success');
}

function deletePages(pageIds) {
    if (state.pages.length <= pageIds.length) {
        showToast('Mindestens eine Seite muss bleiben', 'error');
        return;
    }
    
    state.pages = state.pages.filter(p => !pageIds.includes(p.id));
    clampSplitPoints();
    pageIds.forEach(id => state.selectedPages.delete(id));
    
    state.isDirty = true;
    renderPages();
    updateStatusBar();
    updateSelectionBar();
    showToast(`${pageIds.length} Seite(n) gelöscht`, 'success');
}

// ============================================
// Drag & Drop Reordering
// ============================================

let draggedPageId = null;

function setupPageDragDrop(card, pageId) {
    card.addEventListener('dragstart', (e) => {
        draggedPageId = pageId;
        e.dataTransfer.setData('text/plain', pageId);
        e.dataTransfer.effectAllowed = 'move';
        
        // Verzögert die Klasse hinzufügen für bessere visuelle Darstellung
        setTimeout(() => {
            card.classList.add('dragging');
            // Alle Insert-Zonen während des Drags hervorheben
            document.querySelectorAll('.insert-zone').forEach(zone => {
                zone.classList.add('drag-active');
            });
        }, 0);
    });
    
    card.addEventListener('dragend', () => {
        draggedPageId = null;
        card.classList.remove('dragging');
        // Alle Hervorhebungen entfernen
        document.querySelectorAll('.insert-zone').forEach(zone => {
            zone.classList.remove('drag-active', 'drag-over');
        });
    });
}

function setupInsertZoneDragDrop(zone, insertIndex) {
    zone.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        zone.classList.add('drag-over');
    });
    
    zone.addEventListener('dragleave', (e) => {
        // Nur entfernen wenn wir wirklich die Zone verlassen
        if (!zone.contains(e.relatedTarget)) {
            zone.classList.remove('drag-over');
        }
    });
    
    zone.addEventListener('drop', (e) => {
        e.preventDefault();
        zone.classList.remove('drag-over');
        
        const draggedId = e.dataTransfer.getData('text/plain');
        
        if (draggedId) {
            const draggedIndex = state.pages.findIndex(p => p.id === draggedId);
            
            if (draggedIndex !== -1) {
                // Berechne die tatsächliche Zielposition
                let targetIndex = insertIndex;
                
                // Wenn wir nach der aktuellen Position einfügen, müssen wir die Position anpassen
                if (draggedIndex < targetIndex) {
                    targetIndex--;
                }
                
                // Nur verschieben wenn es eine tatsächliche Änderung gibt
                if (draggedIndex !== targetIndex) {
                    const [removed] = state.pages.splice(draggedIndex, 1);
                    state.pages.splice(targetIndex, 0, removed);
                    clampSplitPoints();
                    
                    state.isDirty = true;
                    renderPages();
                    showToast('Seite verschoben', 'info');
                }
            }
        }
        
        // Alle Hervorhebungen entfernen
        document.querySelectorAll('.insert-zone').forEach(z => {
            z.classList.remove('drag-active', 'drag-over');
        });
    });
}

// ============================================
// Insert PDF
// ============================================

async function insertPDFAt(insertIndex) {
    const files = await window.pedefo.openFiles();
    if (!files || files.length === 0) return;
    
    showLoading('Füge PDF ein...');
    
    try {
        const filePath = files[0];
        const result = await window.pedefo.pdf.getPageCount(filePath);
        
        if (!result.success) {
            throw new Error(result.message);
        }
        
        const pageCount = result.data.pages;
        const newPages = [];
        
        for (let i = 1; i <= pageCount; i++) {
            newPages.push({
                id: `page-insert-${Date.now()}-${i}`,
                number: i,
                originalNumber: i,
                sourceFile: filePath,
                rotation: 0,
                thumbnail: null
            });
        }
        
        state.pages.splice(insertIndex, 0, ...newPages);
        clampSplitPoints();
        state.isDirty = true;
        
        renderPages();
        updateStatusBar();
        hideLoading();
        
        // Generate thumbnails for new pages mit Fortschrittsbalken
        await generateThumbnailsForPages(filePath, insertIndex, pageCount);
        
        showToast(`${pageCount} Seiten eingefügt`, 'success');
        
    } catch (error) {
        showToast(error.message, 'error');
        hideLoading();
    }
}

async function generateThumbnailsForPages(filePath, startIndex, count) {
    // Warte falls bereits eine Generierung läuft
    while (state.thumbnailsGenerating) {
        await new Promise(r => setTimeout(r, 100));
    }
    
    state.thumbnailsGenerating = true;
    
    try {
        console.log('Generiere Thumbnails für eingefügte Seiten...');
        
        // Fortschrittsbalken anzeigen
        showThumbnailProgress('Lade Vorschau...', 0);
        
        // Nutze Python-Script mit Poppler
        const result = await window.pedefo.pdf.generateThumbnails(filePath);
        
        if (!result.success) {
            console.log('Thumbnail-Generierung fehlgeschlagen:', result.message);
            hideThumbnailProgress();
            return;
        }
        
        // Thumbnails zuweisen (ab startIndex) mit Fortschrittsanzeige
        result.data.thumbnails.forEach((thumb, i) => {
            const pageIndex = startIndex + i;
            if (state.pages[pageIndex]) {
                state.pages[pageIndex].thumbnail = thumb.data;
                
                // Fortschritt aktualisieren
                updateThumbnailProgress(i + 1, count);
                
                const pageEl = document.querySelector(`[data-page-id="${state.pages[pageIndex].id}"] .page-thumbnail`);
                if (pageEl) {
                    pageEl.innerHTML = `<img src="${thumb.data}" alt="Seite ${pageIndex + 1}">`;
                }
            }
        });
        
        // Fortschrittsbalken ausblenden
        setTimeout(hideThumbnailProgress, 300);
    } catch (error) {
        console.log('Thumbnail generation failed:', error);
        hideThumbnailProgress();
    } finally {
        state.thumbnailsGenerating = false;
    }
}

// ============================================
// Save PDF
// ============================================

async function savePDF() {
    const outputPath = await window.pedefo.saveFile('bearbeitet.pdf');
    if (!outputPath) return false;
    
    showLoading('Speichere PDF...');
    
    try {
        // Group pages by source file
        const operations = [];
        let currentGroup = null;
        
        state.pages.forEach((page, index) => {
            if (!currentGroup || currentGroup.sourceFile !== page.sourceFile) {
                currentGroup = {
                    sourceFile: page.sourceFile,
                    pages: []
                };
                operations.push(currentGroup);
            }
            currentGroup.pages.push({
                originalNumber: page.originalNumber,
                rotation: page.rotation
            });
        });
        
        // Build the PDF using Python
        const result = await window.pedefo.pdf.buildPDF(operations, outputPath);
        
        if (result.success) {
            state.isDirty = false;
            showToast('PDF erfolgreich gespeichert', 'success');
            return true;
        } else {
            throw new Error(result.message);
        }
        
    } catch (error) {
        showToast(error.message, 'error');
        return false;
    } finally {
        hideLoading();
    }
}

// ============================================
// Extract Pages
// ============================================

function openExtractModal() {
    const startInput = document.getElementById('extract-start');
    const endInput = document.getElementById('extract-end');
    
    startInput.max = state.pages.length;
    endInput.max = state.pages.length;
    startInput.value = 1;
    endInput.value = state.pages.length;
    
    showModal('extract');
}

async function extractPages() {
    const start = parseInt(document.getElementById('extract-start').value);
    const end = parseInt(document.getElementById('extract-end').value);
    
    if (start > end || start < 1 || end > state.pages.length) {
        showToast('Ungültiger Seitenbereich', 'error');
        return;
    }
    
    hideModal();
    
    const outputPath = await window.pedefo.saveFile('auszug.pdf');
    if (!outputPath) return;
    
    showLoading('Extrahiere Seiten...');
    
    try {
        // Get the pages to extract with their source files
        const pagesToExtract = state.pages.slice(start - 1, end);
        
        const operations = [];
        let currentGroup = null;
        
        pagesToExtract.forEach(page => {
            if (!currentGroup || currentGroup.sourceFile !== page.sourceFile) {
                currentGroup = {
                    sourceFile: page.sourceFile,
                    pages: []
                };
                operations.push(currentGroup);
            }
            currentGroup.pages.push({
                originalNumber: page.originalNumber,
                rotation: page.rotation
            });
        });
        
        const result = await window.pedefo.pdf.buildPDF(operations, outputPath);
        
        if (result.success) {
            showToast(`${end - start + 1} Seiten extrahiert`, 'success');
        } else {
            throw new Error(result.message);
        }
        
    } catch (error) {
        showToast(error.message, 'error');
    } finally {
        hideLoading();
    }
}

// ============================================
// Compress PDF
// ============================================

function openCompressModal() {
    showModal('compress');
}

async function compressPDF() {
    const quality = document.querySelector('input[name="compress-quality"]:checked').value;
    
    hideModal();
    
    const outputPath = await window.pedefo.saveFile('komprimiert.pdf');
    if (!outputPath) return;
    
    showLoading('Komprimiere PDF...');
    
    try {
        // First save current state, then compress
        const tempPath = outputPath.replace('.pdf', '_temp.pdf');
        
        // Build current document
        const operations = [];
        let currentGroup = null;
        
        state.pages.forEach(page => {
            if (!currentGroup || currentGroup.sourceFile !== page.sourceFile) {
                currentGroup = {
                    sourceFile: page.sourceFile,
                    pages: []
                };
                operations.push(currentGroup);
            }
            currentGroup.pages.push({
                originalNumber: page.originalNumber,
                rotation: page.rotation
            });
        });
        
        // If only one source file and no modifications, compress directly
        const sourceFile = state.pages.length > 0 && 
            state.pages.every(p => p.sourceFile === state.pages[0].sourceFile && p.rotation === 0)
            ? state.pages[0].sourceFile
            : null;
        
        let result;
        if (sourceFile && !state.isDirty) {
            result = await window.pedefo.pdf.compress(sourceFile, outputPath, quality);
        } else {
            // Build temp file first, then compress
            await window.pedefo.pdf.buildPDF(operations, tempPath);
            result = await window.pedefo.pdf.compress(tempPath, outputPath, quality);
        }
        
        if (result.success) {
            const reduction = result.data?.reduction_percent || 0;
            showToast(`PDF komprimiert (${reduction}% kleiner)`, 'success');
        } else {
            throw new Error(result.message);
        }
        
    } catch (error) {
        showToast(error.message, 'error');
    } finally {
        hideLoading();
    }
}

// ============================================
// New File
// ============================================

function newFile() {
    if (state.isDirty) {
        if (!confirm('Änderungen verwerfen und neue Datei öffnen?')) {
            return;
        }
    }
    
    // Close page viewer if open
    if (document.getElementById('page-viewer').style.display === 'flex') {
        closePageViewer();
    }
    
    state.currentFile = null;
    state.pages = [];
    state.selectedPages.clear();
    state.isDirty = false;
    
    document.getElementById('current-file-name').textContent = '';
    document.getElementById('pages-container').innerHTML = '';
    
    showScreen('screen-upload');
}

// ============================================
// Reader View
// ============================================

let readerCurrentPage = 0;
let readerHighResThumbnails = {};  // Cache: { sourceFile: { originalNumber: thumbnailData } }
let gridThumbConfig = {};          // Cache DPI/total per sourceFile for grid
let gridThumbLoading = new Set();  // currently loading page ids
let gridLoadScheduled = false;
let gridScrollHandlerAttached = false;
let readerThumbLoading = new Set(); // currently loading reader thumbs
let readerThumbLoadScheduled = false;
let readerThumbScrollAttached = false;
let outlineCache = {};             // Cache: { sourceFile: outline[] }

async function openReaderView(startPageIndex = 0) {
    readerCurrentPage = startPageIndex;
    
    // Thumbnails für die Sidebar rendern
    renderReaderThumbnails();
    
    // Aktuelle Seite SOFORT mit Low-Res anzeigen
    showReaderPage(readerCurrentPage);
    
    // Screen wechseln (keine Verzögerung mehr!)
    showScreen('screen-reader');

    // Inhaltsverzeichnis laden (asynchron)
    loadOutlineForSources();

    // Reader-Thumbnails schrittweise laden
    attachReaderThumbScrollHandler();
    scheduleReaderThumbLoad();
    
    // Button-Zustand aktualisieren
    document.getElementById('btn-read-view').classList.add('active');
    document.getElementById('btn-grid-view').classList.remove('active');
    
    // High-Res nur für aktuelle Seite laden, Rest on-demand
    loadPriorityThumbnails(readerCurrentPage);
}

function closeReaderView() {
    showScreen('screen-editor');
    document.getElementById('view-toggle').style.display = 'flex';
    // Button-Zustand zurücksetzen
    document.getElementById('btn-grid-view').classList.add('active');
    document.getElementById('btn-read-view').classList.remove('active');
    // Grid neu rendern um Änderungen aus der Leseansicht zu übernehmen
    renderPages();
    updateStatusBar();
}

function renderReaderThumbnails() {
    const container = document.getElementById('reader-thumbnails');
    container.innerHTML = '';
    
    state.pages.forEach((page, index) => {
        // Insert zone before first page
        if (index === 0) {
            container.appendChild(createReaderInsertZone(0));
        }
        
        const thumb = document.createElement('div');
        thumb.className = 'reader-thumb' + (index === readerCurrentPage ? ' active' : '');
        thumb.dataset.index = index;
        const img = document.createElement('img');
        img.alt = `Seite ${index + 1}`;
        img.style.transform = `rotate(${page.rotation}deg)`;
        img.style.background = '#f0f0f0';
        img.style.width = '100%';
        img.style.display = 'block';
        img.src = page.thumbnail || '';
        thumb.appendChild(img);

        const num = document.createElement('span');
        num.className = 'reader-thumb-number';
        num.textContent = index + 1;
        thumb.appendChild(num);
        
        thumb.addEventListener('click', () => {
            showReaderPage(index);
        });
        
        container.appendChild(thumb);
        
        // Insert zone after each page
        container.appendChild(createReaderInsertZone(index + 1));
    });

    // Outline-Panel mit aktueller Reihenfolge synchronisieren
    renderOutlinePanel();

    // Reader-Thumb Lazy-Loading anstoßen
    attachReaderThumbScrollHandler();
    scheduleReaderThumbLoad();
}

function getThumbDpiForSource(sourceFile) {
    const cfg = gridThumbConfig[sourceFile];
    if (cfg && cfg.dpi) return cfg.dpi;
    const total = state.pages.filter(p => p.sourceFile === sourceFile).length;
    if (total > 200) return 24;
    if (total > 100) return 30;
    return 36;
}

function attachReaderThumbScrollHandler() {
    if (readerThumbScrollAttached) return;
    const container = document.getElementById('reader-thumbnails');
    if (!container) return;
    container.addEventListener('scroll', () => scheduleReaderThumbLoad());
    readerThumbScrollAttached = true;
}

function scheduleReaderThumbLoad() {
    if (readerThumbLoadScheduled) return;
    readerThumbLoadScheduled = true;
    requestAnimationFrame(() => {
        readerThumbLoadScheduled = false;
        loadVisibleReaderThumbs();
    });
}

function getVisibleReaderThumbs() {
    const container = document.getElementById('reader-thumbnails');
    if (!container) return [];
    const containerRect = container.getBoundingClientRect();
    const buffer = 600; // Größerer Buffer für besseres Preloading
    const items = [];
    document.querySelectorAll('.reader-thumb').forEach((el) => {
        const rect = el.getBoundingClientRect();
        const isVisible = rect.bottom > containerRect.top - buffer && rect.top < containerRect.bottom + buffer;
        if (!isVisible) return;
        const index = parseInt(el.dataset.index, 10);
        if (!Number.isNaN(index)) items.push(index);
    });
    return items.sort((a, b) => a - b);
}

async function loadVisibleReaderThumbs() {
    const visible = getVisibleReaderThumbs();
    if (visible.length === 0) return;
    let started = 0;
    for (const idx of visible) {
        if (started >= 8) break; // Erhöhte Parallelität für schnelleres Laden
        const page = state.pages[idx];
        if (!page) continue;
        if (readerThumbLoading.has(page.id)) continue;
        
        // Prüfe ob Sidebar-Thumbnail bereits geladen ist
        const thumbWrapper = document.querySelector(`.reader-thumb[data-index="${idx}"]`);
        const imgEl = thumbWrapper?.querySelector('img');
        if (imgEl && imgEl.src && imgEl.src.startsWith('data:')) continue;
        
        const dpi = getThumbDpiForSource(page.sourceFile);
        readerThumbLoading.add(page.id);
        started++;
        loadReaderThumbnail(page, dpi)
            .finally(() => readerThumbLoading.delete(page.id));
    }
}

async function loadReaderThumbnail(page, dpi) {
    try {
        const result = await window.pedefo.pdf.generateSingleThumbnail(
            page.sourceFile,
            page.originalNumber,
            dpi
        );

        if (result.success && result.data) {
            // Sidebar Thumbnail aktualisieren
            const idx = state.pages.indexOf(page);
            const thumbWrapper = document.querySelector(`.reader-thumb[data-index="${idx}"]`);
            if (thumbWrapper) {
                let imgEl = thumbWrapper.querySelector('img');
                if (!imgEl) {
                    imgEl = document.createElement('img');
                    thumbWrapper.innerHTML = '';
                    thumbWrapper.appendChild(imgEl);
                    const numberBadge = document.createElement('span');
                    numberBadge.className = 'reader-thumb-number';
                    numberBadge.textContent = `${idx + 1}`;
                    thumbWrapper.appendChild(numberBadge);
                }
                imgEl.src = result.data.data;
                imgEl.style.transform = `rotate(${page.rotation}deg)`;
                imgEl.alt = `Seite ${idx + 1}`;
            }
        } else {
            console.warn(`Failed to load reader thumbnail for page ${page.originalNumber}: ${result.message}`);
        }
    } catch (error) {
        console.error(`Error loading reader thumbnail for page ${page.originalNumber}:`, error);
    }
}

function findPageIndexForOutline(sourceFile, pageNumber) {
    if (pageNumber === null || pageNumber === undefined) return -1;
    const pageNum = parseInt(pageNumber, 10);
    if (Number.isNaN(pageNum)) return -1;
    return state.pages.findIndex(p => p.sourceFile === sourceFile && p.originalNumber === pageNum);
}

function getMaxPageForSource(sourceFile) {
    const pages = state.pages.filter(p => p.sourceFile === sourceFile).map(p => p.originalNumber);
    if (pages.length === 0) return 0;
    return Math.max(...pages);
}

function parseOutlinePageNumber(page) {
    const num = parseInt(page, 10);
    return Number.isNaN(num) ? null : num;
}

// Berechnet für jedes Outline-Element den Start- und Endbereich (bis zum nächsten Eintrag auf gleicher Ebene)
function computeOutlineRanges(entries, maxPage) {
    const ranges = new Map();
    const flat = [];

    const walk = (nodes, depth) => {
        nodes.forEach((entry) => {
            flat.push({ entry, page: parseOutlinePageNumber(entry.page), depth });
            if (entry.children && entry.children.length > 0) {
                walk(entry.children, depth + 1);
            }
        });
    };

    walk(entries, 0);

    const itemsWithPage = flat.filter(n => n.page !== null);

    for (let i = 0; i < itemsWithPage.length; i++) {
        const current = itemsWithPage[i];
        let end = maxPage || current.page;

        for (let j = i + 1; j < itemsWithPage.length; j++) {
            const next = itemsWithPage[j];
            if (next.page === null) continue;
            if (next.depth <= current.depth && next.page > current.page) {
                end = next.page - 1;
                break;
            }
        }

        if (current.page !== null) {
            ranges.set(current.entry, {
                start: current.page,
                end: Math.max(current.page, end)
            });
        }
    }

    return ranges;
}

async function loadOutlineForSources(forceRefresh = false) {
    const files = Array.from(new Set(state.pages.map(p => p.sourceFile)));

    if (forceRefresh) {
        outlineCache = {};
    }

    const fetches = files.map(async (filePath) => {
        if (!forceRefresh && outlineCache[filePath] !== undefined) return;
        try {
            const result = await window.pedefo.pdf.getOutline(filePath);
            const outline = result && result.data && Array.isArray(result.data.outline) ? result.data.outline : [];
            outlineCache[filePath] = outline;
        } catch (error) {
            outlineCache[filePath] = [];
        }
    });

    await Promise.all(fetches);
    renderOutlinePanel();
}

function renderOutlinePanel() {
    const body = document.getElementById('reader-outline-body');
    if (!body) return;

    body.innerHTML = '';
    const placeholder = document.createElement('div');
    placeholder.className = 'reader-outline-empty';
    placeholder.textContent = 'Kein Inhaltsverzeichnis gefunden';

    const files = Array.from(new Set(state.pages.map(p => p.sourceFile)));
    const multipleSources = files.length > 1;
    let hasEntries = false;

    files.forEach((filePath) => {
        const outline = outlineCache[filePath];
        if (!outline || outline.length === 0) return;
        hasEntries = true;

        if (multipleSources) {
            const sourceLabel = document.createElement('div');
            sourceLabel.className = 'reader-outline-source';
            sourceLabel.textContent = getBaseName(filePath);
            body.appendChild(sourceLabel);
        }

        const maxPage = getMaxPageForSource(filePath);
        const rangeMap = computeOutlineRanges(outline, maxPage);
        appendOutlineItems(outline, filePath, body, 0, rangeMap);
    });

    if (!hasEntries) {
        body.appendChild(placeholder);
    } else {
        highlightOutlineForPage(readerCurrentPage);
    }
}

function appendOutlineItems(entries, sourceFile, container, depth, rangeMap) {
    entries.forEach((entry) => {
        const item = document.createElement('div');
        item.className = 'outline-item';
        item.style.paddingLeft = `${12 + depth * 14}px`;
        item.dataset.sourceFile = sourceFile;

        const range = rangeMap.get(entry) || null;
        const startPage = range ? range.start : parseOutlinePageNumber(entry.page);
        const endPage = range ? range.end : startPage;

        const titleSpan = document.createElement('span');
        titleSpan.className = 'outline-title';
        titleSpan.textContent = entry.title || 'Ohne Titel';

        const pageSpan = document.createElement('span');
        pageSpan.className = 'outline-page';
        if (startPage !== null) {
            const rangeText = endPage !== null && endPage !== startPage
                ? `S. ${startPage}-${endPage}`
                : `S. ${startPage}`;
            pageSpan.textContent = rangeText;
            item.dataset.rangeStart = startPage;
            item.dataset.rangeEnd = endPage;
        } else {
            pageSpan.textContent = '';
        }

        const targetIndex = findPageIndexForOutline(sourceFile, startPage);
        if (targetIndex === -1) {
            item.classList.add('disabled');
        } else {
            item.dataset.targetIndex = targetIndex;
            item.addEventListener('click', () => showReaderPage(targetIndex));
        }

        item.appendChild(titleSpan);
        item.appendChild(pageSpan);
        container.appendChild(item);

        if (entry.children && entry.children.length > 0) {
            appendOutlineItems(entry.children, sourceFile, container, depth + 1, rangeMap);
        }
    });
}

function highlightOutlineForPage(pageIndex) {
    const page = state.pages[pageIndex];
    if (!page) return;

    let activeItem = null;
    document.querySelectorAll('.outline-item').forEach((item) => {
        const sourceMatches = item.dataset.sourceFile === page.sourceFile;
        const start = parseInt(item.dataset.rangeStart, 10);
        const end = parseInt(item.dataset.rangeEnd, 10);
        const inRange = sourceMatches && !Number.isNaN(start) && !Number.isNaN(end) &&
            page.originalNumber >= start && page.originalNumber <= end;

        item.classList.toggle('active', inRange);
        if (inRange) activeItem = item;
    });

    if (!activeItem) {
        // Fallback: exakter Seitenstart falls kein Bereich gesetzt wurde
        document.querySelectorAll('.outline-item').forEach((item) => {
            const idx = parseInt(item.dataset.targetIndex, 10);
            const isActive = Number.isInteger(idx) && idx === pageIndex;
            item.classList.toggle('active', isActive);
            if (isActive) activeItem = item;
        });
    }

    if (activeItem) {
        activeItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
}

function createReaderInsertZone(insertIndex) {
    const zone = document.createElement('div');
    zone.className = 'reader-insert-zone';
    zone.dataset.insertIndex = insertIndex;
    zone.innerHTML = `
        <div class="reader-insert-line"></div>
        <button class="reader-insert-btn" title="PDF hier einfügen">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="12" y1="5" x2="12" y2="19"/>
                <line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
        </button>
    `;
    
    zone.querySelector('.reader-insert-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        insertPDFInReaderAt(insertIndex);
    });
    
    return zone;
}

async function loadSingleHighResThumbnail(page) {
    // Prüfe ob bereits im Cache
    const cache = readerHighResThumbnails[page.sourceFile];
    if (cache && cache[page.originalNumber]) return;
    
    // Ermittle DPI basierend auf Gesamtseitenzahl der Quelle
    let dpi = 100;
    const pagesFromSameSource = state.pages.filter(p => p.sourceFile === page.sourceFile);
    // Bei vielen Seiten niedrigere DPI verwenden
    const maxOriginalPage = Math.max(...pagesFromSameSource.map(p => p.originalNumber));
    if (maxOriginalPage > 200) {
        dpi = 72;  // Niedrigere DPI für große Dokumente
    } else if (maxOriginalPage > 100) {
        dpi = 85;
    }
    
    try {
        const result = await window.pedefo.pdf.generateSingleThumbnail(
            page.sourceFile, 
            page.originalNumber, 
            dpi
        );
        
        if (result.success && result.data) {
            // Cache initialisieren wenn nötig
            if (!readerHighResThumbnails[page.sourceFile]) {
                readerHighResThumbnails[page.sourceFile] = {};
            }
            readerHighResThumbnails[page.sourceFile][page.originalNumber] = result.data.data;
            
            // Aktualisiere Anzeige wenn diese Seite gerade angezeigt wird
            const currentPage = state.pages[readerCurrentPage];
            if (currentPage && 
                currentPage.sourceFile === page.sourceFile && 
                currentPage.originalNumber === page.originalNumber) {
                showReaderPage(readerCurrentPage);
            }
        } else {
            console.warn(`Failed to load high-res for page ${page.originalNumber}: ${result.message}`);
        }
    } catch (error) {
        console.error(`Error loading high-res for page ${page.originalNumber}:`, error);
    }
}

function showReaderLoading(show) {
    const loading = document.getElementById('reader-loading');
    const img = document.getElementById('reader-page-image');
    
    if (show) {
        loading.classList.add('visible');
        img.classList.add('loading');
    } else {
        loading.classList.remove('visible');
        img.classList.remove('loading');
    }
}

function showReaderPage(index) {
    if (index < 0 || index >= state.pages.length) return;
    
    readerCurrentPage = index;
    const page = state.pages[index];

    // Sicherstellen, dass sichtbare Sidebar-Thumbnails geladen werden
    scheduleReaderThumbLoad();
    
    // Bild aktualisieren (verwende hochauflösendes wenn verfügbar, sonst normal)
    const img = document.getElementById('reader-page-image');
    
    // Hole High-Res basierend auf sourceFile und originalNumber
    const highResCache = readerHighResThumbnails[page.sourceFile];
    const highRes = highResCache ? highResCache[page.originalNumber] : null;
    const thumbnail = highRes || page.thumbnail;
    
    if (thumbnail) {
        img.src = thumbnail;
        img.style.display = 'block';
    } else {
        // Kein Thumbnail verfügbar - zeige leeres Bild
        img.src = '';
        img.style.display = 'block';
    }
    img.style.transform = `rotate(${page.rotation}deg)`;
    
    // Seiteninformation aktualisieren
    document.getElementById('reader-page-info').textContent = `${index + 1} / ${state.pages.length}`;
    
    // Navigationsbuttons aktualisieren
    document.getElementById('btn-prev-page').disabled = index === 0;
    document.getElementById('btn-next-page').disabled = index === state.pages.length - 1;
    
    // Aktives Thumbnail markieren - benutze data-index Attribut
    document.querySelectorAll('.reader-thumb').forEach(thumb => {
        const thumbIndex = parseInt(thumb.dataset.index);
        thumb.classList.toggle('active', thumbIndex === index);
    });
    
    // Thumbnail in Sicht scrollen
    const activeThumb = document.querySelector(`.reader-thumb[data-index="${index}"]`);
    if (activeThumb) {
        activeThumb.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    
    // Outline-Hervorhebung aktualisieren
    highlightOutlineForPage(index);

    // Lade High-Res für aktuelle und umliegende Seiten (falls nicht im Cache)
    loadPriorityThumbnails(index);
}

// Lädt Thumbnails für aktuelle und umliegende Seiten priorisiert
async function loadPriorityThumbnails(centerIndex) {
    const page = state.pages[centerIndex];
    if (!page) return;
    
    // Prüfe ob aktuelle Seite bereits High-Res hat
    const cache = readerHighResThumbnails[page.sourceFile];
    const hasHighRes = cache && cache[page.originalNumber];
    
    if (!hasHighRes) {
        // Zeige Loading für diese Seite
        showReaderLoading(true);
        await loadSingleHighResThumbnail(page);
        showReaderPage(centerIndex);
        showReaderLoading(false);
    }
    
    // Lade umliegende Seiten PARALLEL im Hintergrund (±5 Seiten)
    const nearbyIndices = [];
    for (let offset = 1; offset <= 5; offset++) {
        if (centerIndex + offset < state.pages.length) nearbyIndices.push(centerIndex + offset);
        if (centerIndex - offset >= 0) nearbyIndices.push(centerIndex - offset);
    }
    
    // Parallel laden (max 4 gleichzeitig)
    const chunks = [];
    for (let i = 0; i < nearbyIndices.length; i += 4) {
        chunks.push(nearbyIndices.slice(i, i + 4));
    }
    
    for (const chunk of chunks) {
        if (!document.getElementById('screen-reader').classList.contains('active')) break;
        const promises = chunk.map(idx => {
            const nearPage = state.pages[idx];
            const nearCache = readerHighResThumbnails[nearPage.sourceFile];
            if (!nearCache || !nearCache[nearPage.originalNumber]) {
                return loadSingleHighResThumbnail(nearPage);
            }
            return Promise.resolve();
        });
        await Promise.all(promises);
    }
}

// ============================================
// PAGE VIEWER (Fullscreen Modal)
// ============================================

let viewerCurrentPage = 0;
let viewerHighResThumbnails = {};  // Cache: { sourceFile: { originalNumber: data } }
let viewerOutlineCache = {};

async function openPageViewer(startIndex = 0) {
    viewerCurrentPage = startIndex;
    viewerHighResThumbnails = {};  // Reset cache
    
    // Get the modal element
    const modal = document.getElementById('page-viewer');
    
    if (!modal) {
        console.error('Page viewer modal not found!');
        return;
    }
    
    // Show modal in current window
    modal.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    
    // Show current page immediately (low-res if available)
    showViewerPage(viewerCurrentPage);
    
    // Load outline
    loadViewerOutline();
    
    // Load high-res for current and nearby pages
    loadViewerThumbnails(viewerCurrentPage);
}

function closePageViewer() {
    const modal = document.getElementById('page-viewer');
    if (modal) {
        modal.style.display = 'none';
    }
    document.body.style.overflow = '';
    viewerHighResThumbnails = {};
    viewerOutlineCache = {};
}

function showViewerPage(index) {
    if (index < 0 || index >= state.pages.length) return;
    
    viewerCurrentPage = index;
    const page = state.pages[index];
    
    // Update image
    const img = document.getElementById('viewer-page-image');
    const highResCache = viewerHighResThumbnails[page.sourceFile];
    const highRes = highResCache ? highResCache[page.originalNumber] : null;
    const thumbnail = highRes || page.thumbnail;
    
    if (thumbnail) {
        img.src = thumbnail;
        img.style.transform = `rotate(${page.rotation}deg)`;
        img.style.display = 'block';
    } else {
        img.src = '';
        img.style.display = 'block';
    }
    
    // Update page info
    document.getElementById('viewer-page-info').textContent = `${index + 1} / ${state.pages.length}`;
    
    // Update navigation buttons
    document.getElementById('btn-viewer-prev').disabled = index === 0;
    document.getElementById('btn-viewer-next').disabled = index === state.pages.length - 1;
    
    // Update outline highlighting
    highlightViewerOutline(index);
    
    // Load high-res if not already cached
    loadViewerThumbnails(index);
}

async function loadViewerThumbnails(centerIndex) {
    const page = state.pages[centerIndex];
    if (!page) return;
    
    // Check if current page has high-res
    const cache = viewerHighResThumbnails[page.sourceFile];
    const hasHighRes = cache && cache[page.originalNumber];
    
    if (!hasHighRes) {
        // Show loading
        showViewerLoading(true);
        await loadSingleViewerThumbnail(page);
        showViewerPage(centerIndex);  // Refresh display
        showViewerLoading(false);
    }
    
    // Load nearby pages in background (±3 pages)
    const nearbyIndices = [];
    for (let offset = 1; offset <= 3; offset++) {
        if (centerIndex + offset < state.pages.length) nearbyIndices.push(centerIndex + offset);
        if (centerIndex - offset >= 0) nearbyIndices.push(centerIndex - offset);
    }
    
    // Load in parallel (chunks of 3)
    const chunks = [];
    for (let i = 0; i < nearbyIndices.length; i += 3) {
        chunks.push(nearbyIndices.slice(i, i + 3));
    }
    
    for (const chunk of chunks) {
        if (document.getElementById('page-viewer').style.display === 'none') break;
        const promises = chunk.map(idx => {
            const nearPage = state.pages[idx];
            const nearCache = viewerHighResThumbnails[nearPage.sourceFile];
            if (!nearCache || !nearCache[nearPage.originalNumber]) {
                return loadSingleViewerThumbnail(nearPage);
            }
            return Promise.resolve();
        });
        await Promise.all(promises);
    }
}

async function loadSingleViewerThumbnail(page) {
    // Check if already in cache
    const cache = viewerHighResThumbnails[page.sourceFile];
    if (cache && cache[page.originalNumber]) return;
    
    // Determine DPI based on total pages
    let dpi = 100;
    const pagesFromSameSource = state.pages.filter(p => p.sourceFile === page.sourceFile);
    const maxOriginalPage = Math.max(...pagesFromSameSource.map(p => p.originalNumber));
    if (maxOriginalPage > 200) {
        dpi = 72;
    } else if (maxOriginalPage > 100) {
        dpi = 85;
    }
    
    try {
        const result = await window.pedefo.pdf.generateSingleThumbnail(
            page.sourceFile,
            page.originalNumber,
            dpi
        );
        
        if (result.success && result.data) {
            // Initialize cache if needed
            if (!viewerHighResThumbnails[page.sourceFile]) {
                viewerHighResThumbnails[page.sourceFile] = {};
            }
            viewerHighResThumbnails[page.sourceFile][page.originalNumber] = result.data.data;
            
            // Update display if this is the current page
            const currentPage = state.pages[viewerCurrentPage];
            if (currentPage &&
                currentPage.sourceFile === page.sourceFile &&
                currentPage.originalNumber === page.originalNumber) {
                showViewerPage(viewerCurrentPage);
            }
        }
    } catch (error) {
        console.error(`Failed to load viewer thumbnail for page ${page.originalNumber}:`, error);
    }
}

function showViewerLoading(show) {
    const loading = document.getElementById('viewer-loading');
    const img = document.getElementById('viewer-page-image');
    
    if (show) {
        loading.classList.add('visible');
        img.classList.add('loading');
    } else {
        loading.classList.remove('visible');
        img.classList.remove('loading');
    }
}

// Outline functions
async function loadViewerOutline(forceRefresh = false) {
    const files = Array.from(new Set(state.pages.map(p => p.sourceFile)));
    
    if (forceRefresh) {
        viewerOutlineCache = {};
    }
    
    const fetches = files.map(async (filePath) => {
        if (!forceRefresh && viewerOutlineCache[filePath] !== undefined) return;
        try {
            const result = await window.pedefo.pdf.getOutline(filePath);
            const outline = result && result.data && Array.isArray(result.data.outline) ? result.data.outline : [];
            viewerOutlineCache[filePath] = outline;
        } catch (error) {
            viewerOutlineCache[filePath] = [];
        }
    });
    
    await Promise.all(fetches);
    renderViewerOutline();
}

function renderViewerOutline() {
    const body = document.getElementById('viewer-outline-body');
    if (!body) return;
    
    body.innerHTML = '';
    const placeholder = document.createElement('div');
    placeholder.className = 'viewer-outline-empty';
    placeholder.textContent = 'Kein Inhaltsverzeichnis gefunden';
    
    const files = Array.from(new Set(state.pages.map(p => p.sourceFile)));
    const multipleSources = files.length > 1;
    let hasEntries = false;
    
    files.forEach((filePath) => {
        const outline = viewerOutlineCache[filePath];
        if (!outline || outline.length === 0) return;
        hasEntries = true;
        
        if (multipleSources) {
            const sourceLabel = document.createElement('div');
            sourceLabel.className = 'viewer-outline-source';
            sourceLabel.textContent = getBaseName(filePath);
            body.appendChild(sourceLabel);
        }
        
        const maxPage = getMaxPageForSource(filePath);
        const rangeMap = computeOutlineRanges(outline, maxPage);
        appendViewerOutlineItems(outline, filePath, body, 0, rangeMap);
    });
    
    if (!hasEntries) {
        body.appendChild(placeholder);
    } else {
        highlightViewerOutline(viewerCurrentPage);
    }
}

function appendViewerOutlineItems(items, sourceFile, container, depth, rangeMap) {
    items.forEach((item) => {
        const el = document.createElement('div');
        el.className = 'viewer-outline-item';
        el.dataset.depth = depth;
        el.dataset.sourceFile = sourceFile;

        const label = document.createElement('span');
        label.className = 'viewer-outline-text';
        label.textContent = item.title || 'Ohne Titel';

        const range = rangeMap.get(item) || null;
        const startPage = range ? range.start : parseOutlinePageNumber(item.page);
        const endPage = range ? range.end : startPage;
        const rangeLabel = startPage !== null
            ? (endPage !== null && endPage !== startPage ? `S. ${startPage}-${endPage}` : `S. ${startPage}`)
            : '';

        if (startPage !== null) {
            el.dataset.rangeStart = startPage;
            el.dataset.rangeEnd = endPage;
        }

        const actions = document.createElement('div');
        actions.className = 'viewer-outline-actions';

        const extractBtn = document.createElement('button');
        extractBtn.className = 'viewer-outline-action';
        extractBtn.title = 'Kapitel extrahieren';
        extractBtn.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 5v10" />
                <path d="M7 10l5 5 5-5" />
                <rect x="5" y="17" width="14" height="2" rx="1" />
            </svg>
        `;
        extractBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            extractOutlineChapter(sourceFile, startPage, item.title, endPage);
        });
        actions.appendChild(extractBtn);

        el.appendChild(label);
        if (rangeLabel) {
            const rangeSpan = document.createElement('span');
            rangeSpan.className = 'viewer-outline-range';
            rangeSpan.textContent = rangeLabel;
            el.appendChild(rangeSpan);
        }
        el.appendChild(actions);

        const pageIndex = findViewerPageIndex(sourceFile, startPage);
        if (pageIndex !== -1) {
            el.addEventListener('click', () => {
                showViewerPage(pageIndex);
            });
        } else {
            el.classList.add('disabled');
        }

        container.appendChild(el);

        if (item.children && item.children.length > 0) {
            appendViewerOutlineItems(item.children, sourceFile, container, depth + 1, rangeMap);
        }
    });
}

async function extractOutlineChapter(sourceFile, startPage, title, endPage) {
    const outline = viewerOutlineCache[sourceFile];
    if (!outline || !Array.isArray(outline) || outline.length === 0) {
        showToast('Kein Inhaltsverzeichnis verfügbar', 'error');
        return;
    }

    const pagesForSource = state.pages.filter(p => p.sourceFile === sourceFile);
    if (pagesForSource.length === 0) {
        showToast('Quellseiten nicht gefunden', 'error');
        return;
    }

    const maxPage = Math.max(...pagesForSource.map(p => p.originalNumber));
    const flat = flattenOutlineEntries(outline);
    const sorted = flat.filter(e => e.page !== null).sort((a, b) => a.page - b.page);

    const start = parseInt(startPage, 10);
    if (Number.isNaN(start)) {
        showToast('Dieses Kapitel hat keine Seitenzahl', 'error');
        return;
    }

    let end = null;

    if (endPage !== null && endPage !== undefined && !Number.isNaN(parseInt(endPage, 10))) {
        end = parseInt(endPage, 10);
    } else {
        const idx = sorted.findIndex(e => e.page === start);
        if (idx === -1) {
            showToast('Kapitel konnte nicht gefunden werden', 'error');
            return;
        }
        // Find next outline entry on a later page (ignore entries on the same page)
        const nextLater = sorted.slice(idx + 1).find(e => e.page > start);
        end = nextLater ? nextLater.page - 1 : maxPage;
    }

    if (end === null || Number.isNaN(end) || end < start) {
        end = start;
    }
    const pagesToExtract = pagesForSource
        .filter(p => p.originalNumber >= start && p.originalNumber <= end)
        .map(p => ({ originalNumber: p.originalNumber, rotation: p.rotation }));

    if (pagesToExtract.length === 0) {
        showToast('Keine Seiten im Kapitel gefunden', 'error');
        return;
    }

    const defaultName = `${sanitizeFilename(title || 'Kapitel')}.pdf`;
    const outputPath = await window.pedefo.saveFile(defaultName);
    if (!outputPath) return;

    showLoading('Kapitel wird extrahiert...');
    try {
        const operations = [{ sourceFile, pages: pagesToExtract }];
        const result = await window.pedefo.pdf.buildPDF(operations, outputPath);
        if (result.success) {
            showToast('Kapitel extrahiert', 'success', {
                label: 'Öffnen',
                onClick: () => {
                    window.pedefo.file.openPath(outputPath);
                }
            });
        } else {
            throw new Error(result.message || 'Fehler beim Extrahieren');
        }
    } catch (error) {
        showToast(error.message, 'error');
    } finally {
        hideLoading();
    }
}

function flattenOutlineEntries(entries, acc = []) {
    entries.forEach((entry) => {
        const pageNum = entry.page !== null && entry.page !== undefined ? parseInt(entry.page, 10) : null;
        acc.push({ page: Number.isNaN(pageNum) ? null : pageNum, title: entry.title || '' });
        if (entry.children && entry.children.length > 0) {
            flattenOutlineEntries(entry.children, acc);
        }
    });
    return acc;
}

function findViewerPageIndex(sourceFile, pageNumber) {
    if (pageNumber === null || pageNumber === undefined) return -1;
    const pageNum = parseInt(pageNumber, 10);
    if (Number.isNaN(pageNum)) return -1;
    return state.pages.findIndex(p => p.sourceFile === sourceFile && p.originalNumber === pageNum);
}

function highlightViewerOutline(pageIndex) {
    const page = state.pages[pageIndex];
    if (!page) return;

    let activeItem = null;
    document.querySelectorAll('.viewer-outline-item').forEach((item) => {
        const sourceMatches = item.dataset.sourceFile === page.sourceFile;
        const start = parseInt(item.dataset.rangeStart, 10);
        const end = parseInt(item.dataset.rangeEnd, 10);
        const inRange = sourceMatches && !Number.isNaN(start) && !Number.isNaN(end) &&
            page.originalNumber >= start && page.originalNumber <= end;

        item.classList.toggle('active', inRange);
        if (inRange) activeItem = item;
    });

    if (activeItem) {
        activeItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
}

// Event Listeners
document.getElementById('btn-viewer-close').addEventListener('click', closePageViewer);
document.getElementById('btn-viewer-prev').addEventListener('click', () => {
    showViewerPage(viewerCurrentPage - 1);
});
document.getElementById('btn-viewer-next').addEventListener('click', () => {
    showViewerPage(viewerCurrentPage + 1);
});
document.getElementById('btn-viewer-outline-refresh').addEventListener('click', () => {
    loadViewerOutline(true);
});

// Keyboard Navigation
document.addEventListener('keydown', (e) => {
    if (document.getElementById('page-viewer').style.display !== 'flex') return;
    
    if (e.key === 'Escape') {
        closePageViewer();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        showViewerPage(viewerCurrentPage - 1);
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === ' ') {
        e.preventDefault();
        showViewerPage(viewerCurrentPage + 1);
    }
});

// ============================================
// Extract Selected Pages
// ============================================

async function extractSelectedPages() {
    if (state.selectedPages.size === 0) {
        showToast('Keine Seiten ausgewählt', 'error');
        return;
    }
    
    const outputPath = await window.pedefo.saveFile('extrahiert.pdf');
    if (!outputPath) return;
    
    showLoading('Extrahiere Seiten...');
    
    try {
        // Sammle die ausgewählten Seiten in der richtigen Reihenfolge
        const selectedIndices = [];
        state.pages.forEach((page, index) => {
            if (state.selectedPages.has(page.id)) {
                selectedIndices.push(index);
            }
        });
        
        // Gruppiere nach Quelldatei
        const operations = [];
        let currentGroup = null;
        
        selectedIndices.forEach(index => {
            const page = state.pages[index];
            if (!currentGroup || currentGroup.sourceFile !== page.sourceFile) {
                currentGroup = {
                    sourceFile: page.sourceFile,
                    pages: []
                };
                operations.push(currentGroup);
            }
            currentGroup.pages.push({
                originalNumber: page.originalNumber,
                rotation: page.rotation
            });
        });
        
        const result = await window.pedefo.pdf.buildPDF(operations, outputPath);
        
        if (result.success) {
            showToast(`${state.selectedPages.size} Seite(n) extrahiert`, 'success');
        } else {
            throw new Error(result.message);
        }
        
    } catch (error) {
        showToast(error.message, 'error');
    } finally {
        hideLoading();
    }
}

// ============================================
// Selection Bar Actions
// ============================================

document.getElementById('btn-rotate-left').addEventListener('click', () => {
    if (state.selectedPages.size > 0) {
        rotatePagesBy(Array.from(state.selectedPages), -90);
    }
});

document.getElementById('btn-rotate-right').addEventListener('click', () => {
    if (state.selectedPages.size > 0) {
        rotatePagesBy(Array.from(state.selectedPages), 90);
    }
});

document.getElementById('btn-extract-selection').addEventListener('click', extractSelectedPages);

document.getElementById('btn-duplicate').addEventListener('click', () => {
    if (state.selectedPages.size > 0) {
        duplicatePages(Array.from(state.selectedPages));
    }
});

document.getElementById('btn-delete').addEventListener('click', () => {
    if (state.selectedPages.size > 0) {
        deletePages(Array.from(state.selectedPages));
    }
});

document.getElementById('btn-selection-collapse').addEventListener('click', () => {
    state.selectedPages.clear();
    updatePageSelectionUI();
    updateSelectionBar();
});

document.getElementById('btn-deselect').addEventListener('click', () => {
    state.selectedPages.clear();
    updatePageSelectionUI();
    updateSelectionBar();
});

// ============================================
// Toolbar Actions
// ============================================

document.getElementById('btn-add-pdf').addEventListener('click', () => {
    insertPDFAt(state.pages.length);
});

document.getElementById('btn-extract').addEventListener('click', openExtractModal);
document.getElementById('btn-extract-confirm').addEventListener('click', extractPages);

document.getElementById('btn-compress').addEventListener('click', openCompressModal);
document.getElementById('btn-compress-confirm').addEventListener('click', compressPDF);

document.getElementById('btn-save').addEventListener('click', savePDF);
document.getElementById('btn-new').addEventListener('click', newFile);

// ============================================
// Keyboard Shortcuts
// ============================================

document.addEventListener('keydown', (e) => {
    // Ctrl+A: Select all
    if (e.ctrlKey && e.key === 'a' && state.pages.length > 0) {
        e.preventDefault();
        state.pages.forEach(p => state.selectedPages.add(p.id));
        updatePageSelectionUI();
        updateSelectionBar();
    }
    
    // Delete: Delete selected pages
    if (e.key === 'Delete' && state.selectedPages.size > 0) {
        deletePages(Array.from(state.selectedPages));
    }
    
    // Escape: Deselect all
    if (e.key === 'Escape') {
        state.selectedPages.clear();
        updatePageSelectionUI();
        updateSelectionBar();
        hideModal();
    }
    
    // Ctrl+S: Save
    if (e.ctrlKey && e.key === 's' && state.pages.length > 0) {
        e.preventDefault();
        savePDF();
    }
});

// ============================================
// Initialize
// ============================================

// Exponiere isDirty-Status für main.js (close-Event)
window.getIsDirty = () => state.isDirty && state.pages.length > 0;

// Listener für "Speichern vor Schließen"
window.pedefo.onSaveBeforeClose(async () => {
    const saved = await savePDF();
    if (saved) {
        window.pedefo.saveCompleted();
    }
});

// Listener für "Zeige Unsaved Dialog"
window.pedefo.onShowUnsavedDialog(() => {
    showModal('unsaved');
});

// Setup Unsaved Modal Buttons
function setupUnsavedModal() {
    const saveBtn = document.getElementById('btn-unsaved-save');
    const discardBtn = document.getElementById('btn-unsaved-discard');
    const cancelBtn = document.getElementById('btn-unsaved-cancel-btn');
    const closeBtn = document.getElementById('btn-unsaved-cancel');
    
    const handleSave = async () => {
        hideModal();
        const saved = await savePDF();
        if (saved) {
            window.pedefo.saveCompleted();
        }
    };
    
    const handleDiscard = () => {
        hideModal();
        window.pedefo.closeWithoutSave();
    };
    
    const handleCancel = () => {
        hideModal();
    };
    
    saveBtn.addEventListener('click', handleSave);
    discardBtn.addEventListener('click', handleDiscard);
    cancelBtn.addEventListener('click', handleCancel);
    closeBtn.addEventListener('click', handleCancel);
}

document.addEventListener('DOMContentLoaded', () => {
    setupUploadZone();
    setupUnsavedModal();
    
    // Ensure page viewer lives at body level (avoids stacking context issues)
    const viewerModal = document.getElementById('page-viewer');
    if (viewerModal && viewerModal.parentElement !== document.body) {
        document.body.appendChild(viewerModal);
    }
    
    // Fullscreen button - opens viewer with first selected page
    const btnFullscreen = document.getElementById('btn-fullscreen-view');
    
    if (btnFullscreen) {
        btnFullscreen.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            
            if (state.selectedPages.size > 0) {
                // Get first selected page
                const firstSelectedId = Array.from(state.selectedPages)[0];
                const pageIndex = state.pages.findIndex(p => p.id === firstSelectedId);
                
                if (pageIndex !== -1) {
                    openPageViewer(pageIndex);
                }
            }
        });
    }
});
