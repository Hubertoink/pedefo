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

// Python executables Pfad (für gebundelte Version)
const pythonDistPath = isDev
    ? null  // In dev mode use regular python
    : path.join(process.resourcesPath, 'python-dist');

// Poppler-Pfad ermitteln
const popplerPath = isDev
    ? path.join(__dirname, 'poppler', 'poppler-25.12.0', 'Library', 'bin')
    : path.join(process.resourcesPath, 'poppler', 'poppler-25.12.0', 'Library', 'bin');

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

function runPython(script, args, options = {}) {
    return new Promise((resolve, reject) => {
        const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
        let command, commandArgs;

        const getDevPythonCommand = () => {
            // Allow explicit override (useful for CI and local setups)
            if (process.env.PEDEFO_PYTHON && fs.existsSync(process.env.PEDEFO_PYTHON)) {
                return process.env.PEDEFO_PYTHON;
            }

            // Try common venv locations
            const candidates = [
                // repo-root venv (..\.. because this file is in pdf-app/electron-app)
                path.join(__dirname, '..', '..', '.venv', 'Scripts', 'python.exe'),
                path.join(__dirname, '..', '..', '.venv', 'bin', 'python'),
                // pdf-app local venv
                path.join(__dirname, '..', '.venv', 'Scripts', 'python.exe'),
                path.join(__dirname, '..', '.venv', 'bin', 'python')
            ];

            for (const p of candidates) {
                if (fs.existsSync(p)) return p;
            }

            // Fallback: rely on PATH
            return 'python';
        };
        
        if (isDev) {
            // Development: use python interpreter
            const scriptPath = path.join(pythonScriptsPath, script);
            
            if (!fs.existsSync(scriptPath)) {
                reject(new Error(`Python-Skript nicht gefunden: ${scriptPath}`));
                return;
            }
            
            command = getDevPythonCommand();
            commandArgs = [scriptPath, ...args];
        } else {
            // Production: use bundled executable
            const exeName = script.replace('.py', '.exe');
            const exePath = path.join(pythonDistPath, exeName);
            
            if (!fs.existsSync(exePath)) {
                reject(new Error(`Python-Executable nicht gefunden: ${exePath}`));
                return;
            }
            
            command = exePath;
            commandArgs = args;
        }

        const pythonProcess = spawn(command, commandArgs, {
            cwd: isDev ? pythonScriptsPath : pythonDistPath,
            env: {
                ...process.env,
                POPPLER_PATH: popplerPath
            }
        });

        let stdout = '';
        let stderr = '';
        let stdoutLineBuffer = '';

        const handleProgressLine = (line) => {
            if (!onProgress) return;
            const trimmed = line.trim();
            if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return;

            try {
                const payload = JSON.parse(trimmed);
                if (payload && payload.type === 'progress') {
                    onProgress(payload);
                }
            } catch (_) {
                // Ignore non-progress output.
            }
        };

        pythonProcess.stdout.on('data', (data) => {
            const text = data.toString();
            stdout += text;

            if (onProgress) {
                stdoutLineBuffer += text;
                const lines = stdoutLineBuffer.split(/\r?\n/);
                stdoutLineBuffer = lines.pop() || '';
                lines.forEach(handleProgressLine);
            }
        });

        pythonProcess.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        pythonProcess.on('close', (code) => {
            if (stdoutLineBuffer) {
                handleProgressLine(stdoutLineBuffer);
                stdoutLineBuffer = '';
            }

            if (code === 0) {
                try {
                    // Versuche JSON zu parsen
                    const trimmed = stdout.trim();
                    const result = JSON.parse(trimmed);
                    resolve(result);
                } catch (e) {
                    // Falls stdout zusätzliche Logs enthält: versuche letzte JSON-Zeile
                    try {
                        const lines = stdout
                            .split(/\r?\n/)
                            .map(l => l.trim())
                            .filter(Boolean);

                        for (let i = lines.length - 1; i >= 0; i--) {
                            const line = lines[i];
                            if ((line.startsWith('{') && line.endsWith('}')) || (line.startsWith('[') && line.endsWith(']'))) {
                                const parsed = JSON.parse(line);
                                resolve(parsed);
                                return;
                            }
                        }
                    } catch (_) {
                        // ignore and fall through
                    }

                    // Nicht parsbar => als Fehler zurückgeben (sonst false positives)
                    resolve({
                        success: false,
                        message: 'Python-Ausgabe konnte nicht als JSON geparst werden',
                        data: {
                            stdout: stdout.trim(),
                            stderr: stderr.trim()
                        }
                    });
                }
            } else {
                // Auch bei Fehlern versucht das Backend oft JSON über stdout zu liefern.
                // Wenn wir das hier parsen, bekommt der Renderer eine bessere Fehlermeldung.
                const tryParseJsonFromStdout = () => {
                    const text = (stdout || '').trim();
                    if (!text) return null;
                    try {
                        return JSON.parse(text);
                    } catch (_) {
                        // try last JSON line
                        const lines = stdout
                            .split(/\r?\n/)
                            .map(l => l.trim())
                            .filter(Boolean);

                        for (let i = lines.length - 1; i >= 0; i--) {
                            const line = lines[i];
                            if ((line.startsWith('{') && line.endsWith('}')) || (line.startsWith('[') && line.endsWith(']'))) {
                                try {
                                    return JSON.parse(line);
                                } catch (_) {
                                    // continue
                                }
                            }
                        }
                        return null;
                    }
                };

                const parsed = tryParseJsonFromStdout();
                if (parsed && typeof parsed === 'object' && 'success' in parsed) {
                    resolve(parsed);
                    return;
                }

                reject(new Error(stderr || stdout || `Python-Prozess beendet mit Code ${code}`));
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

ipcMain.handle('pdf:compress', async (event, inputFile, outputPath, quality, operationId) => {
    try {
        const args = ['compress', inputFile, outputPath, quality || 'medium'];
        const result = await runPython('compress.py', args, {
            onProgress: (progress) => {
                event.sender.send('pdf:compress-progress', {
                    operationId,
                    percent: progress.percent,
                    message: progress.message,
                    stage: progress.stage,
                    current: progress.current,
                    total: progress.total
                });
            }
        });
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

ipcMain.handle('system:openExternal', async (event, url) => {
    try {
        if (!url || typeof url !== 'string') throw new Error('Ungültige URL');
        await shell.openExternal(url);
        return { success: true };
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

ipcMain.handle('file:readBinary', async (event, filePath) => {
    try {
        if (!filePath || typeof filePath !== 'string') {
            throw new Error('Ungültiger Dateipfad');
        }

        const data = await fs.promises.readFile(filePath);
        return data;
    } catch (error) {
        throw new Error(`Datei konnte nicht gelesen werden: ${error.message}`);
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

// Batch-Thumbnails für mehrere Seiten auf einmal (effizienter)
ipcMain.handle('pdf:generateBatchThumbnails', async (event, filePath, pageNumbers, dpi = 72) => {
    try {
        const args = ['generate_batch', filePath, JSON.stringify(pageNumbers), String(dpi)];
        const result = await runPython('thumbnails.py', args);
        return result;
    } catch (error) {
        console.error('Batch thumbnail error:', error);
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
