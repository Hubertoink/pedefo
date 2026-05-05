const { contextBridge, ipcRenderer } = require('electron');

// Exponiere sichere API für den Renderer-Prozess
contextBridge.exposeInMainWorld('pedefo', {
    // Event-Listener für Speichern vor dem Schließen
    onSaveBeforeClose: (callback) => ipcRenderer.on('save-before-close', callback),
    onShowUnsavedDialog: (callback) => ipcRenderer.on('show-unsaved-dialog', callback),
    saveCompleted: () => ipcRenderer.send('save-completed'),
    closeWithoutSave: () => ipcRenderer.send('close-without-save'),
    
    // Dialoge
    openFiles: () => ipcRenderer.invoke('dialog:openFiles'),
    openFile: () => ipcRenderer.invoke('dialog:openFile'),
    saveFile: (defaultName) => ipcRenderer.invoke('dialog:saveFile', defaultName),
    
    // PDF Operationen
    pdf: {
        merge: (files, outputPath) => ipcRenderer.invoke('pdf:merge', files, outputPath),
        split: (inputFile, startPage, endPage, outputPath) => 
            ipcRenderer.invoke('pdf:split', inputFile, startPage, endPage, outputPath),
        removePages: (inputFile, pages, outputPath) => 
            ipcRenderer.invoke('pdf:removePages', inputFile, pages, outputPath),
        rotate: (inputFile, pages, rotation, outputPath) => 
            ipcRenderer.invoke('pdf:rotate', inputFile, pages, rotation, outputPath),
        compress: (inputFile, outputPath, quality) => 
            ipcRenderer.invoke('pdf:compress', inputFile, outputPath, quality),
        getInfo: (filePath) => ipcRenderer.invoke('pdf:getInfo', filePath),
        getOutline: (filePath) => ipcRenderer.invoke('pdf:getOutline', filePath),
        getPageCount: (filePath) => ipcRenderer.invoke('pdf:getPageCount', filePath),
        generateThumbnails: (filePath, dpi) => ipcRenderer.invoke('pdf:generateThumbnails', filePath, dpi),
        generateHighResThumbnails: (filePath) => ipcRenderer.invoke('pdf:generateHighResThumbnails', filePath),
        generateSingleThumbnail: (filePath, pageNumber, dpi) => ipcRenderer.invoke('pdf:generateSingleThumbnail', filePath, pageNumber, dpi),
        generateBatchThumbnails: (filePath, pageNumbers, dpi) => ipcRenderer.invoke('pdf:generateBatchThumbnails', filePath, pageNumbers, dpi),
        buildPDF: (operations, outputPath) => ipcRenderer.invoke('pdf:buildPDF', operations, outputPath)
    },
    
    // System
    system: {
        checkGhostscript: () => ipcRenderer.invoke('system:checkGhostscript'),
        openExternal: (url) => ipcRenderer.invoke('system:openExternal', url)
    },
    
    // Datei-Operationen
    file: {
        exists: (filePath) => ipcRenderer.invoke('file:exists', filePath),
        getSize: (filePath) => ipcRenderer.invoke('file:getSize', filePath),
        readBinary: (filePath) => ipcRenderer.invoke('file:readBinary', filePath),
        openPath: (filePath) => ipcRenderer.invoke('file:openPath', filePath)
    }
});
