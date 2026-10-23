import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import {
    InstallationStore,
    portsForSlot,
    portsFromBindings,
    portsFromCompose,
    reservedComposePorts,
    type InstallationStatus,
} from "../src/renderer/lib/installations";

const temporaryDirectories: string[] = [];
function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "winboat-installations-test-"));
    temporaryDirectories.push(root);
    const states = new Map<string, InstallationStatus>();
    const store = new InstallationStore({
        root: path.join(root, "data"),
        legacyDirectory: path.join(root, "legacy"),
        status: async entry => states.get(entry.id) ?? "missing",
    });
    return { root, states, store };
}
function seedLegacy(
    directory: string,
    ports: string[] = ["127.0.0.1:8006:8006", "127.0.0.1:7148:7148", "127.0.0.1:8149:7149", "127.0.0.1:3389:3389/tcp"],
) {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
        path.join(directory, "winboat.config.json"),
        JSON.stringify({ containerRuntime: "Docker", customApps: ["keep me"] }),
    );
    const compose = YAML.stringify({
        name: "winboat",
        services: {
            windows: {
                container_name: "WinBoat",
                image: "ghcr.io/dockur/windows:5.14",
                ports,
                volumes: [`${path.join(directory, "storage")}:/storage`, "./oem:/oem"],
            },
        },
    });
    fs.writeFileSync(path.join(directory, "docker-compose.yml"), compose);
    fs.mkdirSync(path.join(directory, "storage"));
    fs.writeFileSync(path.join(directory, "storage", "data.img"), "existing Windows disk");
    return compose;
}
afterEach(() => {
    for (const dir of temporaryDirectories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("installation registry", () => {
    test("adopts existing legacy Windows without rewriting its compose, config or disk", () => {
        const { root, store } = fixture();
        const legacy = path.join(root, "legacy");
        const compose = seedLegacy(legacy);
        const config = fs.readFileSync(path.join(legacy, "winboat.config.json"), "utf8");
        const active = store.active();
        expect(active.id).toBe("legacy");
        expect(active.containerName).toBe("WinBoat");
        expect(active.projectName).toBe("winboat");
        expect(active.directory).toBe(legacy);
        expect(active.ports).toEqual({ novnc: 8006, api: 7148, qmp: 8149, rdp: 3389, update: 47274 });
        expect(fs.readFileSync(path.join(legacy, "docker-compose.yml"), "utf8")).toBe(compose);
        expect(fs.readFileSync(path.join(legacy, "winboat.config.json"), "utf8")).toBe(config);
        expect(fs.readFileSync(path.join(legacy, "storage", "data.img"), "utf8")).toBe("existing Windows disk");
    });

    test("an adopted XDG root permits new managed storage below its own profile directory", () => {
        const { store } = fixture();
        seedLegacy(store.root);
        const original = store.active();
        const other = store.create("New Windows");
        // Change selection in the fixture's registry; no container is running.
        const registry = JSON.parse(fs.readFileSync(store.registryPath, "utf8"));
        registry.activeId = other.id;
        fs.writeFileSync(store.registryPath, JSON.stringify(registry));
        expect(store.validateStoragePath(other.storagePath)).toBe(other.storagePath);
        expect(() => store.validateStoragePath(original.storagePath)).toThrow("overlaps");
        expect(() => store.validateStoragePath(store.root)).toThrow("overlaps");
    });

    test("creates persistent isolated profiles and rejects duplicate/empty names", () => {
        const { store } = fixture();
        const original = store.active();
        const work = store.create("  Work  ");
        const testing = store.create("Testing");
        expect(store.active().id).toBe(original.id);
        expect(work.name).toBe("Work");
        expect(new Set([original, work, testing].map(item => item.directory)).size).toBe(3);
        expect(new Set([original, work, testing].map(item => item.containerName)).size).toBe(3);
        expect(new Set([original, work, testing].map(item => item.projectName)).size).toBe(3);
        expect(new Set([original, work, testing].flatMap(item => Object.values(item.ports))).size).toBe(15);
        expect(work.storagePath).toBe(path.join(work.directory, "storage"));
        expect(() => store.create("WORK")).toThrow("already exists");
        expect(() => store.create("  ")).toThrow("between 1 and 80");
        expect(() => store.rename(testing.id, "work")).toThrow("already exists");
        store.rename(work.id, "Office");
        expect(new InstallationStore({ root: store.root }).get(work.id).name).toBe("Office");
    });

    test("reserves all old port ranges before allocating new profiles", () => {
        const { root, store } = fixture();
        seedLegacy(path.join(root, "legacy"), [
            "127.0.0.1:47270-47279:8006",
            "127.0.0.1:47280-47289:7148",
            "127.0.0.1:47290-47299:7149",
            "127.0.0.1:47300-47309:3389/tcp",
            "127.0.0.1:47310-47319:3389/udp",
        ]);
        expect(store.active().ports.api).toBe(47280);
        expect(store.active().ports.rdp).toBe(47300);
        const other = store.create("Another Windows");
        expect(other.ports.novnc).toBe(47320);
        expect(Object.values(other.ports).every(port => port >= 47320)).toBe(true);
    });

    test("fails closed for damaged registry instead of silently replacing user data", () => {
        const { store } = fixture();
        store.active();
        fs.writeFileSync(store.registryPath, '{"version":99,"installations":[]}');
        expect(() => store.list()).toThrow("Invalid installation registry");
        expect(fs.readFileSync(store.registryPath, "utf8")).toBe('{"version":99,"installations":[]}');
    });

    test("rejects duplicate registry containers or directories rather than aliasing installations", () => {
        const { store } = fixture();
        store.active();
        store.create("Other");
        const registry = JSON.parse(fs.readFileSync(store.registryPath, "utf8"));
        registry.installations[1].containerName = registry.installations[0].containerName;
        fs.writeFileSync(store.registryPath, JSON.stringify(registry));
        expect(() => store.list()).toThrow("Duplicate installation");
    });

    test("checks runtime state even if a running installation's compose file is missing", async () => {
        const { root } = fixture();
        const store = new InstallationStore({ root: path.join(root, "runtime-data") });
        const active = store.active();
        const commands = path.join(root, "fake-runtime");
        fs.mkdirSync(commands);
        fs.writeFileSync(path.join(commands, "docker"), '#!/bin/sh\nprintf "WinBoat-default\\trunning\\n"\n', {
            mode: 0o755,
        });
        const oldPath = process.env.PATH;
        try {
            process.env.PATH = commands;
            expect(await store.getStatus(active.id)).toBe("running");
            const other = store.create("Other");
            await expect(store.select(other.id)).rejects.toThrow("Stop");
        } finally {
            process.env.PATH = oldPath;
        }
    });

    test("adopts canonical paths through compatibility symlinks without changing compose", () => {
        const { root } = fixture();
        const physical = path.join(root, "organized", "legacy");
        const compose = seedLegacy(physical);
        const alias = path.join(root, "old-location");
        fs.symlinkSync(physical, alias);
        const store = new InstallationStore({ root: path.join(root, "organized"), legacyDirectory: alias });
        expect(store.active().directory).toBe(physical);
        expect(store.active().storagePath).toBe(path.join(physical, "storage"));
        expect(fs.readFileSync(path.join(physical, "docker-compose.yml"), "utf8")).toBe(compose);
    });

    test("does not reuse existing profile folders without a registry", () => {
        const { store } = fixture();
        const directory = path.join(store.root, "installations", "default");
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, "data.img"), "existing disk");
        expect(() => store.active()).toThrow("Refusing to reuse");
        expect(fs.readFileSync(path.join(directory, "data.img"), "utf8")).toBe("existing disk");
    });

    test("switching checks stopped state and persists only after a successful check", async () => {
        const { store, states } = fixture();
        const original = store.active();
        const other = store.create("Other");
        for (const status of ["running", "paused", "restarting", "unknown"] as const) {
            states.set(original.id, status);
            await expect(store.select(other.id)).rejects.toThrow();
            expect(store.active().id).toBe(original.id);
        }
        states.set(original.id, "exited");
        await store.select(other.id);
        expect(store.active().id).toBe(other.id);
    });

    test("start checks every other registered installation including unavailable runtimes", async () => {
        const { store, states } = fixture();
        const current = store.active();
        const other = store.create("Work");
        for (const status of ["running", "paused", "restarting", "unknown"] as const) {
            states.set(other.id, status);
            await expect(store.assertCanStart(current.id)).rejects.toThrow();
        }
        states.set(other.id, "exited");
        await store.assertCanStart(current.id);
    });

    test("serializes lifecycle operations and releases the lock on failure", async () => {
        const { store } = fixture();
        let release!: () => void;
        const pending = store.withOperationLock(
            () =>
                new Promise<void>(resolve => {
                    release = resolve;
                }),
        );
        await expect(store.withOperationLock(async () => {})).rejects.toThrow("in progress");
        release();
        await pending;
        await expect(
            store.withOperationLock(async () => {
                throw new Error("failed");
            }),
        ).rejects.toThrow("failed");
        await store.withOperationLock(async () => {});
    });

    test("rejects storage overlap and symlink aliases without modifying disks", async () => {
        const { root, store } = fixture();
        seedLegacy(path.join(root, "legacy"));
        const original = store.active();
        const other = store.create("Other");
        await store.select(other.id);
        expect(() => store.validateStoragePath(original.storagePath)).toThrow("overlaps");
        expect(() => store.validateStoragePath(path.dirname(original.directory))).toThrow("overlaps");
        const alias = path.join(root, "alias");
        fs.symlinkSync(original.storagePath, alias);
        expect(() => store.validateStoragePath(alias)).toThrow("overlaps");
        expect(store.validateStoragePath(other.storagePath)).toBe(other.storagePath);
        fs.mkdirSync(other.storagePath);
        fs.writeFileSync(path.join(other.storagePath, "data.img"), "keep");
        expect(() => store.validateStoragePath(other.storagePath)).toThrow("empty storage folder");
        expect(fs.readFileSync(path.join(other.storagePath, "data.img"), "utf8")).toBe("keep");
    });
});

describe("legacy and fixed ports", () => {
    test("resolves allocated TCP bindings rather than the legacy range starts or UDP port", () => {
        expect(
            portsFromBindings(
                {
                    "8006/tcp": [{ HostIp: "127.0.0.1", HostPort: "47272" }],
                    "7148/tcp": [{ HostIp: "127.0.0.1", HostPort: "47284" }],
                    "7149/tcp": [{ HostIp: "127.0.0.1", HostPort: "47295" }],
                    "3389/tcp": [{ HostIp: "127.0.0.1", HostPort: "47303" }],
                    "3389/udp": [{ HostIp: "127.0.0.1", HostPort: "47314" }],
                },
                portsForSlot(0),
            ),
        ).toEqual({ novnc: 47272, api: 47284, qmp: 47295, rdp: 47303, update: 47274 });
    });
    test("handles long compose port syntax and rejects invalid allocation slots", () => {
        const compose = {
            services: { windows: { ports: [{ target: 7148, published: 50123, host_ip: "127.0.0.1" }] } },
        };
        expect(portsFromCompose(compose, portsForSlot(0)).api).toBe(50123);
        expect(reservedComposePorts(compose)).toEqual([50123]);
        expect(() => portsForSlot(99999)).toThrow("No available");
        expect(() => portsForSlot(-1)).toThrow("No available");
    });
});

test("separate container names cannot share a compose project", () => {
    const { store } = fixture();
    store.active();
    store.create("Other");
    const registry = JSON.parse(fs.readFileSync(store.registryPath, "utf8"));
    registry.installations[1].projectName = registry.installations[0].projectName;
    fs.writeFileSync(store.registryPath, JSON.stringify(registry));
    expect(() => store.list()).toThrow("compose project");
});
