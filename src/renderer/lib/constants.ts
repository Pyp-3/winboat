import { getActiveInstallation, getPublishedInstallationPorts } from "./installations";
const os: typeof import("os") = require("node:os");
const path: typeof import("path") = require("node:path");

// One profile is fixed for the renderer lifetime; switching reloads the renderer.
export const ACTIVE_INSTALLATION = getActiveInstallation();
export const WINBOAT_DIR = ACTIVE_INSTALLATION.directory;
export const DEFAULT_HOMEBREW_DIR = path.join(os.homedir(), "../linuxbrew/.linuxbrew/bin");

export const CONTAINER_LOG_FILE = path.join(WINBOAT_DIR, "container.log");

// Shared secret used to authenticate the host to the guest services. Generated
// once at install time and seeded into the guest via the OEM mount.
export const GUEST_TOKEN_PATH = path.join(WINBOAT_DIR, "guest_token");

export const WINDOWS_VERSIONS = {
    "11": "Windows 11 Pro",
    "11l": "Windows 11 LTSC 2024",
    "11e": "Windows 11 Enterprise",
    "10": "Windows 10 Pro",
    "10l": "Windows 10 LTSC 2021",
    "10e": "Windows 10 Enterprise",
    custom: "Custom Windows",
};

export type WindowsVersionKey = keyof typeof WINDOWS_VERSIONS;

// RAM requirements and allocation defaults
export const MIN_HOST_RAM_GB = 4;
export const MIN_VM_RAM_GB = 2;
export const RECOMMENDED_VM_RAM_GB = 4;

export const WINDOWS_LANGUAGES = {
    "🇦🇪 Arabic": "Arabic",
    "🇧🇬 Bulgarian": "Bulgarian",
    "🇨🇳 Chinese": "Chinese",
    "🇭🇷 Croatian": "Croatian",
    "🇨🇿 Czech": "Czech",
    "🇩🇰 Danish": "Danish",
    "🇳🇱 Dutch": "Dutch",
    "🇬🇧 English": "English",
    "🇪🇪 Estonian": "Estonian",
    "🇫🇮 Finnish": "Finnish",
    "🇫🇷 French": "French",
    "🇩🇪 German": "German",
    "🇬🇷 Greek": "Greek",
    "🇮🇱 Hebrew": "Hebrew",
    "🇭🇺 Hungarian": "Hungarian",
    "🇮🇹 Italian": "Italian",
    "🇯🇵 Japanese": "Japanese",
    "🇰🇷 Korean": "Korean",
    "🇱🇻 Latvian": "Latvian",
    "🇱🇹 Lithuanian": "Lithuanian",
    "🇳🇴 Norwegian": "Norwegian",
    "🇵🇱 Polish": "Polish",
    "🇵🇹 Portuguese": "Portuguese",
    "🇷🇴 Romanian": "Romanian",
    "🇷🇺 Russian": "Russian",
    "🇷🇸 Serbian": "Serbian",
    "🇸🇰 Slovak": "Slovak",
    "🇸🇮 Slovenian": "Slovenian",
    "🇪🇸 Spanish": "Spanish",
    "🇸🇪 Swedish": "Swedish",
    "🇹🇭 Thai": "Thai",
    "🇹🇷 Turkish": "Turkish",
    "🇺🇦 Ukrainian": "Ukrainian",
};

// Ports
// Each new installation receives a separate loopback port block. Existing
// installations retain their published ports (including legacy port ranges).
export const GUEST_NOVNC_PORT = 8006;
export const GUEST_API_PORT = 7148;
export const GUEST_QMP_PORT = 7149;
export const GUEST_UPDATE_PORT = 7150;
export const GUEST_RDP_PORT = 3389;

export let HOST_NOVNC_PORT = ACTIVE_INSTALLATION.ports.novnc;
export let HOST_API_PORT = ACTIVE_INSTALLATION.ports.api;
export let HOST_QMP_PORT = ACTIVE_INSTALLATION.ports.qmp;
export let HOST_RDP_PORT = ACTIVE_INSTALLATION.ports.rdp;
export let HOST_UPDATE_PORT = ACTIVE_INSTALLATION.ports.update;

export let NOVNC_URL = `http://127.0.0.1:${HOST_NOVNC_PORT}`;
export let WINBOAT_API_URL = `http://127.0.0.1:${HOST_API_PORT}`;
export let WINBOAT_UPDATE_URL = `http://127.0.0.1:${HOST_UPDATE_PORT}`;

// Legacy WinBoat assigned a range of possible host ports. Read the actual
// bindings after every boot; never rewrite or recreate its Windows container.
export async function refreshActiveInstallationPorts(): Promise<void> {
    const ports = await getPublishedInstallationPorts(getActiveInstallation());
    HOST_NOVNC_PORT = ports.novnc;
    HOST_API_PORT = ports.api;
    HOST_QMP_PORT = ports.qmp;
    HOST_RDP_PORT = ports.rdp;
    HOST_UPDATE_PORT = ports.update;
    NOVNC_URL = `http://127.0.0.1:${HOST_NOVNC_PORT}`;
    WINBOAT_API_URL = `http://127.0.0.1:${HOST_API_PORT}`;
    WINBOAT_UPDATE_URL = `http://127.0.0.1:${HOST_UPDATE_PORT}`;
}

export const QMP_ARGUMENT = `-qmp tcp:0.0.0.0:${GUEST_QMP_PORT},server,wait=off`;
export const QMP_PORT_MAPPING = `127.0.0.1:${HOST_QMP_PORT}:${GUEST_QMP_PORT}`;

export const COMPOSE_PORT_MAPPINGS = [
    `127.0.0.1:${HOST_NOVNC_PORT}:${GUEST_NOVNC_PORT}`, // noVNC Web Interface
    `127.0.0.1:${HOST_API_PORT}:${GUEST_API_PORT}`, // WinBoat Guest Server API
    `127.0.0.1:${HOST_UPDATE_PORT}:${GUEST_UPDATE_PORT}`, // WinBoat Guest Server Updater
    QMP_PORT_MAPPING, // QEMU QMP
    `127.0.0.1:${HOST_RDP_PORT}:${GUEST_RDP_PORT}/tcp`, // RDP
    `127.0.0.1:${HOST_RDP_PORT}:${GUEST_RDP_PORT}/udp`, // RDP
];

// USB
export const USB_CLASS_IMAGING = 6;
export const USB_INTERFACE_MTP = 5;
export const USB_VID_BLACKLIST = [
    // Linux Foundation VID
    "1d6b:",
];

// Docker Restart Policies
export const RESTART_UNLESS_STOPPED = "unless-stopped";
export const RESTART_ON_FAILURE = "on-failure";
export const RESTART_ALWAYS = "always";
export const RESTART_NO = "no";

/** Restart policies under which the container comes back up on its own */
export const AUTOSTART_RESTART_POLICIES: string[] = [RESTART_UNLESS_STOPPED, RESTART_ALWAYS];
