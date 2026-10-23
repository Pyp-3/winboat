import { app, BrowserWindow, ipcMain, session, dialog } from "electron";
import { join } from "path";
import { initialize, enable } from "@electron/remote/main/index.js";
import Store from "electron-store";

initialize();

// Window Constants
const WINDOW_MIN_WIDTH = 1280;
const WINDOW_MIN_HEIGHT = 800;

// For electron-store Type-Safety
type SchemaType = {
    dimensions: {
        width: number;
        height: number;
    };
    position: {
        x: number;
        y: number;
    };
};

const windowStore = new Store<SchemaType>({
    schema: {
        dimensions: {
            type: "object",
            properties: {
                width: {
                    type: "number",
                    default: WINDOW_MIN_WIDTH,
                },
                height: {
                    type: "number",
                    default: WINDOW_MIN_HEIGHT,
                },
            },
            required: ["width", "height"],
        },
        position: {
            type: "object",
            properties: {
                x: {
                    type: "number",
                },
                y: {
                    type: "number",
                },
            },
            required: ["x", "y"],
        },
    },
});

let mainWindow: BrowserWindow | null = null;
let switchingInstallation = false;
const startupRoutes = ["/home", "/setup", "/installations"] as const;
type StartupRoute = typeof startupRoutes[number];
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();

async function createWindow(startupRoute: StartupRoute = "/installations", previousWindow: BrowserWindow | null = null) {
    const previousBounds = previousWindow?.getBounds();
    const win = new BrowserWindow({
        minWidth: WINDOW_MIN_WIDTH,
        minHeight: WINDOW_MIN_HEIGHT,
        width: previousBounds?.width ?? windowStore.get("dimensions.width"),
        height: previousBounds?.height ?? windowStore.get("dimensions.height"),
        x: previousBounds?.x ?? windowStore.get("position.x"),
        y: previousBounds?.y ?? windowStore.get("position.y"),
        show: false,
        transparent: false,
        frame: false,
        webPreferences: {
            // preload: join(__dirname, 'preload.js'),
            nodeIntegration: true,
            contextIsolation: false,
        },
    });

    win.on("close", () => {
        const bounds = win.getBounds();

        windowStore.set("dimensions", {
            width: bounds.width,
            height: bounds.height,
        });

        windowStore.set("position", {
            x: bounds.x,
            y: bounds.y,
        });
    });

    win.on("closed", () => {
        if (mainWindow === win) mainWindow = null;
    });
    enable(win.webContents);

    // Native Node modules (notably USB) cannot safely survive a renderer reload.
    // A new BrowserWindow receives a fresh renderer process and isolated singletons.
    let timeout: NodeJS.Timeout | undefined;
    const ready = new Promise<void>(resolve => win.once("ready-to-show", () => resolve()));
    const load = process.env.NODE_ENV === "development"
        ? win.loadURL(`http://localhost:${process.argv[2]}?startupRoute=${encodeURIComponent(startupRoute)}`)
        : win.loadFile(join(app.getAppPath(), "renderer", "index.html"), { query: { startupRoute } });
    try {
        await Promise.race([
            Promise.all([load, ready]),
            new Promise<never>((_, reject) => {
                timeout = setTimeout(() => reject(new Error("The new installation window did not finish loading.")), 30000);
            }),
        ]);
        mainWindow = win;
        if (previousWindow?.isMaximized()) win.maximize();
        win.show();
        if (previousWindow && !previousWindow.isDestroyed()) previousWindow.close();
        return win;
    } catch (error) {
        if (!win.isDestroyed()) win.destroy();
        throw error;
    } finally {
        if (timeout) clearTimeout(timeout);
    }
}

ipcMain.on("winboat:open-installation", async (event, route: unknown) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame || switchingInstallation ||
        !startupRoutes.includes(route as StartupRoute)) return;
    switchingInstallation = true;
    const previousWindow = mainWindow;
    try {
        await createWindow(route as StartupRoute, previousWindow);
    } catch (error) {
        if (!previousWindow.isDestroyed()) {
            await dialog.showMessageBox(previousWindow, {
                type: "error",
                title: "Could not open installation",
                message: "The previous window has been preserved. Close and reopen WinBoat to load the selected installation.",
                detail: error instanceof Error ? error.message : String(error),
            });
        }
    } finally {
        switchingInstallation = false;
    }
});

app.whenReady().then(() => {
    if (!primaryInstance) return;

    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        callback({
            responseHeaders: {
                ...details.responseHeaders,
                // 'Content-Security-Policy': ['script-src \'self\'']
                "Content-Security-Policy": [
                    "script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' 'unsafe-inline'",
                    "worker-src 'self' blob:",
                    "media-src 'self' blob:",
                    "font-src 'self' 'unsafe-inline' https://fonts.gstatic.com;",
                    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
                ],
            },
        });
    });

    const openInitialWindow = () => createWindow().catch(error => {
        dialog.showErrorBox("Could not start WinBoat", error instanceof Error ? error.message : String(error));
        app.quit();
    });
    void openInitialWindow();

    app.on("activate", function () {
        // On macOS it's common to re-create a window in the app when the
        // dock icon is clicked and there are no other windows open.
        if (BrowserWindow.getAllWindows().length === 0) {
            void openInitialWindow();
        }
    });
});

app.on("window-all-closed", function () {
    if (process.platform !== "darwin") app.quit();
});

app.on("second-instance", _ => {
    if (mainWindow) {
        mainWindow.focus();
    }
});

ipcMain.on("message", (_event, message) => {
    console.log(message);
});
