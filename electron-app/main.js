const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

let mainWindow;
let forceClose = false;  // Flag um zu prüfen ob wir das Schließen erlauben

// Prüfe ob wir in Entwicklung oder Produktion sind
const isDev = !app.isPackaged;

// Python-Skript-Pfad ermitteln
const pythonScriptsPath = isDev 
    ? path.join(__dirname, '..', 'python-scripts')
    : path.join(process.resourcesPath, 'python-scripts');

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 800,
        minHeight: 600,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false
        },
        titleBarStyle: 'default',
        icon: path.join(__dirname, '..', 'assets', 'icon_pedefo.ico'),
        autoHideMenuBar: !isDev  // Menüleiste in Produktion verstecken
    });

    // Menüleiste in Produktion komplett entfernen
    if (!isDev) {
        Menu.setApplicationMenu(null);
    }

    mainWindow.loadFile(path.join(__dirname, 'index.html'));

    // DevTools nur in Entwicklung öffnen
    if (isDev) {
        mainWindow.webContents.openDevTools();
    }

    // Abfangen des Schließen-Events für ungespeicherte Änderungen
    mainWindow.on('close', (e) => {
        if (forceClose) {
            return; // Schließen erlaubt
        }

        // Verhindere das Schließen zunächst
        e.preventDefault();

        // Frage den Renderer nach dem isDirty-Status
        mainWindow.webContents.executeJavaScript('window.getIsDirty ? window.getIsDirty() : false')
            .then((isDirty) => {
                if (isDirty) {
                    // Zeige den Custom Modal im Renderer
                    mainWindow.webContents.send('show-unsaved-dialog');
                } else {
                    // Keine ungespeicherten Änderungen - direkt schließen
                    forceClose = true;
                    mainWindow.close();
                }
            })
            .catch(() => {
                // Bei Fehler trotzdem schließen
                forceClose = true;
                mainWindow.close();
            });
    });
}

app.whenReady().then(() => {
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

// IPC Handler für "Speichern abgeschlossen" - Fenster schließen
ipcMain.on('save-completed', () => {
    if (mainWindow) {
        forceClose = true;
        mainWindow.close();
    }
});

// IPC Handler für "Ohne Speichern schließen"
ipcMain.on('close-without-save', () => {
    if (mainWindow) {
        forceClose = true;
        mainWindow.close();
    }
});

// ============================================
// Python Bridge - Kommunikation mit Python
// ============================================

function runPython(script, args) {
    return new Promise((resolve, reject) => {
        const scriptPath = path.join(pythonScriptsPath, script);
        
        // Prüfe ob das Skript existiert
        if (!fs.existsSync(scriptPath)) {
            reject(new Error(`Python-Skript nicht gefunden: ${scriptPath}`));
            return;
        }

        const pythonProcess = spawn('python', [scriptPath, ...args], {
            cwd: pythonScriptsPath
        });

        let stdout = '';
        let stderr = '';

        pythonProcess.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        pythonProcess.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        pythonProcess.on('close', (code) => {
            if (code === 0) {
                try {
                    // Versuche JSON zu parsen
                    const result = JSON.parse(stdout.trim());
                    resolve(result);
                } catch (e) {
                    // Falls kein JSON, gib rohen Output zurück
                    resolve({ success: true, message: stdout.trim() });
                }
            } else {
                reject(new Error(stderr || `Python-Prozess beendet mit Code ${code}`));
            }
        });

        pythonProcess.on('error', (err) => {
            reject(new Error(`Fehler beim Starten von Python: ${err.message}`));
        });
    });
}

// ============================================
// IPC Handler - Kommunikation mit Renderer
// ============================================

// Datei-Dialoge
ipcMain.handle('dialog:openFiles', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'PDF Dateien', extensions: ['pdf'] }]
    });
    return result.filePaths;
});

ipcMain.handle('dialog:openFile', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile'],
        filters: [{ name: 'PDF Dateien', extensions: ['pdf'] }]
    });
    return result.filePaths[0] || null;
});

ipcMain.handle('dialog:saveFile', async (event, defaultName) => {
    const result = await dialog.showSaveDialog(mainWindow, {
        defaultPath: defaultName || 'output.pdf',
        filters: [{ name: 'PDF Dateien', extensions: ['pdf'] }]
    });
    return result.filePath;
});

// PDF Operationen
ipcMain.handle('pdf:merge', async (event, files, outputPath) => {
    try {
        const args = ['merge', ...files, outputPath];
        const result = await runPython('split_merge.py', args);
        return result;
    } catch (error) {
        return { success: false, message: error.message };
    }
});

