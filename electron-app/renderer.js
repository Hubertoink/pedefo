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
    splitPoints: [],             // page indices where a split starts (between pages)
    lastFocusedPageId: null,     // used to prioritize loading around user focus
    editingChapterPageId: null,
    ocr: {
        sourceFile: null,
        checked: false,
        recommended: false,
        textChars: 0,
        sampledPages: 0,
        running: false
    }
};

// Performance helpers
let pageIndexById = new Map();
let renderPagesToken = 0;

const gridVirtual = {
    rowHeight: 240,
    overscanRows: 3,
    pageWidth: 140,
    insertWidth: 40,
    gap: 8,
    inner: null,
    scrollAttached: false,
    renderScheduled: false,
    pagesPerRow: 1,
    resizeObserver: null
};

const pdfRender = {
    pdfjsReady: null,
    documents: new Map(),
    imageCache: new Map(),
    pending: new Map(),
    objectUrls: new Set(),
    queue: [],
    active: 0,
    maxConcurrent: 2,
    loadToken: 0
};

const textLayerTokens = {
    reader: 0,
    viewer: 0
};

// Grid thumbnail visibility tracking (avoids scanning all cards on scroll)
let gridThumbObserver = null;
let gridVisiblePageIds = new Set();
let gridChapterMarkersByInsertIndex = new Map();

// Reader thumbnail visibility tracking
let readerThumbObserver = null;
let readerVisibleIndices = new Set();

// ============================================
// PDF.js Rendering
// ============================================

function normalizeBinaryData(data) {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (data && data.buffer instanceof ArrayBuffer) {
        return new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength || data.buffer.byteLength);
    }
    if (data && Array.isArray(data.data)) {
        return new Uint8Array(data.data);
    }
    return new Uint8Array(data || []);
}

async function ensurePdfJs() {
    if (!pdfRender.pdfjsReady) {
        pdfRender.pdfjsReady = import('./lib/pdf.mjs').then((pdfjs) => {
            pdfjs.GlobalWorkerOptions.workerSrc = new URL('./lib/pdf.worker.mjs', window.location.href).href;
            return pdfjs;
        });
    }
    return pdfRender.pdfjsReady;
}

async function getPdfDocument(filePath) {
    if (pdfRender.documents.has(filePath)) {
        return pdfRender.documents.get(filePath);
    }

    const pdfjs = await ensurePdfJs();
    const binary = await window.pedefo.file.readBinary(filePath);
    const data = normalizeBinaryData(binary);
    const task = pdfjs.getDocument({
        data,
        isEvalSupported: false,
        useSystemFonts: true
    });
    const documentProxy = await task.promise;
    pdfRender.documents.set(filePath, documentProxy);
    return documentProxy;
}

async function getPdfPageCount(filePath) {
    try {
        const documentProxy = await getPdfDocument(filePath);
        return documentProxy.numPages;
    } catch (error) {
        const result = await window.pedefo.pdf.getPageCount(filePath);
        if (!result.success) throw new Error(result.message);
        return result.data.pages;
    }
}

function resetOcrState(sourceFile = null) {
    state.ocr = {
        sourceFile,
        checked: false,
        recommended: false,
        textChars: 0,
        sampledPages: 0,
        running: false
    };
    updateOcrControls();
}

function updateOcrControls() {
    const buttons = [
        document.getElementById('btn-ocr'),
        document.getElementById('btn-viewer-ocr')
    ].filter(Boolean);

    const show = state.pages.length > 0 && state.ocr.checked && state.ocr.recommended;
    buttons.forEach((button) => {
        button.style.display = show ? 'flex' : 'none';
        button.disabled = !!state.ocr.running;
        button.title = state.ocr.running
            ? 'OCR läuft bereits'
            : 'OCR ausführen und durchsuchbare PDF erstellen';
    });
}

async function samplePdfTextStats(filePath, maxPages = 5) {
    const documentProxy = await getPdfDocument(filePath);
    const sampledPages = Math.min(documentProxy.numPages, maxPages);
    let textChars = 0;
    let textItems = 0;

    for (let pageNumber = 1; pageNumber <= sampledPages; pageNumber++) {
        const pdfPage = await documentProxy.getPage(pageNumber);
        const textContent = await pdfPage.getTextContent();
        const items = Array.isArray(textContent.items) ? textContent.items : [];
        textItems += items.length;
        for (const item of items) {
            const text = typeof item.str === 'string' ? item.str.replace(/\s+/g, '') : '';
            textChars += text.length;
        }
    }

    return { sampledPages, textChars, textItems };
}

async function detectOcrNeed(filePath, loadToken) {
    try {
        const stats = await samplePdfTextStats(filePath);
        if (loadToken !== pdfRender.loadToken || state.currentFile !== filePath) return;

        const threshold = Math.max(60, stats.sampledPages * 30);
        state.ocr = {
            sourceFile: filePath,
            checked: true,
            recommended: stats.textChars < threshold,
            textChars: stats.textChars,
            sampledPages: stats.sampledPages,
            running: false
        };
        updateOcrControls();

        if (state.ocr.recommended) {
            showToast('Scan erkannt: OCR kann auswählbaren Text erzeugen', 'info');
        }
    } catch (_) {
        if (loadToken !== pdfRender.loadToken || state.currentFile !== filePath) return;
        state.ocr = {
            sourceFile: filePath,
            checked: true,
            recommended: false,
            textChars: 0,
            sampledPages: 0,
            running: false
        };
        updateOcrControls();
    }
}

function getTextLayerImageId(target) {
    return target === 'viewer' ? 'viewer-page-image' : 'reader-page-image';
}

function getTextLayerId(target) {
    return target === 'viewer' ? 'viewer-text-layer' : 'reader-text-layer';
}

function clearSelectableTextLayer(target) {
    textLayerTokens[target] = (textLayerTokens[target] || 0) + 1;
    const layer = document.getElementById(getTextLayerId(target));
    if (layer) {
        layer.innerHTML = '';
        layer.classList.remove('has-text');
        layer.style.display = 'none';
    }
}

function ensureSelectableTextLayer(target) {
    const img = document.getElementById(getTextLayerImageId(target));
    if (!img) return null;

    const host = img.closest('.reader-image-container, .page-viewer-page-frame, .page-viewer-content') || img.parentElement;
    if (!host) return null;

    let layer = document.getElementById(getTextLayerId(target));
    if (!layer) {
        layer = document.createElement('div');
        layer.id = getTextLayerId(target);
        layer.className = 'pdf-text-layer textLayer';
        host.appendChild(layer);
    }

    return { img, host, layer };
}

function waitForImageLayout(img) {
    if (img.complete && img.naturalWidth > 0 && img.getBoundingClientRect().width > 0) {
        return Promise.resolve();
    }

    return new Promise((resolve) => {
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            img.removeEventListener('load', finish);
            img.removeEventListener('error', finish);
            resolve();
        };
        img.addEventListener('load', finish, { once: true });
        img.addEventListener('error', finish, { once: true });
        setTimeout(finish, 2500);
    });
}

function positionSelectableTextLayer(layer, host, img) {
    const hostRect = host.getBoundingClientRect();
    const imgRect = img.getBoundingClientRect();

    if (!hostRect.width || !hostRect.height || !imgRect.width || !imgRect.height) {
        return null;
    }

    layer.style.display = 'block';
    layer.style.left = `${imgRect.left - hostRect.left + (host.scrollLeft || 0)}px`;
    layer.style.top = `${imgRect.top - hostRect.top + (host.scrollTop || 0)}px`;
    layer.style.width = `${imgRect.width}px`;
    layer.style.height = `${imgRect.height}px`;
    return { width: imgRect.width, height: imgRect.height };
}

async function renderSelectableTextLayer(target, page) {
    const token = (textLayerTokens[target] || 0) + 1;
    textLayerTokens[target] = token;

    const elements = ensureSelectableTextLayer(target);
    if (!elements || !page) return;

    const { img, host, layer } = elements;
    layer.innerHTML = '';
    layer.classList.remove('has-text');
    layer.style.display = 'none';

    if (!img.src) return;

    try {
        await waitForImageLayout(img);
        if (textLayerTokens[target] !== token) return;

        const bounds = positionSelectableTextLayer(layer, host, img);
        if (!bounds) return;

        const pdfjs = await ensurePdfJs();
        const documentProxy = await getPdfDocument(page.sourceFile);
        const pdfPage = await documentProxy.getPage(page.originalNumber);
        if (textLayerTokens[target] !== token) return;

        const rotation = ((page.rotation || 0) % 360 + 360) % 360;
        const baseViewport = pdfPage.getViewport({ scale: 1, rotation });
        const widthScale = bounds.width / baseViewport.width;
        const heightScale = bounds.height / baseViewport.height;
        const scale = Math.max(0.1, Math.min(widthScale, heightScale));
        const viewport = pdfPage.getViewport({ scale, rotation });
        const textContent = await pdfPage.getTextContent();
        if (textLayerTokens[target] !== token) return;

        if (!textContent.items || textContent.items.length === 0) {
            layer.style.display = 'none';
            return;
        }

        layer.style.setProperty('--total-scale-factor', String(scale));
        layer.innerHTML = '';
        const textLayer = new pdfjs.TextLayer({
            textContentSource: textContent,
            container: layer,
            viewport
        });
        await textLayer.render();

        if (textLayerTokens[target] !== token) return;
        positionSelectableTextLayer(layer, host, img);
        layer.classList.add('has-text');
    } catch (error) {
        if (textLayerTokens[target] === token) {
            layer.innerHTML = '';
            layer.classList.remove('has-text');
            layer.style.display = 'none';
        }
    }
}

function clearRenderedImages() {
    for (const url of pdfRender.objectUrls) {
        URL.revokeObjectURL(url);
    }
    pdfRender.objectUrls.clear();
    pdfRender.imageCache.clear();
    pdfRender.pending.clear();
    pdfRender.queue = [];
}

function getPageRenderKey(page, variant, maxWidth, maxHeight) {
    const sharedVariant = (variant === 'grid' || variant === 'reader-thumb') ? 'thumb' : variant;
    return `${page.sourceFile}|${page.originalNumber}|${sharedVariant}|${maxWidth}|${maxHeight || 0}`;
}

function schedulePdfPageRender(page, options = {}) {
    const variant = options.variant || 'grid';
    const maxWidth = options.maxWidth || 240;
    const maxHeight = options.maxHeight || 0;
    const priority = options.priority || 0;
    const key = getPageRenderKey(page, variant, maxWidth, maxHeight);

    if (pdfRender.imageCache.has(key)) {
        return Promise.resolve(pdfRender.imageCache.get(key));
    }
    if (pdfRender.pending.has(key)) {
        return pdfRender.pending.get(key);
    }

    const promise = new Promise((resolve, reject) => {
        pdfRender.queue.push({ page, variant, maxWidth, maxHeight, priority, key, resolve, reject });
        pdfRender.queue.sort((a, b) => b.priority - a.priority);
        pumpPdfRenderQueue();
    });

    pdfRender.pending.set(key, promise);
    promise.then(
        () => pdfRender.pending.delete(key),
        () => pdfRender.pending.delete(key)
    );
    return promise;
}

function pumpPdfRenderQueue() {
    while (pdfRender.active < pdfRender.maxConcurrent && pdfRender.queue.length > 0) {
        const job = pdfRender.queue.shift();
        pdfRender.active++;

        renderPdfPageToObjectUrl(job.page, job.maxWidth, job.maxHeight)
            .then((url) => {
                pdfRender.imageCache.set(job.key, url);
                job.resolve(url);
            })
            .catch(job.reject)
            .finally(() => {
                pdfRender.active--;
                pumpPdfRenderQueue();
            });
    }
}

async function renderPdfPageToObjectUrl(page, maxWidth, maxHeight) {
    const documentProxy = await getPdfDocument(page.sourceFile);
    const pdfPage = await documentProxy.getPage(page.originalNumber);
    const baseViewport = pdfPage.getViewport({ scale: 1 });
    const widthScale = maxWidth / baseViewport.width;
    const heightScale = maxHeight ? maxHeight / baseViewport.height : widthScale;
    const scale = Math.max(0.1, Math.min(widthScale, heightScale, 2.5));
    const viewport = pdfPage.getViewport({ scale });

    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { alpha: false });
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);

    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);

    await pdfPage.render({ canvasContext: context, viewport }).promise;

    const blob = await new Promise((resolve, reject) => {
        canvas.toBlob((result) => {
            if (result) resolve(result);
            else reject(new Error('PDF-Seite konnte nicht gerendert werden'));
        }, 'image/jpeg', 0.86);
    });

    canvas.width = 0;
    canvas.height = 0;

    const url = URL.createObjectURL(blob);
    pdfRender.objectUrls.add(url);
    return url;
}

function getViewerRenderBounds() {
    const content = document.querySelector('.page-viewer-content');
    if (!content) return { maxWidth: 1400, maxHeight: 1800 };
    const rect = content.getBoundingClientRect();
    const maxWidth = Math.max(900, Math.min(1800, Math.floor(rect.width * 1.5)));
    const maxHeight = Math.max(1000, Math.min(2200, Math.floor(rect.height * 1.5)));
    return { maxWidth, maxHeight };
}

// ============================================
// Utility Functions
// ============================================

