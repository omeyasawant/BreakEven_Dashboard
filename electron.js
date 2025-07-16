const { app, BrowserWindow, ipcMain, dialog, screen } = require('electron');
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

    win.removeMenu();
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

// IPC handlers
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