ipcMain.handle('pdf:split', async (event, inputFile, startPage, endPage, outputPath) => {
    try {
        const args = ['split', inputFile, startPage.toString(), endPage.toString(), outputPath];
        const result = await runPython('split_merge.py', args);
        return result;
    } catch (error) {
        return { success: false, message: error.message };
    }
});

ipcMain.handle('pdf:removePages', async (event, inputFile, pages, outputPath) => {
    try {
        const pagesStr = pages.join(',');
        const args = ['remove', inputFile, pagesStr, outputPath];
        const result = await runPython('split_merge.py', args);
        return result;
    } catch (error) {
        return { success: false, message: error.message };
    }
});

ipcMain.handle('pdf:rotate', async (event, inputFile, pages, rotation, outputPath) => {
    try {
        const pagesStr = pages.join(',');
        const args = ['rotate', inputFile, pagesStr, rotation.toString(), outputPath];
        const result = await runPython('split_merge.py', args);
        return result;
    } catch (error) {
        return { success: false, message: error.message };
    }
});

ipcMain.handle('pdf:compress', async (event, inputFile, outputPath, quality) => {
    try {
        const args = ['compress', inputFile, outputPath, quality || 'medium'];
        const result = await runPython('compress.py', args);
        return result;
    } catch (error) {
        return { success: false, message: error.message };
    }
});

ipcMain.handle('pdf:getInfo', async (event, filePath) => {
    try {
        const args = ['info', filePath];
        const result = await runPython('utils.py', args);
        return result;
    } catch (error) {
        return { success: false, message: error.message };
    }
});

ipcMain.handle('pdf:getPageCount', async (event, filePath) => {
    try {
        const args = ['count', filePath];
        const result = await runPython('split_merge.py', args);
        return result;
    } catch (error) {
        return { success: false, message: error.message };
    }
});

ipcMain.handle('pdf:getOutline', async (event, filePath) => {
    try {
        const args = ['outline', filePath];
        const result = await runPython('utils.py', args);
        return result;
    } catch (error) {
        return { success: false, message: error.message };
    }
});

ipcMain.handle('system:checkGhostscript', async () => {
    try {
        const result = await runPython('compress.py', ['check']);
        return result;
    } catch (error) {
        return { success: false, message: error.message };
    }
});

// Datei-Info
ipcMain.handle('file:exists', async (event, filePath) => {
    return fs.existsSync(filePath);
});

ipcMain.handle('file:getSize', async (event, filePath) => {
    try {
        const stats = fs.statSync(filePath);
        return { success: true, size: stats.size };
    } catch (error) {
        return { success: false, message: error.message };
    }
});

ipcMain.handle('file:openPath', async (event, filePath) => {
    try {
        if (!filePath) throw new Error('Kein Pfad angegeben');
        await shell.openPath(filePath);
        return { success: true };
    } catch (error) {
        return { success: false, message: error.message };
    }
});

// Thumbnail-Generierung mit Poppler
ipcMain.handle('pdf:generateThumbnails', async (event, filePath, dpi = 36) => {
    try {
        const args = ['generate', filePath, String(dpi)];
        const result = await runPython('thumbnails.py', args);
        return result;
    } catch (error) {
        console.error('Thumbnail error:', error);
        return { success: false, message: error.message };
    }
});

// Hochauflösende Thumbnails für Leseansicht
ipcMain.handle('pdf:generateHighResThumbnails', async (event, filePath) => {
    try {
        const args = ['generate', filePath, '100'];  // 100 DPI für Leseansicht
        const result = await runPython('thumbnails.py', args);
        return result;
    } catch (error) {
        console.error('High-res thumbnail error:', error);
        return { success: false, message: error.message };
    }
});

// Einzelnes High-Res Thumbnail für eine bestimmte Seite
ipcMain.handle('pdf:generateSingleThumbnail', async (event, filePath, pageNumber, dpi = 100) => {
    try {
        const args = ['generate_single', filePath, String(pageNumber), String(dpi)];
        const result = await runPython('thumbnails.py', args);
        return result;
    } catch (error) {
        console.error('Single thumbnail error:', error);
        return { success: false, message: error.message };
    }
});

// PDF zusammenbauen aus mehreren Quellen mit Rotationen
ipcMain.handle('pdf:buildPDF', async (event, operations, outputPath) => {
    try {
        // Konvertiere operations zu JSON-String für Python
        const operationsJson = JSON.stringify(operations);
        const args = ['build', operationsJson, outputPath];
        const result = await runPython('split_merge.py', args);
        return result;
    } catch (error) {
        return { success: false, message: error.message };
    }
});