function showToast(message, type = 'info') {
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
    
    container.appendChild(toast);
    
    setTimeout(() => {
        toast.classList.add('fade-out');
        setTimeout(() => toast.remove(), 200);
    }, 4000);
}

function setLoadingProgress(percent = 0, detail = '') {
    const progress = document.getElementById('loading-progress');
    const fill = document.getElementById('loading-progress-fill');
    const percentText = document.getElementById('loading-progress-percent');
    const detailText = document.getElementById('loading-progress-detail');
    if (!progress || !fill || !percentText || !detailText) return;

    const safePercent = Math.max(0, Math.min(100, Number(percent) || 0));
    progress.style.display = 'block';
    progress.setAttribute('aria-valuenow', String(Math.round(safePercent)));
    fill.style.width = `${safePercent}%`;
    percentText.textContent = `${Math.round(safePercent)}%`;
    detailText.textContent = detail || 'Wird verarbeitet...';
}

function hideLoadingProgress() {
    const progress = document.getElementById('loading-progress');
    const fill = document.getElementById('loading-progress-fill');
    const percentText = document.getElementById('loading-progress-percent');
    const detailText = document.getElementById('loading-progress-detail');
    if (!progress || !fill || !percentText || !detailText) return;

    progress.style.display = 'none';
    progress.setAttribute('aria-valuenow', '0');
    fill.style.width = '0%';
    percentText.textContent = '0%';
    detailText.textContent = 'Wird vorbereitet...';
}

function showLoading(text = 'Verarbeite...', options = {}) {
    const loading = document.getElementById('loading');
    document.getElementById('loading-text').textContent = text;
    if (options.progress) {
        setLoadingProgress(options.percent || 0, options.detail || 'Wird vorbereitet...');
    } else {
        hideLoadingProgress();
    }
    loading.style.display = 'flex';
}

function hideLoading() {
    document.getElementById('loading').style.display = 'none';
    hideLoadingProgress();
}

function getBaseName(filePath) {
    return filePath.split(/[\\/]/).pop();
}

function normalizePdfFilePaths(files) {
    return Array.from(files || [])
        .map(file => typeof file === 'string' ? file : file?.path)
        .filter(filePath => filePath && filePath.toLowerCase().endsWith('.pdf'));
}

function getPdfFilePathsFromDataTransfer(dataTransfer) {
    return normalizePdfFilePaths(dataTransfer?.files);
}

function isExternalFileDrag(event) {
    return Array.from(event.dataTransfer?.types || []).includes('Files');
}

