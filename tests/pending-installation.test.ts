import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import type { ComposeConfig } from "../src/types";
import { InstallationStore } from "../src/renderer/lib/installations";
import {
    beginPendingInstallation,
    readPendingInstallation,
    markPendingOemReady,
    completePendingInstallation,
    pendingInstallConfiguration,
    pendingComposePath,
    planPendingResume,
    PENDING_INSTALLATION_FILE,
} from "../src/renderer/lib/pending-installation";

const roots: string[] = [];
function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "winboat-resume-test-"));
    roots.push(root);
    const store = new InstallationStore({ root });
    const profile = store.active();
    const compose = {
        name: profile.projectName,
        volumes: { data: null },
        services: {
            windows: {
                container_name: profile.containerName,
                image: "ghcr.io/dockur/windows:6.03",
                environment: {
                    VERSION: "11",
                    LANGUAGE: "English",
                    CPU_CORES: "2",
                    RAM_SIZE: "4G",
                    DISK_SIZE: "64G",
                    USERNAME: "saved-user",
                    PASSWORD: "saved-password",
                },
                volumes: [`${profile.storagePath}:/storage`, "/test/shared:/shared"],
                ports: ["127.0.0.1:47270:8006"],
                restart: "no",
            },
        },
    } as ComposeConfig;
    return { root, store, profile, compose };
}
afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test("can recover exact saved configuration after compose write or image pull failure", () => {
    const { root, profile, compose } = fixture();
    beginPendingInstallation(profile, root, "Docker", compose);
    const pending = readPendingInstallation(profile, root);
    expect(pendingInstallConfiguration(pending)).toMatchObject({
        username: "saved-user",
        password: "saved-password",
        installFolder: profile.storagePath,
        ramGB: 4,
        cpuCores: 2,
    });
    expect(
        planPendingResume(pending, {
            composeExists: false,
            diskExists: false,
            containerStatus: "missing",
            oemAssetsPresent: false,
        }),
    ).toEqual({ restoreCompose: true, restoreOem: true });
    fs.writeFileSync(pendingComposePath(profile, pending), YAML.stringify(compose));
    markPendingOemReady(profile, root);
    expect(
        planPendingResume(readPendingInstallation(profile, root), {
            composeExists: true,
            diskExists: false,
            containerStatus: "missing",
            oemAssetsPresent: true,
        }),
    ).toEqual({ restoreCompose: false, restoreOem: false });
    expect(fs.statSync(path.join(profile.directory, PENDING_INSTALLATION_FILE)).mode & 0o777).toBe(0o600);
});

test("never enrolls imported or pre-existing compose into resumable setup", () => {
    const { root, profile, compose } = fixture();
    expect(() => beginPendingInstallation({ ...profile, id: "legacy" }, root, "Docker", compose)).toThrow("Only a new");
    fs.writeFileSync(path.join(profile.directory, "docker-compose.yml"), YAML.stringify(compose));
    expect(() => beginPendingInstallation(profile, root, "Docker", compose)).toThrow("Existing compose");
    expect(() => readPendingInstallation(profile, root)).toThrow("no saved setup");
});

test("rejects changed compose and cross-profile marker replay without overwriting either file", () => {
    const { root, store, profile, compose } = fixture();
    beginPendingInstallation(profile, root, "Docker", compose);
    const pending = readPendingInstallation(profile, root);
    const composePath = pendingComposePath(profile, pending);
    const changed = YAML.stringify({ ...compose, name: "something-else" });
    fs.writeFileSync(composePath, changed);
    expect(() => readPendingInstallation(profile, root)).toThrow("changed since setup");
    expect(fs.readFileSync(composePath, "utf8")).toBe(changed);
    const other = store.create("Other");
    fs.copyFileSync(
        path.join(profile.directory, PENDING_INSTALLATION_FILE),
        path.join(other.directory, PENDING_INSTALLATION_FILE),
    );
    expect(() => readPendingInstallation(other, root)).toThrow("belongs to another");
});

test("resumes an already-created disk/container without regenerating OEM or compose", () => {
    const { root, profile, compose } = fixture();
    beginPendingInstallation(profile, root, "Docker", compose);
    const pending = readPendingInstallation(profile, root);
    pending.oemReady = true;
    const existing = { composeExists: true, diskExists: true, containerStatus: "running", oemAssetsPresent: true };
    expect(planPendingResume(pending, existing)).toEqual({ restoreCompose: false, restoreOem: false });
    expect(() => planPendingResume(pending, { ...existing, composeExists: false })).toThrow("Restore the compose");
    expect(() => planPendingResume(pending, { ...existing, oemAssetsPresent: false })).toThrow(
        "OEM assets are incomplete",
    );
    expect(() => planPendingResume(pending, { ...existing, containerStatus: "unknown" })).toThrow("Cannot verify");
});

test("completion removes only recovery metadata and preserves disk and settings", () => {
    const { root, profile, compose } = fixture();
    beginPendingInstallation(profile, root, "Docker", compose);
    fs.mkdirSync(profile.storagePath);
    fs.writeFileSync(path.join(profile.storagePath, "data.img"), "keep Windows");
    fs.writeFileSync(path.join(profile.directory, "docker-compose.yml"), YAML.stringify(compose));
    completePendingInstallation(profile);
    expect(fs.existsSync(path.join(profile.directory, PENDING_INSTALLATION_FILE))).toBe(false);
    expect(fs.readFileSync(path.join(profile.storagePath, "data.img"), "utf8")).toBe("keep Windows");
    expect(fs.readFileSync(path.join(profile.directory, "docker-compose.yml"), "utf8")).toBe(YAML.stringify(compose));
});

test("a second fresh setup cannot replace saved credentials after a failed compose write", () => {
    const { root, profile, compose } = fixture();
    beginPendingInstallation(profile, root, "Docker", compose);
    compose.services.windows.environment.PASSWORD = "replacement";
    expect(() => beginPendingInstallation(profile, root, "Docker", compose)).toThrow("saved setup already exists");
    expect(readPendingInstallation(profile, root).compose.services.windows.environment.PASSWORD).toBe("saved-password");
});

test("a changed runtime cannot resume the same disk under a different engine", () => {
    const { root, profile, compose } = fixture();
    beginPendingInstallation(profile, root, "Docker", compose);
    expect(() => readPendingInstallation({ ...profile, runtime: "Podman" }, root)).toThrow("invalid or belongs");
});
