import YAML from "yaml";
import type { ComposeConfig, InstallConfiguration } from "../../types";
import type { Installation } from "./installations";

const fs: typeof import("node:fs") = require("node:fs");
const path: typeof import("node:path") = require("node:path");
const crypto: typeof import("node:crypto") = require("node:crypto");

export const PENDING_INSTALLATION_FILE = ".pending-installation.json";
export type PendingInstallation = {
    version: 1;
    installationId: string;
    runtime: Installation["runtime"];
    compose: ComposeConfig;
    digest: string;
    oemReady: boolean;
};

function digest(compose: ComposeConfig): string {
    // Normalize through YAML because Docker and Podman use different quoting.
    return crypto
        .createHash("sha256")
        .update(JSON.stringify(YAML.parse(YAML.stringify(compose))))
        .digest("hex");
}
function markerPath(installation: Installation) {
    return path.join(installation.directory, PENDING_INSTALLATION_FILE);
}
function assertOwned(installation: Installation, root: string) {
    if (
        path.resolve(installation.directory) !== path.join(path.resolve(root), "installations", installation.id) ||
        installation.id.startsWith("legacy")
    ) {
        throw new Error(
            "Only a new Windows installation created by this manager can resume setup. Existing imported installations are preserved.",
        );
    }
}
function write(installation: Installation, marker: PendingInstallation) {
    const file = markerPath(installation);
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    try {
        fs.writeFileSync(temporary, JSON.stringify(marker, null, 2), { flag: "wx", mode: 0o600 });
        fs.renameSync(temporary, file);
    } finally {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
}
export function pendingComposePath(installation: Installation, marker: PendingInstallation) {
    return path.join(installation.directory, `${marker.runtime.toLowerCase()}-compose.yml`);
}

/** Record the exact new setup before writing compose so a failed write can be retried. */
export function beginPendingInstallation(
    installation: Installation,
    root: string,
    runtime: Installation["runtime"],
    compose: ComposeConfig,
) {
    assertOwned(installation, root);
    if (fs.existsSync(markerPath(installation))) {
        throw new Error(
            "A saved setup already exists for this installation. Resume it instead of replacing its configuration.",
        );
    }
    const marker: PendingInstallation = {
        version: 1,
        installationId: installation.id,
        runtime,
        compose,
        digest: digest(compose),
        oemReady: false,
    };
    if (fs.existsSync(pendingComposePath(installation, marker)))
        throw new Error("Existing compose files cannot be enrolled in setup recovery.");
    write(installation, marker);
}

export function readPendingInstallation(installation: Installation, root: string): PendingInstallation {
    assertOwned(installation, root);
    const file = markerPath(installation);
    if (!fs.existsSync(file)) throw new Error("This installation has no saved setup to resume.");
    const marker = JSON.parse(fs.readFileSync(file, "utf8")) as PendingInstallation;
    if (
        marker.version !== 1 ||
        marker.installationId !== installation.id ||
        marker.runtime !== installation.runtime ||
        !["Docker", "Podman"].includes(marker.runtime) ||
        typeof marker.oemReady !== "boolean" ||
        !marker.compose?.services?.windows ||
        marker.digest !== digest(marker.compose)
    ) {
        throw new Error(
            "The saved setup is invalid or belongs to another installation. Its Windows files have not been changed.",
        );
    }
    if (
        marker.compose.services.windows.container_name !== installation.containerName ||
        marker.compose.name !== installation.projectName
    ) {
        throw new Error("The saved setup container identity does not match this installation.");
    }
    const composeFile = pendingComposePath(installation, marker);
    if (fs.existsSync(composeFile) && digest(YAML.parse(fs.readFileSync(composeFile, "utf8"))) !== marker.digest) {
        throw new Error(
            "The saved compose file changed since setup began. Restore its saved settings before resuming; no existing files were overwritten.",
        );
    }
    return marker;
}

export function markPendingOemReady(installation: Installation, root: string) {
    const marker = readPendingInstallation(installation, root);
    marker.oemReady = true;
    write(installation, marker);
}
export function completePendingInstallation(installation: Installation) {
    const file = markerPath(installation);
    if (fs.existsSync(file)) fs.unlinkSync(file);
}

export function pendingInstallConfiguration(marker: PendingInstallation): InstallConfiguration {
    const service = marker.compose.services.windows;
    const volumeSource = (target: string) =>
        service.volumes.find(volume => volume.split(":")[1] === target)?.split(":")[0];
    const storage = volumeSource("/storage");
    if (!storage || !path.isAbsolute(storage))
        throw new Error("The saved setup does not point to an absolute Windows storage folder.");
    return {
        container: marker.runtime as InstallConfiguration["container"],
        installFolder: storage,
        windowsVersion: service.environment.VERSION,
        windowsLanguage: service.environment.LANGUAGE,
        cpuCores: Number(service.environment.CPU_CORES),
        ramGB: Number(service.environment.RAM_SIZE.replace(/G$/i, "")),
        diskSpaceGB: Number(service.environment.DISK_SIZE.replace(/G$/i, "")),
        username: service.environment.USERNAME,
        password: service.environment.PASSWORD,
        customIsoPath: volumeSource("/boot.iso"),
        sharedFolderPath: volumeSource("/shared"),
    };
}

/** Plan only non-destructive recovery steps from observed container/disk state. */
export function planPendingResume(
    marker: PendingInstallation,
    evidence: {
        composeExists: boolean;
        diskExists: boolean;
        containerStatus: string;
        oemAssetsPresent: boolean;
    },
): { restoreCompose: boolean; restoreOem: boolean } {
    if (evidence.containerStatus === "unknown") {
        throw new Error(
            "Cannot verify this installation's container state. Check its container runtime before resuming setup.",
        );
    }
    const alreadyStarted = evidence.diskExists || evidence.containerStatus !== "missing";
    if (!evidence.composeExists && alreadyStarted) {
        throw new Error(
            "Setup's compose file is missing, but Windows data or a container exists. Restore the compose file before resuming.",
        );
    }
    const restoreOem = !marker.oemReady || !evidence.oemAssetsPresent;
    if (restoreOem && alreadyStarted) {
        throw new Error(
            "Windows data or a container exists but setup's OEM assets are incomplete. Restore those assets before resuming; Windows files were preserved.",
        );
    }
    return { restoreCompose: !evidence.composeExists, restoreOem };
}