function escapeHtml(value) {
    return String(value || '').replace(/[&<>"']/g, (char) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[char]));
}

function getChapterTitle(page) {
    return (page && typeof page.chapterTitle === 'string') ? page.chapterTitle.trim() : '';
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
    updateFloatingButtons();
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

function isModalOpen() {
    return document.getElementById('modal-overlay').style.display === 'flex';
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

function setupEditorFileDropZone() {
    const container = document.getElementById('pages-container');
    if (!container) return;

    const activateDropState = (e) => {
        if (!isExternalFileDrag(e)) return false;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'copy';
        setEditorFileDragState(true);
        return true;
    };

    container.addEventListener('dragenter', activateDropState);
    container.addEventListener('dragover', activateDropState);

    container.addEventListener('dragleave', (e) => {
        if (!isExternalFileDrag(e)) return;
        if (!container.contains(e.relatedTarget)) {
            setEditorFileDragState(false);
        }
    });

    container.addEventListener('drop', async (e) => {
        if (!isExternalFileDrag(e)) return;
        if (e.target.closest('.insert-zone')) return;
        e.preventDefault();
        e.stopPropagation();
        setEditorFileDragState(false);

        const filePaths = getPdfFilePathsFromDataTransfer(e.dataTransfer);
        if (filePaths.length === 0) {
            showToast('Bitte eine PDF-Datei auswählen', 'error');
            return;
        }

        await insertPdfFilesAt(filePaths, state.pages.length);
    });
}

// ============================================
// PDF Loading & Page Rendering
// ============================================

async function loadPDF(filePath) {
    const loadToken = ++pdfRender.loadToken;
    showLoading('Lade PDF...');
    
    try {
        clearRenderedImages();
        const pageCount = await getPdfPageCount(filePath);
        if (loadToken !== pdfRender.loadToken) return;
        
        state.currentFile = filePath;
        state.pages = [];
        state.selectedPages.clear();
        state.isDirty = false;
        resetOcrState(filePath);
        outlineCache = {};
        expandedOutlineKeys.clear();
        hideFloatingOutlinePanel();
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
                thumbnail: null,
                chapterTitle: ''
            });
        }

        rebuildPageIndexById();
        
        // Update UI
        document.getElementById('current-file-name').textContent = getBaseName(filePath);
        updateStatusBar();
        renderPages();
        showScreen('screen-editor');
        
        // Generate thumbnails with PDF.js render queue
        generateThumbnailsWithPoppler(filePath);

        loadOutlineForSources().catch(() => {});
        detectOcrNeed(filePath, loadToken).catch(() => {});
        
        showToast(`${pageCount} Seiten geladen`, 'success');
        
    } catch (error) {
        showToast(error.message, 'error');
    } finally {
        hideLoading();
    }
}

function rebuildPageIndexById() {
    pageIndexById = new Map();
    for (let i = 0; i < state.pages.length; i++) {
        pageIndexById.set(state.pages[i].id, i);
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
    if (visiblePages.length === 0) return;

    // Prioritize pages around current focus (or center of visible range)
    let focusIndex = (state.lastFocusedPageId && pageIndexById.has(state.lastFocusedPageId))
        ? pageIndexById.get(state.lastFocusedPageId)
        : null;
    if (focusIndex === null) {
        const mid = visiblePages[Math.floor(visiblePages.length / 2)];
        focusIndex = mid?.index ?? 0;
    }

    visiblePages.sort((a, b) => {
        const da = Math.abs(a.index - focusIndex);
        const db = Math.abs(b.index - focusIndex);
        if (da !== db) return da - db;
        return a.index - b.index;
    });

    // Collect pages to load in batch (up to 16 at once)
    const toLoad = [];
    for (const pageInfo of visiblePages) {
        if (toLoad.length >= 16) break;
        const page = state.pages[pageInfo.index];
        if (!page) continue;
        if (page.thumbnail) continue;
        if (gridThumbLoading.has(page.id)) continue;
        const cfg = gridThumbConfig[page.sourceFile];
        if (!cfg) continue;
        toLoad.push({ page, cfg, index: pageInfo.index });
    }

    if (toLoad.length === 0) return;

    // Group by sourceFile for batch loading
    const bySource = {};
    for (const item of toLoad) {
        const key = item.page.sourceFile;
        if (!bySource[key]) bySource[key] = { cfg: item.cfg, pages: [] };
        bySource[key].pages.push(item.page);
        gridThumbLoading.add(item.page.id);
    }

    // Load each source as a batch
    for (const [sourceFile, { cfg, pages }] of Object.entries(bySource)) {
        const pageNumbers = pages.map(p => p.originalNumber);
        loadGridThumbnailBatch(sourceFile, pageNumbers, pages, cfg.dpi, cfg.total)
            .finally(() => pages.forEach(p => gridThumbLoading.delete(p.id)));
    }
}

function getVisiblePagesInGrid() {
    const container = document.getElementById('pages-container');
    if (!container) return [];

    // Fast path: IntersectionObserver maintains a set of visible page ids
    if (gridThumbObserver) {
        const out = [];
        for (const id of gridVisiblePageIds) {
            const idx = pageIndexById.get(id);
            if (typeof idx === 'number') out.push({ id, index: idx });
        }
        return out;
    }

    // Fallback path: compute visibility by scanning cards (slower)
    const containerRect = container.getBoundingClientRect();
    const visiblePages = [];
    const buffer = 300;

    document.querySelectorAll('.page-card').forEach(card => {
        const rect = card.getBoundingClientRect();
        const pageId = card.dataset.pageId;
        const isVisible = rect.bottom > containerRect.top - buffer && rect.top < containerRect.bottom + buffer;
        if (!isVisible || !pageId) return;
        const index = pageIndexById.get(pageId);
        if (typeof index === 'number') visiblePages.push({ id: pageId, index });
    });

    return visiblePages;
}

function attachGridThumbnailObserver() {
    const container = document.getElementById('pages-container');
    if (!container) return;

    // Reset
    if (gridThumbObserver) {
        gridThumbObserver.disconnect();
        gridThumbObserver = null;
    }
    gridVisiblePageIds = new Set();

    if (!('IntersectionObserver' in window)) {
        return; // will use fallback scanning
    }

    gridThumbObserver = new IntersectionObserver(
        (entries) => {
            let changed = false;
            for (const entry of entries) {
                const id = entry.target?.dataset?.pageId;
                if (!id) continue;
                if (entry.isIntersecting) {
                    if (!gridVisiblePageIds.has(id)) {
                        gridVisiblePageIds.add(id);
                        changed = true;
                    }
                } else {
                    if (gridVisiblePageIds.delete(id)) changed = true;
                }
            }
            if (changed) scheduleGridThumbnailLoad();
        },
        {
            root: container,
            rootMargin: '400px 0px',
            threshold: 0.01
        }
    );

    document.querySelectorAll('.page-card').forEach(card => gridThumbObserver.observe(card));
}

async function generateThumbnailsWithPoppler(filePath) {
    // Verhindere parallele Thumbnail-Generierung
    if (state.thumbnailsGenerating) return;
    state.thumbnailsGenerating = true;

    try {
        const total = state.pages.filter(p => p.sourceFile === filePath).length;
        let dpi = 36;
        if (total > 200) dpi = 24;
        else if (total > 100) dpi = 30;

        gridThumbConfig[filePath] = { dpi, total };

        // Erst sichtbare Seiten laden
        scheduleGridThumbnailLoad();

        // Scroll-Handler einmalig anhängen
        attachGridScrollHandler();

        // Hintergrund-Lader als Fallback: alle 1000ms einen Versuch
        const bgInterval = setInterval(() => {
            const remaining = state.pages.some(p => p.sourceFile === filePath && !p.thumbnail);
            if (!remaining) {
                clearInterval(bgInterval);
                hideThumbnailProgress();
                return;
            }
            scheduleGridThumbnailLoad();
        }, 1000);
    } catch (error) {
        hideThumbnailProgress();
    } finally {
        state.thumbnailsGenerating = false;
    }
}

async function loadGridThumbnail(page, dpi, totalPages) {
    try {
        const url = await schedulePdfPageRender(page, {
            variant: 'grid',
            maxWidth: dpi >= 72 ? 360 : 240,
            priority: 20
        });

        page.thumbnail = url;

        // Update thumbnail in DOM sofort
        const pageEl = document.querySelector(`[data-page-id="${page.id}"] .page-thumbnail`);
        if (pageEl) {
            pageEl.innerHTML = `<img src="${url}" alt="Seite ${page.number}" style="transform: rotate(${page.rotation}deg)">`;
        }

        // Fortschritt aktualisieren
        const loadedCount = state.pages.filter(p => p.sourceFile === page.sourceFile && p.thumbnail).length;
        updateThumbnailProgress(loadedCount, totalPages);
    } catch (error) {
        // stille Fehler – nicht spammen
    }
}

async function loadGridThumbnailBatch(sourceFile, pageNumbers, pages, dpi, totalPages) {
    try {
        await Promise.all(pages.map(async (page, index) => {
            const url = await schedulePdfPageRender(page, {
                variant: 'grid',
                maxWidth: dpi >= 72 ? 360 : 240,
                priority: 30 - index
            });

            page.thumbnail = url;
            const pageEl = document.querySelector(`[data-page-id="${page.id}"] .page-thumbnail`);
            if (pageEl) {
                pageEl.innerHTML = `<img src="${url}" alt="Seite ${page.number}" style="transform: rotate(${page.rotation}deg)">`;
            }
        }));

        const loadedCount = state.pages.filter(p => p.sourceFile === sourceFile && p.thumbnail).length;
        updateThumbnailProgress(loadedCount, totalPages);
    } catch (error) {
        // Fallback to single loading on batch failure
        for (const page of pages) {
            loadGridThumbnail(page, dpi, totalPages);
        }
    }
}

function getVisiblePagesInGridLegacy() {
    const container = document.getElementById('pages-container');
    if (!container) return [];

    const containerRect = container.getBoundingClientRect();
    const visiblePages = [];

    document.querySelectorAll('.page-card').forEach(card => {
        const rect = card.getBoundingClientRect();
        const pageId = card.dataset.pageId;
        const isVisible = rect.bottom > containerRect.top - 200 && rect.top < containerRect.bottom + 200;
        if (!isVisible || !pageId) return;

        const index = pageIndexById.get(pageId);
        if (typeof index === 'number') visiblePages.push({ id: pageId, index });
    });

    return visiblePages;
}

function getGridPagesPerRow(container) {
    const styles = window.getComputedStyle(container);
    const paddingLeft = parseFloat(styles.paddingLeft) || 0;
    const paddingRight = parseFloat(styles.paddingRight) || 0;
    const availableWidth = Math.max(0, container.clientWidth - paddingLeft - paddingRight);
    const slotWidth = gridVirtual.pageWidth + gridVirtual.insertWidth + (gridVirtual.gap * 2);
    return Math.max(1, Math.floor((availableWidth - gridVirtual.insertWidth) / slotWidth));
}

function attachGridVirtualHandlers(container) {
    if (!gridVirtual.scrollAttached) {
        container.addEventListener('scroll', scheduleVirtualPageRender);
        gridVirtual.scrollAttached = true;
    }

    if (!gridVirtual.resizeObserver && 'ResizeObserver' in window) {
        gridVirtual.resizeObserver = new ResizeObserver(() => scheduleVirtualPageRender(true));
        gridVirtual.resizeObserver.observe(container);
    }
}

function scheduleVirtualPageRender(force = false) {
    if (gridVirtual.renderScheduled && !force) return;
    gridVirtual.renderScheduled = true;
    requestAnimationFrame(() => {
        gridVirtual.renderScheduled = false;
        renderVirtualPageRows();
    });
}

function renderVirtualPageRows() {
    const container = document.getElementById('pages-container');
    const inner = gridVirtual.inner;
    if (!container || !inner) return;

    const total = state.pages.length;
    const pagesPerRow = getGridPagesPerRow(container);
    gridVirtual.pagesPerRow = pagesPerRow;

    const rowCount = Math.ceil(total / pagesPerRow);
    inner.style.height = `${rowCount * gridVirtual.rowHeight}px`;
    rebuildGridChapterMarkers();

    if (total === 0) {
        inner.innerHTML = '';
        return;
    }

    const firstRow = Math.max(0, Math.floor(container.scrollTop / gridVirtual.rowHeight) - gridVirtual.overscanRows);
    const lastRow = Math.min(
        rowCount - 1,
        Math.ceil((container.scrollTop + container.clientHeight) / gridVirtual.rowHeight) + gridVirtual.overscanRows
    );

    const fragment = document.createDocumentFragment();
    for (let row = firstRow; row <= lastRow; row++) {
        const startIndex = row * pagesPerRow;
        if (startIndex >= total) break;
        const endIndex = Math.min(total, startIndex + pagesPerRow);
        const rowEl = document.createElement('div');
        rowEl.className = 'pages-virtual-row';
        rowEl.style.transform = `translateY(${row * gridVirtual.rowHeight}px)`;
        rowEl.dataset.row = row;

        rowEl.appendChild(createInsertZone(startIndex));
        for (let index = startIndex; index < endIndex; index++) {
            rowEl.appendChild(createPageCard(state.pages[index], index));
            rowEl.appendChild(createInsertZone(index + 1));
        }
        fragment.appendChild(rowEl);
    }

    inner.innerHTML = '';
    inner.appendChild(fragment);
    updateVisibleChapterMarkerOffsets();
    updateSplitZoneClasses();
    attachGridThumbnailObserver();
    scheduleGridThumbnailLoad();
}

function updateVisibleChapterMarkerOffsets() {
    const container = document.getElementById('pages-container');
    if (!container) return;

    const containerRect = container.getBoundingClientRect();
    if (!containerRect.width) return;

    const safePadding = 10;
    const markers = container.querySelectorAll('.grid-chapter-marker');

    markers.forEach(marker => {
        marker.style.setProperty('--chapter-marker-hover-shift', '0px');

        const markerRect = marker.getBoundingClientRect();
        const centerX = markerRect.left + (markerRect.width / 2);
        const markerStyles = window.getComputedStyle(marker);
        const expandedWidth = parseFloat(markerStyles.getPropertyValue('--chapter-marker-expanded-width')) || 250;

        let shift = 0;
        const desiredLeft = centerX - (expandedWidth / 2);
        const desiredRight = centerX + (expandedWidth / 2);

        if (desiredLeft < containerRect.left + safePadding) {
            shift = (containerRect.left + safePadding) - desiredLeft;
        }

        if (desiredRight + shift > containerRect.right - safePadding) {
            shift += (containerRect.right - safePadding) - (desiredRight + shift);
        }

        marker.style.setProperty('--chapter-marker-hover-shift', `${shift}px`);
    });
}

function renderPages() {
    const container = document.getElementById('pages-container');
    if (!container) return;

    rebuildPageIndexById();

    ++renderPagesToken;
    const previousScrollTop = container.scrollTop;
    container.innerHTML = '';
    container.classList.add('virtualized');

    const inner = document.createElement('div');
    inner.className = 'pages-virtual-spacer';
    container.appendChild(inner);
    gridVirtual.inner = inner;
    container.scrollTop = Math.min(previousScrollTop, Math.max(0, state.pages.length * gridVirtual.rowHeight));

    attachGridVirtualHandlers(container);
    renderVirtualPageRows();
    updateSelectionBar();
    renderSplitPanel();
}

function createPageCard(page, index) {
    const card = document.createElement('div');
    card.className = 'page-card' + (state.selectedPages.has(page.id) ? ' selected' : '');
    card.dataset.pageId = page.id;
    card.draggable = true;
    
    const thumbnailContent = page.thumbnail 
        ? `<img src="${page.thumbnail}" alt="Seite ${index + 1}" style="transform: rotate(${page.rotation}deg)">`
        : index + 1;
    const chapterTitle = getChapterTitle(page);
    const chapterBadge = chapterTitle
        ? `<div class="page-chapter-badge" title="Kapitel: ${escapeHtml(chapterTitle)}"><span>${escapeHtml(chapterTitle)}</span></div>`
        : '';
    
    card.innerHTML = `
        <div class="page-thumbnail-wrapper">
            <div class="page-checkbox ${state.selectedPages.has(page.id) ? 'visible' : ''}">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                    <polyline points="20 6 9 17 4 12"/>
                </svg>
            </div>
            ${chapterBadge}
            <div class="page-thumbnail">${thumbnailContent}</div>
            <div class="page-actions">
                <button class="page-action-btn action-rotate" data-action="rotate-left" title="Links drehen">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M2.5 2v6h6"/>
                        <path d="M2.5 8C5.5 3 11 1.5 16 4s8 9 6 15"/>
                    </svg>
                </button>
                <button class="page-action-btn action-rotate" data-action="rotate-right" title="Rechts drehen">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M21.5 2v6h-6"/>
                        <path d="M21.5 8C18.5 3 13 1.5 8 4S0 13 2 19"/>
                    </svg>
                </button>
                <button class="page-action-btn action-chapter" data-action="chapter" title="Kapitel setzen">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
                    </svg>
                </button>
                <button class="page-action-btn action-duplicate" data-action="duplicate" title="Duplizieren">
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

    return card;
}

function createInsertZone(insertIndex) {
    const chapterMarker = gridChapterMarkersByInsertIndex.get(insertIndex);
    const zone = document.createElement('div');
    zone.className = 'insert-zone' + (chapterMarker ? ' chapter-start' : '');
    zone.dataset.insertIndex = insertIndex;
    const chapterMarkerHtml = chapterMarker ? `
        <div class="grid-chapter-marker" data-source-file="${escapeHtml(chapterMarker.sourceFile)}" data-start-page="${chapterMarker.startPage}" data-end-page="${chapterMarker.endPage || ''}" data-title="${escapeHtml(chapterMarker.title)}" data-target-index="${chapterMarker.targetIndex}">
            <span class="grid-chapter-rail"></span>
            <button class="grid-chapter-jump" title="Zum Kapitel springen">
                <span class="grid-chapter-title">${escapeHtml(chapterMarker.title)}</span>
                <span class="grid-chapter-range">${escapeHtml(chapterMarker.rangeText)}</span>
            </button>
            <button class="grid-chapter-export" title="Kapitel exportieren">Export</button>
        </div>
    ` : '';
    
    zone.innerHTML = `
        ${chapterMarkerHtml}
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

function rebuildGridChapterMarkers() {
    const markers = new Map();
    const files = Array.from(new Set(state.pages.map(page => page.sourceFile)));
    const multipleSources = files.length > 1;

    files.forEach((sourceFile) => {
        const outline = outlineCache[sourceFile];
        if (!Array.isArray(outline) || outline.length === 0) return;

        const sourceMaxPage = getMaxOriginalPageForSource(sourceFile);
        outline.forEach((entry, index) => {
            const startPage = parseOutlinePageNumber(entry?.page);
            if (startPage === null) return;

            const targetIndex = findPageIndexForOutline(sourceFile, startPage);
            if (targetIndex === -1 || markers.has(targetIndex)) return;

            const boundaryPage = findNextOutlineBoundaryPage(outline, index, startPage, null);
            const endPage = boundaryPage !== null ? boundaryPage - 1 : sourceMaxPage;
            const titlePrefix = multipleSources ? `${getBaseName(sourceFile)} · ` : '';
            const title = `${titlePrefix}${entry.title || 'Ohne Titel'}`;

            markers.set(targetIndex, {
                sourceFile,
                startPage,
                endPage,
                title,
                rangeText: formatOutlinePageRange(startPage, endPage),
                targetIndex
            });
        });
    });

    gridChapterMarkersByInsertIndex = markers;
}

function refreshGridChapterMarkers() {
    if (!isEditorScreenActive()) return;
    if (gridVirtual.inner) {
        renderVirtualPageRows();
    }
}

function updateSplitZoneClasses() {
    const points = new Set(getSplitPointsSorted());
    document.querySelectorAll('.insert-zone').forEach(zone => {
        const idx = parseInt(zone.dataset.insertIndex, 10);
        const active = points.has(idx);
        zone.classList.toggle('split-active', active);
    });
}

function updateSplitIndicators() {
    updateSplitZoneClasses();
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

function chaptersForPages(pages) {
    return pages
        .map((page, index) => ({
            title: getChapterTitle(page),
            page: index + 1
        }))
        .filter(chapter => chapter.title);
}

function buildPdfPayloadForPages(pages) {
    const operations = pagesToOperations(pages);
    const chapters = chaptersForPages(pages);
    return chapters.length > 0 ? { operations, chapters } : operations;
}

async function buildPdfForPages(pages, outputPath) {
    return window.pedefo.pdf.buildPDF(buildPdfPayloadForPages(pages), outputPath);
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

function joinFilePath(directory, fileName) {
    const separator = directory.includes('\\') ? '\\' : '/';
    return `${directory.replace(/[\\/]$/, '')}${separator}${fileName}`;
}

function updateSelectionBar() {
    const bar = document.getElementById('selection-bar');
    const count = state.selectedPages.size;
    
    if (count > 0) {
        bar.style.display = 'flex';
        document.getElementById('selection-count').textContent = 
            count === 1 ? '1 Seite ausgewählt' : `${count} Seiten ausgewählt`;
    } else {
        bar.style.display = 'none';
    }

    updateFloatingButtons();
}

function isEditorScreenActive() {
    return document.getElementById('screen-editor')?.classList.contains('active');
}

function updateFloatingButtons() {
    const fullscreenBtn = document.getElementById('btn-fullscreen-view');
    const outlineBtn = document.getElementById('btn-floating-outline');
    const showEditorButtons = isEditorScreenActive() && state.pages.length > 0;

    if (fullscreenBtn) {
        fullscreenBtn.style.display = showEditorButtons && state.selectedPages.size > 0 ? 'flex' : 'none';
    }

    if (outlineBtn) {
        outlineBtn.style.display = showEditorButtons ? 'flex' : 'none';
    }

    if (!showEditorButtons) {
        hideFloatingOutlinePanel();
    }
}

function focusGridPage(index) {
    const page = state.pages[index];
    if (!page) return;

    state.lastFocusedPageId = page.id;
    state.selectedPages.clear();
    state.selectedPages.add(page.id);
    updatePageSelectionUI();
    updateSelectionBar();

    requestAnimationFrame(() => {
        const container = document.getElementById('pages-container');
        if (container?.classList.contains('virtualized')) {
            const pagesPerRow = Math.max(1, gridVirtual.pagesPerRow || getGridPagesPerRow(container));
            const targetRow = Math.floor(index / pagesPerRow);
            container.scrollTo({ top: targetRow * gridVirtual.rowHeight, behavior: 'smooth' });
            scheduleVirtualPageRender(true);
        }

        const card = document.querySelector(`.page-card[data-page-id="${page.id}"]`);
        if (card) {
            card.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
        }
    });
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

    panel.innerHTML = `
        <div class="split-panel-header">
            <div>
                <div class="split-panel-title">PDF teilen</div>
                <div class="split-panel-subtitle">${parts.length} Teile vorbereitet</div>
            </div>
            <button class="split-export-all">Alle exportieren</button>
        </div>
        ${list}
    `;

    panel.querySelector('.split-export-all')?.addEventListener('click', async () => {
        const partsNow = computeSplitParts();
        await exportAllSplitParts(partsNow, baseName);
    });

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

function getSplitPartFileName(baseName, number) {
    return `${baseName}_Teil${number}.pdf`;
}

async function exportSplitPart(part, number, baseName) {
    const pages = state.pages.slice(part.start, part.end);
    if (pages.length === 0) {
        showToast('Teil ist leer', 'error');
        return;
    }

    const defaultName = getSplitPartFileName(baseName, number);
    const output = await window.pedefo.saveFile(defaultName);
    if (!output) return;

    showLoading('Teil wird exportiert...');
    try {
        const res = await buildPdfForPages(pages, output);
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

async function exportAllSplitParts(parts, baseName) {
    if (!parts || parts.length <= 1) {
        showToast('Keine Teilung vorbereitet', 'error');
        return;
    }

    const output = await window.pedefo.saveZipFile(`${baseName}_Teile.zip`);
    if (!output) return;

    let tempDir = null;
    showLoading('Exportiere alle Teile...', {
        progress: true,
        percent: 0,
        detail: 'Bereite ZIP-Export vor...'
    });

    try {
        tempDir = await window.pedefo.file.createTempDir('pedefo-split');
        const entries = [];

        for (let index = 0; index < parts.length; index++) {
            const part = parts[index];
            const pages = state.pages.slice(part.start, part.end);
            if (pages.length === 0) {
                throw new Error(`Teil ${index + 1} ist leer`);
            }

            const fileName = getSplitPartFileName(baseName, index + 1);
            const tempOutput = joinFilePath(tempDir, fileName);
            setLoadingProgress(Math.round((index / parts.length) * 85), `Teil ${index + 1} von ${parts.length} wird erstellt...`);

            const result = await buildPdfForPages(pages, tempOutput);
            if (!result.success) {
                throw new Error(result.message || `Teil ${index + 1} konnte nicht exportiert werden`);
            }

            entries.push({ name: fileName, path: tempOutput });
        }

        setLoadingProgress(92, 'ZIP-Archiv wird erstellt...');
        const zipResult = await window.pedefo.archive.createZip(entries, output);
        if (!zipResult.success) {
            throw new Error(zipResult.message || 'ZIP-Archiv konnte nicht erstellt werden');
        }

        showToast(`${parts.length} Teile als ZIP exportiert`, 'success');
    } catch (error) {
        showToast(error.message, 'error');
    } finally {
        if (tempDir) {
            await window.pedefo.file.removeTempPath(tempDir);
        }
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
    if (action === 'chapter') {
        openChapterModalForPage(pageId);
        return;
    }

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

function getChapterTargetPageId() {
    if (state.selectedPages.size > 0) {
        const selectedPage = state.pages.find(page => state.selectedPages.has(page.id));
        return selectedPage?.id || null;
    }

    const readerScreen = document.getElementById('screen-reader');
    if (readerScreen?.classList.contains('active') && state.pages[readerCurrentPage]) {
        return state.pages[readerCurrentPage].id;
    }

    if (state.lastFocusedPageId && pageIndexById.has(state.lastFocusedPageId)) {
        return state.lastFocusedPageId;
    }

    return state.pages[0]?.id || null;
}

function openChapterModalForCurrentPage() {
    const pageId = getChapterTargetPageId();
    if (!pageId) {
        showToast('Keine Seite für ein Kapitel verfügbar', 'error');
        return;
    }
    openChapterModalForPage(pageId);
}

function openChapterModalForPage(pageId) {
    const pageIndex = state.pages.findIndex(p => p.id === pageId);
    if (pageIndex === -1) {
        showToast('Seite nicht gefunden', 'error');
        return;
    }

    const page = state.pages[pageIndex];
    state.editingChapterPageId = pageId;
    populateChapterPageSelect(pageId);
    document.getElementById('chapter-page-label').textContent = `Kapitel startet auf Seite ${pageIndex + 1}.`;
    const input = document.getElementById('chapter-title');
    input.value = getChapterTitle(page);
    input.dataset.loadedTitle = input.value;
    input.dataset.loadedPageId = page.id;
    updateChapterRemoveButton();
    showModal('chapter');
    setTimeout(() => {
        input.focus();
        input.select();
    }, 0);
}

function populateChapterPageSelect(selectedPageId) {
    const select = document.getElementById('chapter-page-select');
    if (!select) return;

    select.innerHTML = '';
    state.pages.forEach((page, index) => {
        const option = document.createElement('option');
        option.value = page.id;
        const chapterTitle = getChapterTitle(page);
        option.textContent = chapterTitle
            ? `Seite ${index + 1} · ${chapterTitle}`
            : `Seite ${index + 1}`;
        select.appendChild(option);
    });
    select.value = selectedPageId;
}

function getSelectedChapterPage() {
    const select = document.getElementById('chapter-page-select');
    const pageId = select?.value || state.editingChapterPageId;
    return state.pages.find(page => page.id === pageId) || null;
}

function updateChapterRemoveButton() {
    const page = getSelectedChapterPage();
    const removeBtn = document.getElementById('btn-chapter-remove');
    if (removeBtn) {
        removeBtn.style.visibility = getChapterTitle(page) ? 'visible' : 'hidden';
    }
}

function handleChapterPageSelectChange() {
    const page = getSelectedChapterPage();
    if (!page) return;

    const pageIndex = state.pages.findIndex(p => p.id === page.id);
    state.editingChapterPageId = page.id;
    document.getElementById('chapter-page-label').textContent = `Kapitel startet auf Seite ${pageIndex + 1}.`;

    const input = document.getElementById('chapter-title');
    if (input) {
        const loadedTitle = input.dataset.loadedTitle || '';
        const shouldReplaceTitle = !input.value.trim() || input.value.trim() === loadedTitle;
        const nextTitle = getChapterTitle(page);
        if (shouldReplaceTitle) {
            input.value = nextTitle;
        }
        input.dataset.loadedTitle = nextTitle;
        input.dataset.loadedPageId = page.id;
    }
    updateChapterRemoveButton();
}

function refreshChapterViews() {
    renderPages();
    renderOutlinePanel();
    renderViewerOutline();
    renderFloatingOutline();
    updateViewerActions();
    if (document.getElementById('screen-reader')?.classList.contains('active')) {
        renderReaderThumbnails();
    }
}

function saveChapterFromModal() {
    const page = getSelectedChapterPage();
    if (!page) {
        hideModal();
        return;
    }

    const title = document.getElementById('chapter-title').value.trim();
    page.chapterTitle = title;
    state.isDirty = true;
    hideModal();
    refreshChapterViews();
    showToast(title ? 'Kapitel gesetzt' : 'Kapitel entfernt', 'success');
}

function removeChapterFromModal() {
    const page = getSelectedChapterPage();
    if (!page) {
        hideModal();
        return;
    }

    page.chapterTitle = '';
    state.isDirty = true;
    hideModal();
    refreshChapterViews();
    showToast('Kapitel entfernt', 'success');
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
                id: `page-dup-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                chapterTitle: ''
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
let pageGridDelegatedEventsAttached = false;

function clearInsertZoneDragState() {
    document.querySelectorAll('.insert-zone').forEach(zone => {
        zone.classList.remove('drag-active', 'drag-over');
    });
}

function setEditorFileDragState(active) {
    document.getElementById('pages-container')?.classList.toggle('file-dragover', active);
    document.querySelectorAll('.insert-zone').forEach(zone => {
        zone.classList.toggle('drag-active', active);
        if (!active) zone.classList.remove('drag-over');
    });
}

function getGridInsertZone(target) {
    const container = document.getElementById('pages-container');
    const zone = target?.closest?.('.insert-zone');
    return zone && container?.contains(zone) ? zone : null;
}

function getInsertIndexFromZone(zone) {
    return Math.max(0, Math.min(parseInt(zone?.dataset?.insertIndex, 10) || 0, state.pages.length));
}

function setupPageGridDelegatedEvents() {
    if (pageGridDelegatedEventsAttached) return;
    const container = document.getElementById('pages-container');
    if (!container) return;

    container.addEventListener('click', handlePageGridClick);
    container.addEventListener('dragstart', handlePageGridDragStart);
    container.addEventListener('dragend', handlePageGridDragEnd);
    container.addEventListener('dragover', handlePageGridDragOver);
    container.addEventListener('dragleave', handlePageGridDragLeave);
    container.addEventListener('drop', handlePageGridDrop);
    pageGridDelegatedEventsAttached = true;
}

async function handlePageGridClick(e) {
    const chapterExportButton = e.target.closest('.grid-chapter-export');
    if (chapterExportButton) {
        const marker = chapterExportButton.closest('.grid-chapter-marker');
        if (!marker) return;
        e.preventDefault();
        e.stopPropagation();
        await extractOutlineChapter(
            marker.dataset.sourceFile,
            marker.dataset.startPage,
            marker.dataset.endPage,
            marker.dataset.title
        );
        return;
    }

    const chapterJumpButton = e.target.closest('.grid-chapter-jump');
    if (chapterJumpButton) {
        const marker = chapterJumpButton.closest('.grid-chapter-marker');
        const targetIndex = parseInt(marker?.dataset?.targetIndex, 10);
        if (Number.isNaN(targetIndex)) return;
        e.preventDefault();
        e.stopPropagation();
        focusGridPage(targetIndex);
        return;
    }

    const insertButton = e.target.closest('.insert-btn');
    if (insertButton) {
        const zone = getGridInsertZone(insertButton);
        if (!zone) return;
        e.preventDefault();
        e.stopPropagation();
        await insertPDFAt(getInsertIndexFromZone(zone));
        return;
    }

    const splitButton = e.target.closest('.insert-split-btn');
    if (splitButton) {
        const zone = getGridInsertZone(splitButton);
        if (!zone) return;
        e.preventDefault();
        e.stopPropagation();
        toggleSplitPoint(getInsertIndexFromZone(zone));
        return;
    }

    const actionButton = e.target.closest('.page-action-btn');
    if (actionButton) {
        const card = actionButton.closest('.page-card');
        if (!card) return;
        e.preventDefault();
        e.stopPropagation();
        handlePageAction(actionButton.dataset.action, card.dataset.pageId);
        return;
    }

    const checkbox = e.target.closest('.page-checkbox');
    if (checkbox) {
        const card = checkbox.closest('.page-card');
        if (!card) return;
        e.stopPropagation();
        togglePageSelection(card.dataset.pageId);
        return;
    }

    const card = e.target.closest('.page-card');
    if (!card || e.target.closest('.page-actions')) return;

    const pageId = card.dataset.pageId;
    const currentIndex = pageIndexById.get(pageId);
    if (typeof currentIndex !== 'number') return;

    state.lastFocusedPageId = pageId;

    if (e.shiftKey && state.selectedPages.size > 0) {
        const lastSelected = Array.from(state.selectedPages).pop();
        const lastIndex = pageIndexById.get(lastSelected);
        if (typeof lastIndex !== 'number') {
            togglePageSelection(pageId);
            return;
        }

        const [start, end] = [Math.min(lastIndex, currentIndex), Math.max(lastIndex, currentIndex)];
        for (let i = start; i <= end; i++) {
            state.selectedPages.add(state.pages[i].id);
        }
        updatePageSelectionUI();
        updateSelectionBar();
    } else {
        togglePageSelection(pageId);
    }
}

function handlePageGridDragStart(e) {
    const card = e.target.closest('.page-card');
    if (!card) return;

    draggedPageId = card.dataset.pageId;
    e.dataTransfer.setData('text/plain', draggedPageId);
    e.dataTransfer.effectAllowed = 'move';

    setTimeout(() => {
        if (!draggedPageId) return;
        card.classList.add('dragging');
        document.querySelectorAll('.insert-zone').forEach(zone => {
            zone.classList.add('drag-active');
        });
    }, 0);
}

function handlePageGridDragEnd(e) {
    e.target.closest('.page-card')?.classList.remove('dragging');
    draggedPageId = null;
    clearInsertZoneDragState();
}

function handlePageGridDragOver(e) {
    const zone = getGridInsertZone(e.target);
    if (!zone || (!draggedPageId && !isExternalFileDrag(e))) return;

    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = isExternalFileDrag(e) ? 'copy' : 'move';

    document.querySelectorAll('.insert-zone.drag-over').forEach(activeZone => {
        if (activeZone !== zone) activeZone.classList.remove('drag-over');
    });
    zone.classList.add('drag-over');
}

function handlePageGridDragLeave(e) {
    const zone = getGridInsertZone(e.target);
    if (!zone) return;
    if (!zone.contains(e.relatedTarget)) {
        zone.classList.remove('drag-over');
    }
}

async function handlePageGridDrop(e) {
    const zone = getGridInsertZone(e.target);
    if (!zone || (!draggedPageId && !isExternalFileDrag(e))) return;

    e.preventDefault();
    e.stopPropagation();
    if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
    zone.classList.remove('drag-over');

    const insertIndex = getInsertIndexFromZone(zone);
    const droppedPdfPaths = getPdfFilePathsFromDataTransfer(e.dataTransfer);
    if (droppedPdfPaths.length > 0 || isExternalFileDrag(e)) {
        setEditorFileDragState(false);
        if (droppedPdfPaths.length === 0) {
            showToast('Bitte eine PDF-Datei auswählen', 'error');
        } else {
            await insertPdfFilesAt(droppedPdfPaths, insertIndex);
        }
        clearInsertZoneDragState();
        return;
    }

    const draggedId = e.dataTransfer.getData('text/plain');
    const draggedIndex = state.pages.findIndex(p => p.id === draggedId);
    if (draggedIndex !== -1) {
        let targetIndex = insertIndex;
        if (draggedIndex < targetIndex) {
            targetIndex--;
        }

        if (draggedIndex !== targetIndex) {
            const [removed] = state.pages.splice(draggedIndex, 1);
            state.pages.splice(targetIndex, 0, removed);
            clampSplitPoints();
            state.isDirty = true;
            renderPages();
            showToast('Seite verschoben', 'info');
        }
    }

    clearInsertZoneDragState();
}

// ============================================
// Insert PDF
// ============================================

async function insertPDFAt(insertIndex) {
    const files = await window.pedefo.openFiles();
    if (!files || files.length === 0) return;

    await insertPdfFilesAt(files, insertIndex);
}

async function insertPdfFilesAt(files, insertIndex) {
    const filePaths = normalizePdfFilePaths(files);
    if (filePaths.length === 0) {
        showToast('Bitte eine PDF-Datei auswählen', 'error');
        return false;
    }

    const safeInsertIndex = Math.max(0, Math.min(Number(insertIndex) || 0, state.pages.length));
    const loadingText = filePaths.length === 1 ? 'Füge PDF ein...' : 'Füge PDFs ein...';
    const insertedSources = [];
    let totalPageCount = 0;

    showLoading(loadingText);

    try {
        const batchId = Date.now();
        const newPages = [];

        for (let fileIndex = 0; fileIndex < filePaths.length; fileIndex++) {
            const filePath = filePaths[fileIndex];
            const pageCount = await getPdfPageCount(filePath);
            totalPageCount += pageCount;
            insertedSources.push({ filePath, pageCount });

            for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
                newPages.push({
                    id: `page-insert-${batchId}-${fileIndex}-${pageNumber}`,
                    number: pageNumber,
                    originalNumber: pageNumber,
                    sourceFile: filePath,
                    rotation: 0,
                    thumbnail: null,
                    chapterTitle: ''
                });
            }
        }
        
        state.pages.splice(safeInsertIndex, 0, ...newPages);
        clampSplitPoints();
        state.isDirty = true;
        
        renderPages();
        updateStatusBar();
        hideLoading();
        
        for (const source of insertedSources) {
            await generateThumbnailsForPages(source.filePath, safeInsertIndex, source.pageCount);
        }
        
        const pageLabel = totalPageCount === 1 ? 'Seite' : 'Seiten';
        const sourceLabel = filePaths.length > 1 ? ` aus ${filePaths.length} PDFs` : '';
        showToast(`${totalPageCount} ${pageLabel}${sourceLabel} eingefügt`, 'success');
        return true;
        
    } catch (error) {
        showToast(error.message, 'error');
        return false;
    } finally {
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
        const total = state.pages.filter(p => p.sourceFile === filePath).length;
        let dpi = 36;
        if (total > 200) dpi = 24;
        else if (total > 100) dpi = 30;

        gridThumbConfig[filePath] = { dpi, total };
        attachGridScrollHandler();
        scheduleGridThumbnailLoad();
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
        const result = await buildPdfForPages(state.pages, outputPath);
        
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
        const pagesToExtract = state.pages.slice(start - 1, end);
        const result = await buildPdfForPages(pagesToExtract, outputPath);
        
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
    updateGhostscriptNotice();
}

async function updateGhostscriptNotice() {
    const notice = document.getElementById('ghostscript-notice');
    const downloadBtn = document.getElementById('btn-ghostscript-download');
    if (!notice || !downloadBtn) return;

    // Avoid stacking multiple listeners if modal opened repeatedly
    if (!downloadBtn.dataset.bound) {
        downloadBtn.dataset.bound = '1';
        downloadBtn.addEventListener('click', async () => {
            const url = 'https://ghostscript.com/releases/gsdnld.html';
            const res = await window.pedefo.system.openExternal(url);
            if (!res?.success) {
                showToast(res?.message || 'Konnte Browser nicht öffnen', 'error');
            }
        });
    }

    try {
        const result = await window.pedefo.system.checkGhostscript();
        if (result?.success) {
            notice.style.display = 'none';
        } else {
            notice.style.display = 'block';
        }
    } catch (_) {
        // If the check fails, show the notice (better to guide than to stay silent)
        notice.style.display = 'block';
    }
}

async function compressPDF() {
    const quality = document.querySelector('input[name="compress-quality"]:checked').value;
    
    hideModal();
    
    const outputPath = await window.pedefo.saveFile('komprimiert.pdf');
    if (!outputPath) return;
    
    const operationId = `compress-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let stopProgressListener = null;

    showLoading('Komprimiere PDF...', {
        progress: true,
        percent: 5,
        detail: 'Wird vorbereitet...'
    });

    if (window.pedefo.pdf.onCompressProgress) {
        stopProgressListener = window.pedefo.pdf.onCompressProgress((progress) => {
            if (progress?.operationId && progress.operationId !== operationId) return;
            setLoadingProgress(progress.percent, progress.message || 'Wird verarbeitet...');
        });
    }
    
    try {
        // First save current state, then compress
        const tempPath = /\.pdf$/i.test(outputPath)
            ? outputPath.replace(/\.pdf$/i, '_temp.pdf')
            : `${outputPath}_temp.pdf`;
        const hasCustomChapters = chaptersForPages(state.pages).length > 0;
        
        // If only one source file and no modifications, compress directly
        const sourceFile = state.pages.length > 0 && 
            !hasCustomChapters &&
            state.pages.every(p => p.sourceFile === state.pages[0].sourceFile && p.rotation === 0)
            ? state.pages[0].sourceFile
            : null;
        
        let result;
        if (sourceFile && !state.isDirty) {
            result = await window.pedefo.pdf.compress(sourceFile, outputPath, quality, operationId);
        } else {
            // Build temp file first, then compress
            setLoadingProgress(8, 'Aktuelles PDF wird vorbereitet...');
            await buildPdfForPages(state.pages, tempPath);
            setLoadingProgress(12, 'Kompression startet...');
            result = await window.pedefo.pdf.compress(tempPath, outputPath, quality, operationId);
        }
        
        if (result.success) {
            const reduction = (typeof result.data?.reduction_percent === 'number')
                ? result.data.reduction_percent
                : null;
            const originalMb = result.data?.original_size_mb;
            const newMb = result.data?.new_size_mb;
            const msg = result.message || '';

            if (reduction === null) {
                showToast('PDF komprimiert', 'success');
            } else if (reduction > 0) {
                showToast(`PDF komprimiert (${reduction}% kleiner)`, 'success');
            } else {
                const sizeText = (typeof originalMb === 'number' && typeof newMb === 'number')
                    ? ` (${originalMb}→${newMb} MB)`
                    : '';
                const gsHint = /ghostscript/i.test(msg) ? ' – Ghostscript nicht verfügbar' : '';
                showToast(`Keine Größenreduktion erzielt${sizeText}${gsHint}`, 'info');
            }
        } else {
            throw new Error(result.message);
        }
        
    } catch (error) {
        showToast(error.message, 'error');
    } finally {
        if (typeof stopProgressListener === 'function') {
            stopProgressListener();
        }
        hideLoading();
    }
}

function getDirectCurrentSourceFile() {
    if (state.pages.length === 0 || state.isDirty || chaptersForPages(state.pages).length > 0) {
        return null;
    }

    const sourceFile = state.pages[0].sourceFile;
    const isUnmodifiedSingleSource = state.pages.every(page => (
        page.sourceFile === sourceFile &&
        page.rotation === 0
    ));

    return isUnmodifiedSingleSource ? sourceFile : null;
}

function joinTempPath(dir, fileName) {
    const separator = dir.includes('\\') ? '\\' : '/';
    return `${dir}${separator}${fileName}`;
}

function formatOcrError(result) {
    const missingLanguages = result?.data?.missing_languages;
    if (Array.isArray(missingLanguages) && missingLanguages.length > 0) {
        return `OCR-Sprachdaten fehlen: ${missingLanguages.join(', ')}. Für deutsche Umlaute bitte Tesseract mit Deutsch-Sprachdaten installieren.`;
    }

    const missing = result?.data?.missing;
    if (Array.isArray(missing) && missing.length > 0) {
        return `OCR nicht verfügbar: ${missing.join(', ')} fehlt.`;
    }
    return result?.message || 'OCR konnte nicht gestartet werden';
}

async function runOCRForCurrentPDF() {
    if (!state.currentFile || state.pages.length === 0) {
        showToast('Keine PDF für OCR geladen', 'error');
        return;
    }

    const defaultName = `${getFileBaseName(state.currentFile)}-ocr.pdf`;
    const outputPath = await window.pedefo.saveFile(defaultName);
    if (!outputPath) return;

    const operationId = `ocr-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let stopProgressListener = null;
    let tempDir = null;
    let loadOutput = false;

    showLoading('OCR wird ausgeführt...', {
        progress: true,
        percent: 2,
        detail: 'OCR-Verfügbarkeit wird geprüft...'
    });

    if (window.pedefo.pdf.onOcrProgress) {
        stopProgressListener = window.pedefo.pdf.onOcrProgress((progress) => {
            if (progress?.operationId && progress.operationId !== operationId) return;
            setLoadingProgress(progress.percent, progress.message || 'OCR läuft...');
        });
    }

    try {
        state.ocr.running = true;
        updateOcrControls();

        const availability = await window.pedefo.pdf.checkOCR('deu');
        if (!availability.success) {
            throw new Error(formatOcrError(availability));
        }

        let sourceFile = getDirectCurrentSourceFile();
        if (!sourceFile) {
            setLoadingProgress(6, 'Aktuelle Änderungen werden für OCR vorbereitet...');
            tempDir = await window.pedefo.file.createTempDir('pedefo-ocr');
            sourceFile = joinTempPath(tempDir, 'ocr-source.pdf');
            const buildResult = await buildPdfForPages(state.pages, sourceFile);
            if (!buildResult.success) {
                throw new Error(buildResult.message || 'Temporäre PDF konnte nicht erstellt werden');
            }
        }

        setLoadingProgress(10, 'OCR startet...');
        const result = await window.pedefo.pdf.ocr(sourceFile, outputPath, 'deu', operationId);
        if (!result.success) {
            throw new Error(result.message || 'OCR fehlgeschlagen');
        }

        loadOutput = true;
        showToast('OCR-PDF erstellt und geladen', 'success');
    } catch (error) {
        showToast(error.message, 'error');
    } finally {
        if (typeof stopProgressListener === 'function') {
            stopProgressListener();
        }
        if (tempDir) {
            await window.pedefo.file.removeTempPath(tempDir);
        }
        state.ocr.running = false;
        updateOcrControls();
        hideLoading();
    }

    if (loadOutput) {
        if (document.getElementById('page-viewer').style.display === 'flex') {
            closePageViewer();
        }
        await loadPDF(outputPath);
    }
}

// ============================================
// New File
// ============================================

function resetCurrentDocument() {
    // Close page viewer if open
    if (document.getElementById('page-viewer').style.display === 'flex') {
        closePageViewer();
    }
    hideFloatingOutlinePanel();
    
    state.currentFile = null;
    state.pages = [];
    state.selectedPages.clear();
    state.splitPoints = [];
    state.lastFocusedPageId = null;
    state.editingChapterPageId = null;
    state.isDirty = false;
    resetOcrState();
    pageIndexById = new Map();
    
    document.getElementById('current-file-name').textContent = '';
    document.getElementById('pages-container').innerHTML = '';
    
    showScreen('screen-upload');
}

function newFile() {
    if (state.isDirty) {
        showModal('new-file');
        return;
    }

    resetCurrentDocument();
}

function confirmNewFileDiscard() {
    hideModal();
    resetCurrentDocument();
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
let expandedOutlineKeys = new Set();
let floatingOutlineOpen = false;
let readerNavToken = 0;            // increments on each page navigation; used to ignore stale async updates

function scrollReaderThumbToIndex(index, behavior = 'auto') {
    const container = document.getElementById('reader-thumbnails');
    if (!container) return;
    const el = container.querySelector(`.reader-thumb[data-index="${index}"]`);
    if (el) {
        el.scrollIntoView({ behavior, block: 'center', inline: 'nearest' });
    }
}

async function openReaderView(startPageIndex = 0) {
    readerCurrentPage = startPageIndex;
    
    // Thumbnails für die Sidebar rendern
    renderReaderThumbnails();
    
    // Aktuelle Seite SOFORT mit Low-Res anzeigen
    showReaderPage(readerCurrentPage);
    
    // Screen wechseln (keine Verzögerung mehr!)
    showScreen('screen-reader');

    // Nach Screen-Wechsel sicher zum Fokus-Thumbnail scrollen (sonst lädt es oft oben)
    requestAnimationFrame(() => scrollReaderThumbToIndex(readerCurrentPage, 'auto'));

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

        const chapterTitle = getChapterTitle(page);
        if (chapterTitle) {
            thumb.classList.add('has-chapter');
            thumb.title = `Kapitel: ${chapterTitle}`;
            const chapterMarker = document.createElement('span');
            chapterMarker.className = 'reader-thumb-chapter';
            chapterMarker.textContent = 'Kapitel';
            thumb.appendChild(chapterMarker);
        }
        
        thumb.addEventListener('click', () => {
            showReaderPage(index);
        });
        
        container.appendChild(thumb);
        
        // Insert zone after each page
        container.appendChild(createReaderInsertZone(index + 1));
    });

    // Outline-Panel mit aktueller Reihenfolge synchronisieren
    renderOutlinePanel();

    // Reader-Thumb Lazy-Loading mit IntersectionObserver
    attachReaderThumbObserver();
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

function attachReaderThumbObserver() {
    const container = document.getElementById('reader-thumbnails');
    if (!container) return;

    // Reset existing observer
    if (readerThumbObserver) {
        readerThumbObserver.disconnect();
        readerThumbObserver = null;
    }
    readerVisibleIndices = new Set();

    if (!('IntersectionObserver' in window)) {
        attachReaderThumbScrollHandler();
        return;
    }

    readerThumbObserver = new IntersectionObserver(
        (entries) => {
            let changed = false;
            for (const entry of entries) {
                const idx = parseInt(entry.target?.dataset?.index, 10);
                if (Number.isNaN(idx)) continue;
                if (entry.isIntersecting) {
                    if (!readerVisibleIndices.has(idx)) {
                        readerVisibleIndices.add(idx);
                        changed = true;
                    }
                } else {
                    if (readerVisibleIndices.delete(idx)) changed = true;
                }
            }
            if (changed) scheduleReaderThumbLoad();
        },
        {
            root: container,
            rootMargin: '600px 0px',
            threshold: 0.01
        }
    );

    document.querySelectorAll('.reader-thumb').forEach(el => readerThumbObserver.observe(el));
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
    // Fast path: use IntersectionObserver tracking
    if (readerThumbObserver && readerVisibleIndices.size > 0) {
        return Array.from(readerVisibleIndices).sort((a, b) => a - b);
    }

    // Fallback: scan DOM (slower)
    const container = document.getElementById('reader-thumbnails');
    if (!container) return [];
    const containerRect = container.getBoundingClientRect();
    const buffer = 600;
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

    // Prioritize around current reader page
    const center = readerCurrentPage;
    visible.sort((a, b) => {
        const da = Math.abs(a - center);
        const db = Math.abs(b - center);
        if (da !== db) return da - db;
        return a - b;
    });

    // Collect pages to load (up to 12)
    const toLoad = [];
    for (const idx of visible) {
        if (toLoad.length >= 12) break;
        const page = state.pages[idx];
        if (!page) continue;
        if (readerThumbLoading.has(page.id)) continue;

        // Check if already loaded
        const thumbWrapper = document.querySelector(`.reader-thumb[data-index="${idx}"]`);
        const imgEl = thumbWrapper?.querySelector('img');
        if (imgEl && imgEl.src && (imgEl.src.startsWith('data:') || imgEl.src.startsWith('blob:'))) continue;

        toLoad.push({ page, idx });
    }

    if (toLoad.length === 0) return;

    // Group by sourceFile for batch loading
    const bySource = {};
    for (const item of toLoad) {
        const key = item.page.sourceFile;
        if (!bySource[key]) bySource[key] = [];
        bySource[key].push(item);
        readerThumbLoading.add(item.page.id);
    }

    for (const [sourceFile, items] of Object.entries(bySource)) {
        const pageNumbers = items.map(i => i.page.originalNumber);
        const dpi = getThumbDpiForSource(sourceFile);
        loadReaderThumbnailBatch(sourceFile, pageNumbers, items, dpi)
            .finally(() => items.forEach(i => readerThumbLoading.delete(i.page.id)));
    }
}

async function loadReaderThumbnail(page, dpi) {
    try {
        const url = await schedulePdfPageRender(page, {
            variant: 'reader-thumb',
            maxWidth: dpi >= 72 ? 360 : 240,
            priority: 15
        });
        if (!page.thumbnail) page.thumbnail = url;

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
            imgEl.src = url;
            imgEl.style.transform = `rotate(${page.rotation}deg)`;
            imgEl.alt = `Seite ${idx + 1}`;
        }
    } catch (error) {
        console.error(`Error loading reader thumbnail for page ${page.originalNumber}:`, error);
    }
}

async function loadReaderThumbnailBatch(sourceFile, pageNumbers, items, dpi) {
    try {
        await Promise.all(items.map(async ({ page, idx }, itemIndex) => {
            const url = await schedulePdfPageRender(page, {
                variant: 'reader-thumb',
                maxWidth: dpi >= 72 ? 360 : 240,
                priority: 18 - itemIndex
            });
            if (!page.thumbnail) page.thumbnail = url;

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
                imgEl.src = url;
                imgEl.style.transform = `rotate(${page.rotation}deg)`;
                imgEl.alt = `Seite ${idx + 1}`;
            }
        }));
    } catch (error) {
        // Fallback to single loading
        for (const { page } of items) {
            loadReaderThumbnail(page, dpi);
        }
    }
}

function findPageIndexForOutline(sourceFile, pageNumber) {
    if (pageNumber === null || pageNumber === undefined) return -1;
    const pageNum = parseInt(pageNumber, 10);
    if (Number.isNaN(pageNum)) return -1;
    return state.pages.findIndex(p => p.sourceFile === sourceFile && p.originalNumber === pageNum);
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
    renderFloatingOutline();
    refreshGridChapterMarkers();
}

function getCustomChapterEntries() {
    return state.pages
        .map((page, index) => ({
            title: getChapterTitle(page),
            page: index + 1,
            targetIndex: index
        }))
        .filter(entry => entry.title);
}

function hasCollapsibleOutlineChildren(item, depth) {
    return depth === 0 && Array.isArray(item?.children) && item.children.length > 0;
}

function getOutlineCollapseKey(sourceFile, item, depth, index, pageNumber) {
    const title = (item?.title || '').trim();
    return `${sourceFile}|${depth}|${index}|${pageNumber ?? 'no-page'}|${title}`;
}

function createOutlineToggleButton(className, isCollapsed, onToggle) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.classList.toggle('is-expanded', !isCollapsed);
    button.title = isCollapsed ? 'Unterkapitel ausklappen' : 'Unterkapitel einklappen';
    button.setAttribute('aria-label', button.title);
    button.setAttribute('aria-expanded', String(!isCollapsed));
    button.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="9 18 15 12 9 6"/>
        </svg>
    `;
    button.addEventListener('click', (event) => {
        event.stopPropagation();
        onToggle();
    });
    return button;
}

function toggleOutlineCollapse(key) {
    if (expandedOutlineKeys.has(key)) {
        expandedOutlineKeys.delete(key);
    } else {
        expandedOutlineKeys.add(key);
    }

    renderOutlinePanel();
    renderViewerOutline();
    renderFloatingOutline();
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

    const customChapters = getCustomChapterEntries();
    if (customChapters.length > 0) {
        hasEntries = true;
        const sourceLabel = document.createElement('div');
        sourceLabel.className = 'reader-outline-source';
        sourceLabel.textContent = 'Eigene Kapitel';
        body.appendChild(sourceLabel);
        appendCustomOutlineItems(customChapters, body);
    }

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

        appendOutlineItems(outline, filePath, body, 0);
    });

    if (!hasEntries) {
        body.appendChild(placeholder);
    } else {
        highlightOutlineForPage(readerCurrentPage);
    }
}

function appendCustomOutlineItems(entries, container) {
    entries.forEach((entry, index) => {
        const item = document.createElement('div');
        item.className = 'outline-item outline-item-custom';
        item.dataset.targetIndex = entry.targetIndex;

        const titleSpan = document.createElement('span');
        titleSpan.className = 'outline-title';
        titleSpan.textContent = entry.title;

        const pageSpan = document.createElement('span');
        pageSpan.className = 'outline-page';
        pageSpan.textContent = formatOutlinePageRange(entry.page, getCustomChapterEndPage(entries, index));

        item.addEventListener('click', () => showReaderPage(entry.targetIndex));
        item.appendChild(titleSpan);
        item.appendChild(pageSpan);
        container.appendChild(item);
    });
}

function appendOutlineItems(entries, sourceFile, container, depth, parentBoundaryPage = null) {
    const sourceMaxPage = getMaxOriginalPageForSource(sourceFile);

    entries.forEach((entry, index) => {
        const item = document.createElement('div');
        item.className = 'outline-item';
        item.style.paddingLeft = `${12 + depth * 14}px`;

        const itemPage = parseOutlinePageNumber(entry.page);
        const canCollapse = hasCollapsibleOutlineChildren(entry, depth);
        const collapseKey = getOutlineCollapseKey(sourceFile, entry, depth, index, itemPage);
        const isCollapsed = canCollapse && !expandedOutlineKeys.has(collapseKey);
        const boundaryPage = itemPage !== null
            ? findNextOutlineBoundaryPage(entries, index, itemPage, parentBoundaryPage)
            : parentBoundaryPage;
        const endPage = boundaryPage !== null ? boundaryPage - 1 : sourceMaxPage;

        if (canCollapse) {
            item.appendChild(createOutlineToggleButton('outline-toggle', isCollapsed, () => {
                toggleOutlineCollapse(collapseKey);
            }));
        }

        const titleSpan = document.createElement('span');
        titleSpan.className = 'outline-title';
        titleSpan.textContent = entry.title || 'Ohne Titel';

        const pageSpan = document.createElement('span');
        pageSpan.className = 'outline-page';
        pageSpan.textContent = formatOutlinePageRange(itemPage, endPage);

        const targetIndex = findPageIndexForOutline(sourceFile, itemPage);
        if (targetIndex === -1) {
            item.classList.add('disabled');
        } else {
            item.dataset.targetIndex = targetIndex;
            item.addEventListener('click', () => showReaderPage(targetIndex));
        }

        item.appendChild(titleSpan);
        item.appendChild(pageSpan);
        container.appendChild(item);

        if (entry.children && entry.children.length > 0 && !isCollapsed) {
            appendOutlineItems(entry.children, sourceFile, container, depth + 1, boundaryPage);
        }
    });
}

function highlightOutlineForPage(pageIndex) {
    const items = document.querySelectorAll('.outline-item');
    let activeItem = null;
    items.forEach((item) => {
        const idx = parseInt(item.dataset.targetIndex, 10);
        const isActive = Number.isInteger(idx) && idx === pageIndex;
        item.classList.toggle('active', isActive);
        if (isActive) activeItem = item;
    });

    if (activeItem) {
        activeItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
}

function createFloatingOutlineLabel(title, rangeText) {
    const label = document.createElement('span');
    label.className = 'floating-outline-text';

    const titleSpan = document.createElement('span');
    titleSpan.className = 'floating-outline-title';
    titleSpan.textContent = title || 'Ohne Titel';
    label.appendChild(titleSpan);

    if (rangeText) {
        const rangeSpan = document.createElement('span');
        rangeSpan.className = 'floating-outline-range';
        rangeSpan.textContent = rangeText;
        label.appendChild(rangeSpan);
    }

    return label;
}

function renderFloatingOutline() {
    const body = document.getElementById('floating-outline-body');
    if (!body) return;

    body.innerHTML = '';
    const placeholder = document.createElement('div');
    placeholder.className = 'floating-outline-empty';
    placeholder.textContent = 'Kein Inhaltsverzeichnis gefunden';

    const files = Array.from(new Set(state.pages.map(p => p.sourceFile)));
    const multipleSources = files.length > 1;
    let hasEntries = false;

    const customChapters = getCustomChapterEntries();
    if (customChapters.length > 0) {
        hasEntries = true;
        const sourceLabel = document.createElement('div');
        sourceLabel.className = 'floating-outline-source';
        sourceLabel.textContent = 'Eigene Kapitel';
        body.appendChild(sourceLabel);
        appendFloatingCustomOutlineItems(customChapters, body);
    }

    files.forEach((filePath) => {
        const outline = outlineCache[filePath];
        if (!outline || outline.length === 0) return;
        hasEntries = true;

        if (multipleSources) {
            const sourceLabel = document.createElement('div');
            sourceLabel.className = 'floating-outline-source';
            sourceLabel.textContent = getBaseName(filePath);
            body.appendChild(sourceLabel);
        }

        appendFloatingOutlineItems(outline, filePath, body, 0);
    });

    if (!hasEntries) {
        body.appendChild(placeholder);
    }
}

function appendFloatingCustomOutlineItems(entries, container) {
    entries.forEach((entry, index) => {
        const item = document.createElement('div');
        item.className = 'floating-outline-item floating-outline-item-custom';
        item.dataset.depth = 0;
        item.dataset.targetIndex = entry.targetIndex;

        const label = createFloatingOutlineLabel(
            entry.title,
            formatOutlinePageRange(entry.page, getCustomChapterEndPage(entries, index))
        );

        const actions = document.createElement('div');
        actions.className = 'floating-outline-actions';

        const extractBtn = document.createElement('button');
        extractBtn.className = 'floating-outline-action';
        extractBtn.title = 'Kapitel extrahieren';
        extractBtn.textContent = 'Ex';
        extractBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            extractCustomChapter(entry, entries[index + 1]);
        });
        actions.appendChild(extractBtn);

        item.appendChild(label);
        item.appendChild(actions);
        item.addEventListener('click', () => focusGridPage(entry.targetIndex));
        container.appendChild(item);
    });
}

function appendFloatingOutlineItems(items, sourceFile, container, depth, parentBoundaryPage = null) {
    const sourceMaxPage = getMaxOriginalPageForSource(sourceFile);

    items.forEach((entry, index) => {
        const item = document.createElement('div');
        item.className = 'floating-outline-item';
        item.dataset.depth = depth;

        const itemPage = parseOutlinePageNumber(entry.page);
        const canCollapse = hasCollapsibleOutlineChildren(entry, depth);
        const collapseKey = getOutlineCollapseKey(sourceFile, entry, depth, index, itemPage);
        const isCollapsed = canCollapse && !expandedOutlineKeys.has(collapseKey);
        const boundaryPage = itemPage !== null
            ? findNextOutlineBoundaryPage(items, index, itemPage, parentBoundaryPage)
            : parentBoundaryPage;
        const endPage = boundaryPage !== null ? boundaryPage - 1 : sourceMaxPage;

        if (canCollapse) {
            item.appendChild(createOutlineToggleButton('floating-outline-toggle', isCollapsed, () => {
                toggleOutlineCollapse(collapseKey);
            }));
        }

        const label = createFloatingOutlineLabel(
            entry.title || 'Ohne Titel',
            formatOutlinePageRange(itemPage, endPage)
        );

        const actions = document.createElement('div');
        actions.className = 'floating-outline-actions';

        const extractBtn = document.createElement('button');
        extractBtn.className = 'floating-outline-action';
        extractBtn.title = 'Kapitel extrahieren';
        extractBtn.textContent = 'Ex';
        extractBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            extractOutlineChapter(sourceFile, itemPage, endPage, entry.title);
        });
        actions.appendChild(extractBtn);

        item.appendChild(label);
        item.appendChild(actions);

        const targetIndex = findPageIndexForOutline(sourceFile, itemPage);
        if (targetIndex === -1) {
            item.classList.add('disabled');
        } else {
            item.addEventListener('click', () => focusGridPage(targetIndex));
        }

        container.appendChild(item);

        if (entry.children && entry.children.length > 0 && !isCollapsed) {
            appendFloatingOutlineItems(entry.children, sourceFile, container, depth + 1, boundaryPage);
        }
    });
}

async function showFloatingOutlinePanel(forceRefresh = false) {
    const panel = document.getElementById('floating-outline-panel');
    const button = document.getElementById('btn-floating-outline');
    if (!panel || state.pages.length === 0) return;

    floatingOutlineOpen = true;
    panel.classList.add('visible');
    panel.setAttribute('aria-hidden', 'false');
    button?.classList.add('active');
    renderFloatingOutline();

    await loadOutlineForSources(forceRefresh);
    if (floatingOutlineOpen) {
        renderFloatingOutline();
    }
}

function hideFloatingOutlinePanel() {
    const panel = document.getElementById('floating-outline-panel');
    const button = document.getElementById('btn-floating-outline');
    floatingOutlineOpen = false;
    panel?.classList.remove('visible');
    panel?.setAttribute('aria-hidden', 'true');
    button?.classList.remove('active');
}

function toggleFloatingOutlinePanel() {
    if (floatingOutlineOpen) {
        hideFloatingOutlinePanel();
    } else {
        showFloatingOutlinePanel();
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

async function loadSingleHighResThumbnail(page, navToken = null) {
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
        const url = await schedulePdfPageRender(page, {
            variant: 'reader-page',
            maxWidth: dpi >= 100 ? 1400 : 1100,
            maxHeight: dpi >= 100 ? 1800 : 1500,
            priority: 90
        });
        
        // Abbrechen wenn Navigation sich geändert hat
        if (navToken !== null && navToken !== readerNavToken) return;
        
        // Cache initialisieren wenn nötig
        if (!readerHighResThumbnails[page.sourceFile]) {
            readerHighResThumbnails[page.sourceFile] = {};
        }
        readerHighResThumbnails[page.sourceFile][page.originalNumber] = url;
        
        // Anzeige nur aktualisieren, wenn diese Seite noch aktiv ist (check by id)
        const currentPage = state.pages[readerCurrentPage];
        if (currentPage && currentPage.id === page.id) {
            const img = document.getElementById('reader-page-image');
            if (img) {
                img.src = url;
                img.style.display = 'block';
                renderSelectableTextLayer('reader', page);
            }
        }
    } catch (error) {
        console.error(`Error loading high-res for page ${page.originalNumber}:`, error);
    }
}

async function loadSingleMediumResThumbnail(page, navToken = null) {
    // Medium-res is used as a fast fallback when no thumbnail is available yet
    if (page.thumbnail) return;

    let dpi = 72;
    const pagesFromSameSource = state.pages.filter(p => p.sourceFile === page.sourceFile);
    const maxOriginalPage = Math.max(...pagesFromSameSource.map(p => p.originalNumber));
    if (maxOriginalPage > 200) dpi = 60;
    else if (maxOriginalPage > 100) dpi = 66;

    try {
        const url = await schedulePdfPageRender(page, {
            variant: 'reader-medium',
            maxWidth: dpi >= 72 ? 900 : 760,
            maxHeight: dpi >= 72 ? 1200 : 1000,
            priority: 80
        });

        // Abbrechen wenn Navigation sich geändert hat
        if (navToken !== null && navToken !== readerNavToken) return;

        page.thumbnail = url;

        // Update main reader image if still on this page (check by id)
        const currentPage = state.pages[readerCurrentPage];
        if (currentPage && currentPage.id === page.id) {
            const img = document.getElementById('reader-page-image');
            if (img) {
                img.src = url;
                img.style.display = 'block';
                renderSelectableTextLayer('reader', page);
            }
        }
    } catch (error) {
        // ignore
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
    const myToken = ++readerNavToken;

    readerCurrentPage = index;
    const page = state.pages[index];

    // Keep a global focus hint so grid thumbnail loading can prioritize nearby pages
    state.lastFocusedPageId = page.id;

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
        // Kein Thumbnail verfügbar - zeige Platzhalter, lade schnell medium-res nach
        img.src = '';
        img.style.display = 'block';
        loadSingleMediumResThumbnail(page, myToken);
    }
    img.style.transform = `rotate(${page.rotation}deg)`;
    renderSelectableTextLayer('reader', page);
    
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
        activeThumb.scrollIntoView({ behavior: 'auto', block: 'nearest' });
    }
    
    // Outline-Hervorhebung aktualisieren
    highlightOutlineForPage(index);

    // Lade High-Res für aktuelle und umliegende Seiten (falls nicht im Cache)
    loadPriorityThumbnails(index, myToken);
}

// Lädt Thumbnails für aktuelle und umliegende Seiten priorisiert
async function loadPriorityThumbnails(centerIndex, token) {
    const page = state.pages[centerIndex];
    if (!page) return;

    // Ignore stale requests
    if (token !== undefined && token !== readerNavToken) return;
    
    // Prüfe ob aktuelle Seite bereits High-Res hat
    const cache = readerHighResThumbnails[page.sourceFile];
    const hasHighRes = cache && cache[page.originalNumber];

    // High-res für aktuelle Seite im Hintergrund (nicht blockierend)
    if (!hasHighRes) {
        loadSingleHighResThumbnail(page, token);
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
        if (token !== undefined && token !== readerNavToken) break;
        if (!document.getElementById('screen-reader').classList.contains('active')) break;
        const promises = chunk.map(idx => {
            const nearPage = state.pages[idx];
            const nearCache = readerHighResThumbnails[nearPage.sourceFile];
            if (!nearCache || !nearCache[nearPage.originalNumber]) {
                return loadSingleHighResThumbnail(nearPage, token);
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
let viewerZoom = 1;
const VIEWER_ZOOM_MIN = 0.5;
const VIEWER_ZOOM_MAX = 3;
const VIEWER_ZOOM_STEP = 0.25;

function clampViewerZoom(value) {
    return Math.max(VIEWER_ZOOM_MIN, Math.min(VIEWER_ZOOM_MAX, value));
}

function updateViewerZoomControls() {
    const label = document.getElementById('viewer-zoom-level');
    const zoomIn = document.getElementById('btn-viewer-zoom-in');
    const zoomOut = document.getElementById('btn-viewer-zoom-out');
    const zoomReset = document.getElementById('btn-viewer-zoom-reset');

    if (label) label.textContent = `${Math.round(viewerZoom * 100)}%`;
    if (zoomIn) zoomIn.disabled = viewerZoom >= VIEWER_ZOOM_MAX;
    if (zoomOut) zoomOut.disabled = viewerZoom <= VIEWER_ZOOM_MIN;
    if (zoomReset) zoomReset.classList.toggle('active', viewerZoom !== 1);
}

function applyViewerZoom(renderTextLayer = true) {
    const img = document.getElementById('viewer-page-image');
    const content = document.querySelector('.page-viewer-content');
    if (!img) return;

    img.style.maxWidth = `${viewerZoom * 100}%`;
    img.style.maxHeight = `${viewerZoom * 100}%`;
    if (content) {
        content.classList.toggle('is-zoomed', viewerZoom > 1);
    }
    updateViewerZoomControls();

    if (renderTextLayer) {
        requestAnimationFrame(() => {
            renderSelectableTextLayer('viewer', getCurrentViewerPage());
        });
    }
}

function setViewerZoom(nextZoom, options = {}) {
    const content = document.querySelector('.page-viewer-content');
    const previousScrollWidth = content?.scrollWidth || 0;
    const previousScrollHeight = content?.scrollHeight || 0;
    const centerX = content && previousScrollWidth > 0
        ? (content.scrollLeft + content.clientWidth / 2) / previousScrollWidth
        : 0.5;
    const centerY = content && previousScrollHeight > 0
        ? (content.scrollTop + content.clientHeight / 2) / previousScrollHeight
        : 0.5;

    viewerZoom = clampViewerZoom(nextZoom);
    applyViewerZoom(options.renderTextLayer !== false);

    if (content && options.preserveCenter) {
        requestAnimationFrame(() => {
            content.scrollLeft = Math.max(0, content.scrollWidth * centerX - content.clientWidth / 2);
            content.scrollTop = Math.max(0, content.scrollHeight * centerY - content.clientHeight / 2);
        });
    }
}

function zoomViewerBy(delta) {
    setViewerZoom(viewerZoom + delta, { preserveCenter: true });
}

function resetViewerZoom() {
    setViewerZoom(1, { preserveCenter: true });
}

async function openPageViewer(startIndex = 0) {
    viewerCurrentPage = startIndex;
    viewerHighResThumbnails = {};  // Reset cache
    viewerZoom = 1;
    
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
    clearSelectableTextLayer('viewer');
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
        img.style.display = 'block';
    } else {
        img.src = '';
        img.style.display = 'block';
    }
    img.style.transform = `rotate(${page.rotation}deg)`;
    applyViewerZoom(false);
    renderSelectableTextLayer('viewer', page);
    
    // Update page info
    document.getElementById('viewer-page-info').textContent = `${index + 1} / ${state.pages.length}`;
    
    // Update navigation buttons
    document.getElementById('btn-viewer-prev').disabled = index === 0;
    document.getElementById('btn-viewer-next').disabled = index === state.pages.length - 1;
    updateViewerActions();
    
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
        const bounds = getViewerRenderBounds();
        const url = await schedulePdfPageRender(page, {
            variant: 'viewer',
            maxWidth: dpi >= 100 ? bounds.maxWidth : Math.floor(bounds.maxWidth * 0.82),
            maxHeight: dpi >= 100 ? bounds.maxHeight : Math.floor(bounds.maxHeight * 0.82),
            priority: 100
        });
        
        // Initialize cache if needed
        if (!viewerHighResThumbnails[page.sourceFile]) {
            viewerHighResThumbnails[page.sourceFile] = {};
        }
        viewerHighResThumbnails[page.sourceFile][page.originalNumber] = url;
        
        // Update display if this is the current page
        const currentPage = state.pages[viewerCurrentPage];
        if (currentPage &&
            currentPage.sourceFile === page.sourceFile &&
            currentPage.originalNumber === page.originalNumber) {
            showViewerPage(viewerCurrentPage);
        }
    } catch (error) {
        console.error(`Failed to load viewer thumbnail for page ${page.originalNumber}:`, error);
    }
}

function getCurrentViewerPage() {
    return state.pages[viewerCurrentPage] || null;
}

function updateViewerActions() {
    const page = getCurrentViewerPage();
    const chapterBtn = document.getElementById('btn-viewer-chapter');
    const deleteBtn = document.getElementById('btn-viewer-delete');

    if (chapterBtn) {
        chapterBtn.classList.toggle('active', !!getChapterTitle(page));
    }

    if (deleteBtn) {
        deleteBtn.disabled = state.pages.length <= 1;
    }

    updateOcrControls();
}

function openViewerChapterModal() {
    const page = getCurrentViewerPage();
    if (!page) return;
    openChapterModalForPage(page.id);
}

function rotateViewerPage(degrees) {
    const page = getCurrentViewerPage();
    if (!page) return;
    rotatePagesBy([page.id], degrees);
    showViewerPage(viewerCurrentPage);
}

async function extractViewerPage() {
    const page = getCurrentViewerPage();
    if (!page) return;

    const outputPath = await window.pedefo.saveFile(`seite_${viewerCurrentPage + 1}.pdf`);
    if (!outputPath) return;

    showLoading('Seite wird extrahiert...');
    try {
        const result = await buildPdfForPages([page], outputPath);
        if (result.success) {
            showToast('Seite extrahiert', 'success');
        } else {
            throw new Error(result.message || 'Fehler beim Extrahieren');
        }
    } catch (error) {
        showToast(error.message, 'error');
    } finally {
        hideLoading();
    }
}

function duplicateViewerPage() {
    const page = getCurrentViewerPage();
    if (!page) return;
    duplicatePages([page.id]);
    showViewerPage(Math.min(viewerCurrentPage + 1, state.pages.length - 1));
    renderViewerOutline();
}

function deleteViewerPage() {
    const page = getCurrentViewerPage();
    if (!page || state.pages.length <= 1) return;
    const nextIndex = Math.min(viewerCurrentPage, state.pages.length - 2);
    deletePages([page.id]);
    if (state.pages.length === 0) {
        closePageViewer();
        return;
    }
    showViewerPage(nextIndex);
    renderViewerOutline();
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

    const customChapters = getCustomChapterEntries();
    if (customChapters.length > 0) {
        hasEntries = true;
        const sourceLabel = document.createElement('div');
        sourceLabel.className = 'viewer-outline-source';
        sourceLabel.textContent = 'Eigene Kapitel';
        body.appendChild(sourceLabel);
        appendViewerCustomOutlineItems(customChapters, body);
    }
    
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
        
        appendViewerOutlineItems(outline, filePath, body, 0);
    });
    
    if (!hasEntries) {
        body.appendChild(placeholder);
    }
}

function createViewerOutlineLabel(title, rangeText) {
    const label = document.createElement('span');
    label.className = 'viewer-outline-text';

    const titleSpan = document.createElement('span');
    titleSpan.className = 'viewer-outline-title';
    titleSpan.textContent = title || 'Ohne Titel';
    label.appendChild(titleSpan);

    if (rangeText) {
        const rangeSpan = document.createElement('span');
        rangeSpan.className = 'viewer-outline-range';
        rangeSpan.textContent = rangeText;
        label.appendChild(rangeSpan);
    }

    return label;
}

function appendViewerCustomOutlineItems(entries, container) {
    entries.forEach((entry, index) => {
        const el = document.createElement('div');
        el.className = 'viewer-outline-item viewer-outline-item-custom';
        el.dataset.depth = 0;
        el.dataset.targetIndex = entry.targetIndex;

        const label = createViewerOutlineLabel(
            entry.title,
            formatOutlinePageRange(entry.page, getCustomChapterEndPage(entries, index))
        );

        const actions = document.createElement('div');
        actions.className = 'viewer-outline-actions';

        const extractBtn = document.createElement('button');
        extractBtn.className = 'viewer-outline-action';
        extractBtn.title = 'Kapitel extrahieren';
        extractBtn.textContent = 'Ex';
        extractBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            extractCustomChapter(entry, entries[index + 1]);
        });
        actions.appendChild(extractBtn);

        el.appendChild(label);
        el.appendChild(actions);
        el.addEventListener('click', () => showViewerPage(entry.targetIndex));
        container.appendChild(el);
    });
}

async function extractCustomChapter(entry, nextEntry) {
    const startIndex = entry.targetIndex;
    const endIndex = nextEntry ? nextEntry.targetIndex - 1 : state.pages.length - 1;
    const pagesToExtract = state.pages.slice(startIndex, endIndex + 1);
    if (pagesToExtract.length === 0) {
        showToast('Keine Seiten im Kapitel gefunden', 'error');
        return;
    }

    const outputPath = await window.pedefo.saveFile(`${sanitizeFilename(entry.title || 'Kapitel')}.pdf`);
    if (!outputPath) return;

    showLoading('Kapitel wird extrahiert...');
    try {
        const result = await buildPdfForPages(pagesToExtract, outputPath);
        if (result.success) {
            showToast('Kapitel extrahiert', 'success');
        } else {
            throw new Error(result.message || 'Fehler beim Extrahieren');
        }
    } catch (error) {
        showToast(error.message, 'error');
    } finally {
        hideLoading();
    }
}

function parseOutlinePageNumber(pageNumber) {
    if (pageNumber === null || pageNumber === undefined) return null;
    const parsed = parseInt(pageNumber, 10);
    return Number.isNaN(parsed) ? null : parsed;
}

function formatOutlinePageRange(startPage, endPage) {
    const start = parseOutlinePageNumber(startPage);
    if (start === null) return '';

    const end = parseOutlinePageNumber(endPage);
    if (end === null || end <= start) return `S. ${start}`;
    return `S. ${start}-${end}`;
}

function getCustomChapterEndPage(entries, index) {
    const nextEntry = entries[index + 1];
    return nextEntry ? nextEntry.page - 1 : state.pages.length;
}

function getMaxOriginalPageForSource(sourceFile) {
    const pageNumbers = state.pages
        .filter(page => page.sourceFile === sourceFile)
        .map(page => parseOutlinePageNumber(page.originalNumber))
        .filter(pageNumber => pageNumber !== null);

    if (pageNumbers.length === 0) return null;
    return Math.max(...pageNumbers);
}

function findNextOutlineBoundaryPage(items, currentIndex, startPage, fallbackBoundaryPage) {
    for (let i = currentIndex + 1; i < items.length; i++) {
        const siblingPage = parseOutlinePageNumber(items[i]?.page);
        if (siblingPage !== null && siblingPage > startPage) {
            return siblingPage;
        }
    }
    return fallbackBoundaryPage ?? null;
}

function appendViewerOutlineItems(items, sourceFile, container, depth, parentBoundaryPage = null) {
    const sourceMaxPage = getMaxOriginalPageForSource(sourceFile);

    items.forEach((item, index) => {
        const el = document.createElement('div');
        el.className = 'viewer-outline-item';
        el.dataset.depth = depth;

        const itemPage = parseOutlinePageNumber(item.page);
        const canCollapse = hasCollapsibleOutlineChildren(item, depth);
        const collapseKey = getOutlineCollapseKey(sourceFile, item, depth, index, itemPage);
        const isCollapsed = canCollapse && !expandedOutlineKeys.has(collapseKey);
        const boundaryPage = itemPage !== null
            ? findNextOutlineBoundaryPage(items, index, itemPage, parentBoundaryPage)
            : parentBoundaryPage;
        const endPage = boundaryPage !== null ? boundaryPage - 1 : sourceMaxPage;

        if (canCollapse) {
            el.appendChild(createOutlineToggleButton('viewer-outline-toggle', isCollapsed, () => {
                toggleOutlineCollapse(collapseKey);
            }));
        }

        const label = createViewerOutlineLabel(
            item.title || 'Ohne Titel',
            formatOutlinePageRange(itemPage, endPage)
        );

        const actions = document.createElement('div');
        actions.className = 'viewer-outline-actions';

        const extractBtn = document.createElement('button');
        extractBtn.className = 'viewer-outline-action';
        extractBtn.title = 'Kapitel extrahieren';
        extractBtn.textContent = 'Ex';
        extractBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            extractOutlineChapter(sourceFile, itemPage, endPage, item.title);
        });
        actions.appendChild(extractBtn);

        el.appendChild(label);
        el.appendChild(actions);

        const pageIndex = findViewerPageIndex(sourceFile, item.page);
        if (pageIndex !== -1) {
            el.addEventListener('click', () => {
                showViewerPage(pageIndex);
            });
        } else {
            el.classList.add('disabled');
        }

        container.appendChild(el);

        if (item.children && item.children.length > 0 && !isCollapsed) {
            appendViewerOutlineItems(item.children, sourceFile, container, depth + 1, boundaryPage);
        }
    });
}

async function extractOutlineChapter(sourceFile, startPage, endPage, title) {
    const pagesForSource = state.pages.filter(p => p.sourceFile === sourceFile);
    if (pagesForSource.length === 0) {
        showToast('Quellseiten nicht gefunden', 'error');
        return;
    }

    const maxPage = Math.max(...pagesForSource.map(p => p.originalNumber));
    const start = parseOutlinePageNumber(startPage);
    if (start === null) {
        showToast('Dieses Kapitel hat keine Seitenzahl', 'error');
        return;
    }

    const parsedEnd = parseOutlinePageNumber(endPage);
    const end = Math.min(parsedEnd !== null ? parsedEnd : maxPage, maxPage);
    const pagesToExtract = pagesForSource
        .filter(p => p.originalNumber >= start && p.originalNumber <= end);

    if (pagesToExtract.length === 0) {
        showToast('Keine Seiten im Kapitel gefunden', 'error');
        return;
    }

    const defaultName = `${sanitizeFilename(title || 'Kapitel')}.pdf`;
    const outputPath = await window.pedefo.saveFile(defaultName);
    if (!outputPath) return;

    showLoading('Kapitel wird extrahiert...');
    try {
        const result = await buildPdfForPages(pagesToExtract, outputPath);
        if (result.success) {
            showToast('Kapitel extrahiert', 'success');
        } else {
            throw new Error(result.message || 'Fehler beim Extrahieren');
        }
    } catch (error) {
        showToast(error.message, 'error');
    } finally {
        hideLoading();
    }
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
    
    document.querySelectorAll('.viewer-outline-item').forEach(item => item.classList.remove('active'));
    
    // Find matching outline item (simplified - exact match only)
    const outline = viewerOutlineCache[page.sourceFile];
    if (!outline) return;
    
    // This would need more sophisticated matching logic for nested items
    // For now, just highlight based on page number proximity
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
document.getElementById('btn-viewer-chapter').addEventListener('click', openViewerChapterModal);
document.getElementById('btn-viewer-zoom-in').addEventListener('click', () => zoomViewerBy(VIEWER_ZOOM_STEP));
document.getElementById('btn-viewer-zoom-out').addEventListener('click', () => zoomViewerBy(-VIEWER_ZOOM_STEP));
document.getElementById('btn-viewer-zoom-reset').addEventListener('click', resetViewerZoom);
document.getElementById('btn-viewer-rotate-left').addEventListener('click', () => rotateViewerPage(-90));
document.getElementById('btn-viewer-rotate-right').addEventListener('click', () => rotateViewerPage(90));
document.getElementById('btn-viewer-extract').addEventListener('click', extractViewerPage);
document.getElementById('btn-viewer-duplicate').addEventListener('click', duplicateViewerPage);
document.getElementById('btn-viewer-delete').addEventListener('click', deleteViewerPage);

document.querySelector('.page-viewer-content').addEventListener('wheel', (e) => {
    if (document.getElementById('page-viewer').style.display !== 'flex') return;
    if (!e.ctrlKey) return;
    e.preventDefault();
    zoomViewerBy(e.deltaY < 0 ? VIEWER_ZOOM_STEP : -VIEWER_ZOOM_STEP);
}, { passive: false });

// Keyboard Navigation
document.addEventListener('keydown', (e) => {
    if (document.getElementById('page-viewer').style.display !== 'flex') return;
    if (isModalOpen()) return;
    
    if (e.key === 'Escape') {
        closePageViewer();
    } else if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        zoomViewerBy(VIEWER_ZOOM_STEP);
    } else if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        zoomViewerBy(-VIEWER_ZOOM_STEP);
    } else if (e.key === '0') {
        e.preventDefault();
        resetViewerZoom();
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
        const selectedPages = [];
        state.pages.forEach((page) => {
            if (state.selectedPages.has(page.id)) {
                selectedPages.push(page);
            }
        });
        const result = await buildPdfForPages(selectedPages, outputPath);
        
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
document.getElementById('btn-chapter-selection').addEventListener('click', openChapterModalForCurrentPage);

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

document.getElementById('btn-chapter').addEventListener('click', openChapterModalForCurrentPage);
document.getElementById('btn-chapter-save').addEventListener('click', saveChapterFromModal);
document.getElementById('btn-chapter-remove').addEventListener('click', removeChapterFromModal);
document.getElementById('chapter-page-select').addEventListener('change', handleChapterPageSelectChange);
document.getElementById('chapter-title').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        saveChapterFromModal();
    }
});

document.getElementById('btn-compress').addEventListener('click', openCompressModal);
document.getElementById('btn-compress-confirm').addEventListener('click', compressPDF);
document.getElementById('btn-ocr').addEventListener('click', runOCRForCurrentPDF);
document.getElementById('btn-viewer-ocr').addEventListener('click', runOCRForCurrentPDF);

document.getElementById('btn-save').addEventListener('click', savePDF);
document.getElementById('btn-new').addEventListener('click', newFile);
document.getElementById('btn-new-file-discard').addEventListener('click', confirmNewFileDiscard);

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
        hideFloatingOutlinePanel();
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
    setupPageGridDelegatedEvents();
    setupEditorFileDropZone();
    setupUnsavedModal();
    
    // Ensure page viewer lives at body level (avoids stacking context issues)
    const viewerModal = document.getElementById('page-viewer');
    if (viewerModal && viewerModal.parentElement !== document.body) {
        document.body.appendChild(viewerModal);
    }
    
    // Fullscreen button - opens viewer with first selected page
    const btnFullscreen = document.getElementById('btn-fullscreen-view');
    const btnFloatingOutline = document.getElementById('btn-floating-outline');
    const btnFloatingOutlineRefresh = document.getElementById('btn-floating-outline-refresh');
    const btnFloatingOutlineClose = document.getElementById('btn-floating-outline-close');
    
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

    btnFloatingOutline?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleFloatingOutlinePanel();
    });

    btnFloatingOutlineRefresh?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showFloatingOutlinePanel(true);
    });

    btnFloatingOutlineClose?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        hideFloatingOutlinePanel();
    });

    updateFloatingButtons();
});
