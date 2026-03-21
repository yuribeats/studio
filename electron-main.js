const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

let mainWindow;
let auPlugins = [];

// ============================================
// NATIVE AU HOST ADDON
// ============================================
let auHost = null;
try {
    // In packaged app, asar-unpacked path is used for native addons
    const addonPath = path.join(__dirname, 'native', 'build', 'Release', 'au_host.node');
    auHost = require(addonPath);
    console.log('[AU_HOST] Native addon loaded from', addonPath);
} catch (e) {
    console.warn('[AU_HOST] Native addon not available — AU hosting disabled');
    console.warn('[AU_HOST]', e.message);
}

// ============================================
// AU PLUGIN SCANNER
// ============================================
function scanAUPlugins() {
    const plugins = [];
    const dirs = [
        '/Library/Audio/Plug-Ins/Components',
        path.join(app.getPath('home'), 'Library/Audio/Plug-Ins/Components')
    ];

    // Scan .component bundles
    for (const dir of dirs) {
        try {
            if (!fs.existsSync(dir)) continue;
            const entries = fs.readdirSync(dir);
            for (const entry of entries) {
                if (!entry.endsWith('.component')) continue;
                const bundlePath = path.join(dir, entry);
                const name = entry.replace('.component', '');
                const plistPath = path.join(bundlePath, 'Contents', 'Info.plist');
                let pluginInfo = { name, path: bundlePath, type: 'unknown', manufacturer: '', arch: [] };

                // Try to read Info.plist for more details
                try {
                    if (fs.existsSync(plistPath)) {
                        const plist = fs.readFileSync(plistPath, 'utf8');
                        // Extract CFBundleName
                        const nameMatch = plist.match(/<key>CFBundleName<\/key>\s*<string>([^<]+)<\/string>/);
                        if (nameMatch) pluginInfo.name = nameMatch[1];
                        // Extract manufacturer
                        const mfgMatch = plist.match(/<key>AudioUnit\s*Manufacturer<\/key>\s*<string>([^<]+)<\/string>/) ||
                                         plist.match(/<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/);
                        if (mfgMatch) pluginInfo.manufacturer = mfgMatch[1];
                    }
                } catch(e) {}

                // Check architectures via lipo
                try {
                    const machoPath = path.join(bundlePath, 'Contents', 'MacOS');
                    if (fs.existsSync(machoPath)) {
                        const binaries = fs.readdirSync(machoPath);
                        if (binaries.length > 0) {
                            const binPath = path.join(machoPath, binaries[0]);
                            const lipoOut = execSync(`lipo -archs "${binPath}" 2>/dev/null || echo "unknown"`, { encoding: 'utf8' }).trim();
                            pluginInfo.arch = lipoOut.split(/\s+/);
                        }
                    }
                } catch(e) {
                    pluginInfo.arch = ['unknown'];
                }

                plugins.push(pluginInfo);
            }
        } catch(e) {}
    }

    // Also try auval for AU type classification (effect vs instrument)
    try {
        const auvalOut = execSync('auval -a 2>/dev/null || echo ""', { encoding: 'utf8', timeout: 10000 });
        const lines = auvalOut.split('\n');
        for (const line of lines) {
            // Format: "  aufx BitC Appl   -  AUBitCrusher" or "  aumu DLS  Appl   -  DLSMusicDevice"
            const m = line.match(/^\s+(au\w+)\s+(\S+)\s+(\S+)\s+-\s+(.+)$/);
            if (!m) continue;
            const [, auType, subtype, mfg, auName] = m;
            const trimName = auName.trim();
            // Find matching plugin and add type info
            const match = plugins.find(p => p.name === trimName || trimName.includes(p.name) || p.name.includes(trimName));
            if (match) {
                match.auType = auType; // aufx = effect, aumu = instrument, aumf = music effect, auol = offline
                match.subtype = subtype;
                match.auMfg = mfg;
            } else {
                // Add plugins found by auval but not in filesystem scan
                plugins.push({
                    name: trimName,
                    path: '',
                    type: auType === 'aufx' || auType === 'aumf' ? 'effect' : auType === 'aumu' ? 'instrument' : 'other',
                    manufacturer: mfg,
                    arch: ['x86_64', 'arm64'], // assume 64-bit if auval lists it
                    auType,
                    subtype,
                    auMfg: mfg
                });
            }
        }
    } catch(e) {}

    // Classify and filter to 64-bit only
    return plugins.filter(p => {
        const has64 = p.arch.some(a => a === 'x86_64' || a === 'arm64');
        return has64 || p.arch.includes('unknown');
    }).map(p => ({
        name: p.name,
        manufacturer: p.manufacturer || p.auMfg || '',
        type: p.auType === 'aufx' || p.auType === 'aumf' ? 'effect' :
              p.auType === 'aumu' ? 'instrument' : 'effect',
        arch: p.arch,
        path: p.path,
        auType: p.auType || '',
        subtype: p.subtype || '',
        auMfg: p.auMfg || ''
    })).sort((a, b) => a.name.localeCompare(b.name));
}

// ============================================
// IPC HANDLERS
// ============================================
ipcMain.handle('get-au-plugins', () => {
    return auPlugins;
});

// ============================================
// AU HOST IPC HANDLERS
// ============================================
ipcMain.handle('au-create-instance', (event, typeStr, subtypeStr, mfgStr) => {
    if (!auHost) throw new Error('Native AU host not available');
    return auHost.createInstance(typeStr, subtypeStr, mfgStr);
});

ipcMain.handle('au-open-editor', (event, instanceId, title) => {
    if (!auHost) throw new Error('Native AU host not available');
    return auHost.openEditor(instanceId, title || 'AU PLUGIN');
});

ipcMain.handle('au-close-editor', (event, instanceId) => {
    if (!auHost) throw new Error('Native AU host not available');
    return auHost.closeEditor(instanceId);
});

ipcMain.handle('au-destroy-instance', (event, instanceId) => {
    if (!auHost) throw new Error('Native AU host not available');
    return auHost.destroyInstance(instanceId);
});

// ============================================
// WINDOW
// ============================================
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1440,
        height: 900,
        title: 'STUDIO',
        backgroundColor: '#0a0a0a',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        }
    });

    mainWindow.loadFile('index.html');
    mainWindow.setMenuBarVisibility(false);

    // Send AU plugins to renderer after window loads
    mainWindow.webContents.on('did-finish-load', () => {
        mainWindow.webContents.send('au-plugins-ready', auPlugins);
    });
}

app.whenReady().then(() => {
    // Scan AU plugins before creating window
    console.log('Scanning AU plugins...');
    auPlugins = scanAUPlugins();
    console.log(`Found ${auPlugins.length} AU plugins`);
    createWindow();
});

app.on('window-all-closed', () => {
    app.quit();
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
