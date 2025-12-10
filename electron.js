const { app, BrowserWindow, ipcMain, dialog, screen } = require('electron');
try {
    if (require('electron-squirrel-startup')) {
        app.quit();
        return;
    }
} catch (_) {
    // module not found in packaged builds — safe to ignore
    console.log('[Electron] electron-squirrel-startup catch case');
}
const path = require('path');
const fs = require('fs');

function createWindow() {
    const primaryDisplay = screen.getPrimaryDisplay();
    const width = Math.floor(primaryDisplay.size.width * 0.75);
    const height = Math.floor(primaryDisplay.size.height * 0.75);

    const win = new BrowserWindow({
        width,
        height,
        frame: false,
        resizable: true,
        movable: true,
        fullscreenable: false,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
        }
    });

    // Always use dev server for npm start
    win.loadFile(path.join(__dirname, 'index.html'));
    win.webContents.openDevTools();
    console.log('[Electron] Dashboard window launched in production mode');

    // Start streaming Breakeven_Slave log to renderer
    startSlaveLogTail(win);   // ← ADD THIS LINE

    win.removeMenu();
}


function startSlaveLogTail(win) {
    const logDir = path.join(__dirname, '..', 'client_service', 'logs');
    if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
    }

    const logPath = path.join(logDir, 'slave.log');
    console.log('[Electron] Watching slave log at:', logPath);

    let lastSize = 0;
    let firstRead = true;          // <─ important: we want to read existing content once
    const MAX_BYTES_ON_FIRST_READ = 1024 * 64; // 64 KB safety cap for huge logs

    const readNewData = () => {
        fs.stat(logPath, (err, stats) => {
            if (err) {
                // File may not exist yet, just skip this tick
                return;
            }

            // Handle truncation / rotation
            if (stats.size < lastSize) {
                lastSize = 0;
            }

            if (stats.size === lastSize && !firstRead) {
                // No new data
                return;
            }

            // Decide where to start reading from
            let startPos;
            if (firstRead) {
                // On the first read, send existing content too (up to MAX_BYTES_ON_FIRST_READ)
                startPos = Math.max(0, stats.size - MAX_BYTES_ON_FIRST_READ);
            } else {
                // After that, just read from the last known size
                startPos = lastSize;
            }

            if (stats.size <= startPos) {
                firstRead = false;
                lastSize = stats.size;
                return;
            }

            const stream = fs.createReadStream(logPath, {
                start: startPos,
                end: stats.size - 1,
            });

            let buffer = '';
            stream.on('data', (chunk) => {
                buffer += chunk.toString();
            });

            stream.on('end', () => {
                lastSize = stats.size;
                firstRead = false;

                const lines = buffer
                    .split(/\r?\n/)
                    .map((l) => l.trimEnd())
                    .filter((l) => l.length > 0);

                if (lines.length > 0 && !win.isDestroyed()) {
                    win.webContents.send('slave-log-lines', lines);
                }
            });
        });
    };

    // Kick off immediately so you see existing logs right away
    readNewData();

    // Then keep polling for new data
    const intervalId = setInterval(readNewData, 1000);

    win.on('closed', () => {
        clearInterval(intervalId);
    });
}





app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

// IPC handlers


// ADD THIS NEW HANDLER (e.g. just above ipcMain.handle('select-folder', ...))
ipcMain.handle('get-slave-log', async () => {
    try {
        const logDir = path.join(__dirname, '..', 'client_service', 'logs');
        const logPath = path.join(logDir, 'slave.log');

        if (!fs.existsSync(logPath)) {
            return [];
        }

        const data = await fs.promises.readFile(logPath, 'utf-8');

        return data
            .split(/\r?\n/)
            .map((l) => l.trimEnd())
            .filter((l) => l.length > 0)
            .slice(-1000); // last 1000 lines only
    } catch (err) {
        console.error('[Electron] get-slave-log error:', err);
        return [];
    }
});


ipcMain.handle('select-folder', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    return result.filePaths[0];
});

ipcMain.handle('get-client-config', () => {
    const fallback = {
        name: "Guest",
        email: null,
        installPath: "Unknown"
    };

    try {
        const configPath = path.resolve(__dirname, '..', 'client_config.json');
        const raw = fs.readFileSync(configPath, 'utf-8');
        return JSON.parse(raw);
    } catch (err) {
        return fallback;
    }
});

ipcMain.handle('window-close', () => {
    const win = BrowserWindow.getFocusedWindow();
    if (win) win.close();
});

ipcMain.handle('window-minimize', () => {
    const win = BrowserWindow.getFocusedWindow();
    if (win) win.minimize();
});

ipcMain.handle('get-service-status', () => {
    return {
        tray: { pid: -1, running: false, log: '' },
        slave: { pid: -1, running: false, log: '' },
        updater: { pid: -1, running: false, log: '' }
    };
});
