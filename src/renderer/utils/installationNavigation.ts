const { ipcRenderer }: typeof import("electron") = require("electron");

/** Use a fresh renderer process: reloading native USB modules can crash Electron. */
export function openInstallationWindow(route: "/home" | "/setup" | "/installations") {
    ipcRenderer.send("winboat:open-installation", route);
}
