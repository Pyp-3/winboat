import YAML from "yaml";
import { execFileAsync } from "./exec-helper";

const fs: typeof import("node:fs") = require("node:fs");
const path: typeof import("node:path") = require("node:path");
const os: typeof import("node:os") = require("node:os");
const crypto: typeof import("node:crypto") = require("node:crypto");
const process: typeof import("node:process") = require("node:process");

export type InstallationPorts = { novnc: number; api: number; qmp: number; rdp: number; update: number };
export type Installation = {
    id: string;
    name: string;
    directory: string;
    storagePath: string;
    containerName: string;
    projectName: string;
    runtime: "Docker" | "Podman";
    ports: InstallationPorts;
};
export type InstallationStatus = "running" | "paused" | "restarting" | "exited" | "created" | "missing" | "unknown";
type Registry = { version: 1; activeId: string; installations: Installation[] };
type StoreOptions = {
    root: string;
    legacyDirectory?: string;
    status?: (installation: Installation) => Promise<InstallationStatus>;
};
const ACTIVE_STATES: InstallationStatus[] = ["running", "paused", "restarting", "unknown"];
const PORT_TARGETS: Record<keyof InstallationPorts, number> = {
    novnc: 8006,
    api: 7148,
    qmp: 7149,
    rdp: 3389,
    update: 7150,
};

/** Resolve existing symlinks without creating a not-yet-installed storage folder. */
function physicalPath(value: string): string {
    const absolute = path.resolve(value);
    if (fs.existsSync(absolute)) return fs.realpathSync(absolute);
    return path.join(physicalPath(path.dirname(absolute)), path.basename(absolute));
}

export function portsForSlot(slot: number): InstallationPorts {
    const base = 47270 + slot * 10;
    if (!Number.isInteger(slot) || slot < 0 || base + 4 > 65535)
        throw new Error("No available WinBoat port range remains.");
    return { novnc: base, api: base + 1, qmp: base + 2, rdp: base + 3, update: base + 4 };
}

function readCompose(directory: string, runtime: Installation["runtime"]): any | null {
    const file = path.join(directory, `${runtime.toLowerCase()}-compose.yml`);
    if (!fs.existsSync(file)) return null;
    const compose = YAML.parse(fs.readFileSync(file, "utf8"));
    if (!compose?.services?.windows) throw new Error(`Invalid Windows compose file: ${file}`);
    return compose;
}

function runtimeFor(directory: string): Installation["runtime"] {
    const config = path.join(directory, "winboat.config.json");
    if (fs.existsSync(config)) {
        const runtime = JSON.parse(fs.readFileSync(config, "utf8")).containerRuntime;
        if (runtime === "Docker" || runtime === "Podman") return runtime;
        throw new Error(`Unsupported container runtime in ${config}`);
    }
    return fs.existsSync(path.join(directory, "podman-compose.yml")) ? "Podman" : "Docker";
}

function storageFromCompose(compose: any, directory: string): string | undefined {
    for (const volume of compose?.services?.windows?.volumes ?? []) {
        if (typeof volume === "object" && volume.target === "/storage" && volume.type === "bind") {
            return path.resolve(directory, volume.source);
        }
        if (typeof volume !== "string") continue;
        const [source, target] = volume.split(":");
        if (target === "/storage" && (path.isAbsolute(source) || source.startsWith(".")))
            return path.resolve(directory, source);
    }
}

/** Read published host ports, including old releases' 8006/7148/8149/3389 mappings. */
export function portsFromCompose(compose: any, defaults: InstallationPorts): InstallationPorts {
    const ports = { ...defaults };
    for (const mapping of compose?.services?.windows?.ports ?? []) {
        if (
            (typeof mapping === "string" && mapping.endsWith("/udp")) ||
            (typeof mapping === "object" && mapping?.protocol === "udp")
        )
            continue;
        let published: number, target: number;
        if (typeof mapping === "object" && mapping !== null) {
            published = Number(mapping.published);
            target = Number(mapping.target);
        } else {
            const pieces = String(mapping).split("/")[0].split(":");
            if (pieces.length < 2) continue;
            target = Number(pieces.at(-1));
            published = Number(pieces.at(-2)?.split("-")[0]);
        }
        if (!Number.isInteger(published) || published < 1 || published > 65535) continue;
        for (const key of Object.keys(PORT_TARGETS) as (keyof InstallationPorts)[]) {
            if (target === PORT_TARGETS[key]) ports[key] = published;
        }
    }
    return ports;
}

/** Reserve entire legacy published ranges, even while their containers are stopped. */
export function reservedComposePorts(compose: any): number[] {
    const reserved: number[] = [];
    for (const mapping of compose?.services?.windows?.ports ?? []) {
        const published =
            typeof mapping === "object" && mapping !== null
                ? String(mapping.published)
                : String(mapping).split("/")[0].split(":").at(-2);
        if (!published) continue;
        const [first, last = first] = published.split("-").map(Number);
        if (!Number.isInteger(first) || !Number.isInteger(last) || first < 1 || last > 65535 || last < first) continue;
        for (let port = first; port <= last; port++) reserved.push(port);
    }
    return reserved;
}

/** Resolve host ports allocated by Docker for old compose port ranges. */
export async function getPublishedInstallationPorts(installation: Installation): Promise<InstallationPorts> {
    const { stdout } = await execFileAsync(
        installation.runtime.toLowerCase(),
        ["inspect", "--format={{json .NetworkSettings.Ports}}", installation.containerName],
        { timeout: 15000 },
    );
    const bindings = JSON.parse(stdout);
    const compose = readCompose(installation.directory, installation.runtime);
    for (const mapping of compose?.services?.windows?.ports ?? []) {
        if (
            (typeof mapping === "string" && mapping.endsWith("/udp")) ||
            (typeof mapping === "object" && mapping?.protocol === "udp")
        )
            continue;
        const target =
            typeof mapping === "object"
                ? Number(mapping.target)
                : Number(String(mapping).split("/")[0].split(":").at(-1));
        if (Object.values(PORT_TARGETS).includes(target) && !bindings?.[`${target}/tcp`]?.length) {
            throw new Error(
                `The running container has not published its Windows service port ${target}. Wait for it to start, then try again.`,
            );
        }
    }
    return portsFromBindings(bindings, installation.ports);
}

export function portsFromBindings(
    bindings: Record<string, { HostIp: string; HostPort: string }[] | null> | null,
    defaults: InstallationPorts,
): InstallationPorts {
    const result = { ...defaults };
    for (const key of Object.keys(PORT_TARGETS) as (keyof InstallationPorts)[]) {
        const published = bindings?.[`${PORT_TARGETS[key]}/tcp`];
        if (!published?.length) continue;
        const binding = published.find(port => port.HostIp === "127.0.0.1") ?? published[0];
        const port = Number(binding.HostPort);
        if (Number.isInteger(port) && port > 0 && port <= 65535) result[key] = port;
    }
    return result;
}

async function readStatus(installation: Installation): Promise<InstallationStatus> {
    // A missing compose file does not prove that its container is stopped.
    // Always ask the runtime, including for partially installed profiles.
    try {
        // A successful `ps -a` distinguishes a missing container from an unavailable daemon.
        const { stdout } = await execFileAsync(
            installation.runtime.toLowerCase(),
            ["ps", "-a", "--format", "{{.Names}}\t{{.State}}"],
            { timeout: 15000 },
        );
        const line = stdout.split("\n").find(line => line.split("\t")[0] === installation.containerName);
        if (!line) return "missing";
        const state = line.split("\t")[1]?.toLowerCase();
        if (state === "running" || state === "paused" || state === "restarting" || state === "created") return state;
        if (state === "exited" || state === "stopped" || state === "dead") return "exited";
        return "unknown";
    } catch {
        return "unknown";
    }
}

/** Registry operations never move, overwrite or delete an existing Windows installation. */
export class InstallationStore {
    readonly root: string;
    readonly registryPath: string;
    private readonly status: (installation: Installation) => Promise<InstallationStatus>;

    constructor(private readonly options: StoreOptions) {
        this.root = physicalPath(options.root);
        this.registryPath = path.join(this.root, "installations.json");
        this.status = options.status ?? readStatus;
    }

    private save(registry: Registry) {
        fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
        const temporary = `${this.registryPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
        try {
            fs.writeFileSync(temporary, JSON.stringify(registry, null, 2) + "\n", { mode: 0o600, flag: "wx" });
            fs.renameSync(temporary, this.registryPath);
        } finally {
            if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
        }
    }

    private validate(registry: Registry): Registry {
        if (registry?.version !== 1 || !Array.isArray(registry.installations) || !registry.installations.length) {
            throw new Error(
                `Invalid installation registry at ${this.registryPath}. Restore its backup before continuing.`,
            );
        }
        const ids = new Set<string>();
        const directories = new Set<string>();
        const containers = new Set<string>();
        const projects = new Set<string>();
        for (const entry of registry.installations) {
            if (
                !entry ||
                !/^[a-zA-Z0-9_-]+$/.test(entry.id) ||
                ids.has(entry.id) ||
                typeof entry.name !== "string" ||
                !entry.name.trim() ||
                !path.isAbsolute(entry.directory) ||
                !path.isAbsolute(entry.storagePath) ||
                !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(entry.containerName) ||
                !/^[a-z0-9][a-z0-9_-]*$/.test(entry.projectName) ||
                !["Docker", "Podman"].includes(entry.runtime) ||
                Object.keys(PORT_TARGETS).some(
                    key =>
                        !Number.isInteger(entry.ports?.[key as keyof InstallationPorts]) ||
                        entry.ports[key as keyof InstallationPorts] < 1 ||
                        entry.ports[key as keyof InstallationPorts] > 65535,
                )
            ) {
                throw new Error(`Invalid installation entry in ${this.registryPath}. No files have been changed.`);
            }
            const directory = fs.existsSync(entry.directory)
                ? fs.realpathSync(entry.directory)
                : path.resolve(entry.directory);
            const container = `${entry.runtime}:${entry.containerName}`;
            const project = `${entry.runtime}:${entry.projectName}`;
            if (directories.has(directory) || containers.has(container) || projects.has(project)) {
                throw new Error(
                    `Duplicate installation directory, container or compose project in ${this.registryPath}. No files have been changed.`,
                );
            }
            directories.add(directory);
            containers.add(container);
            projects.add(project);
            ids.add(entry.id);
        }
        if (!ids.has(registry.activeId)) throw new Error(`Active installation is missing from ${this.registryPath}.`);
        return registry;
    }

    private refresh(entry: Installation): Installation {
        const runtime = runtimeFor(entry.directory);
        const compose = readCompose(entry.directory, runtime);
        return {
            ...entry,
            runtime,
            ports: portsFromCompose(compose, entry.ports),
            storagePath: physicalPath(storageFromCompose(compose, entry.directory) ?? entry.storagePath),
        };
    }

    private load(): Registry {
        if (fs.existsSync(this.registryPath))
            return this.validate(JSON.parse(fs.readFileSync(this.registryPath, "utf8")));
        const installations: Installation[] = [];
        const seenDirectories = new Set<string>();
        for (const directory of [this.root, this.options.legacyDirectory].filter(Boolean) as string[]) {
            if (!fs.existsSync(directory)) continue;
            const real = fs.realpathSync(directory);
            if (seenDirectories.has(real)) continue;
            seenDirectories.add(real);
            if (
                !fs.existsSync(path.join(directory, "docker-compose.yml")) &&
                !fs.existsSync(path.join(directory, "podman-compose.yml"))
            )
                continue;
            const runtime = runtimeFor(directory);
            const compose = readCompose(directory, runtime);
            if (!compose) continue;
            const containerName = compose.services.windows.container_name;
            if (!containerName) throw new Error(`Existing compose file in ${directory} has no container name.`);
            if (installations.some(entry => entry.containerName === containerName && entry.runtime === runtime)) {
                throw new Error(
                    "Two existing WinBoat folders refer to the same container. Resolve the duplicate before continuing.",
                );
            }
            installations.push({
                id: installations.length ? `legacy-${installations.length + 1}` : "legacy",
                name: installations.length ? `Existing Windows ${installations.length + 1}` : "Existing Windows",
                directory: real,
                storagePath: physicalPath(storageFromCompose(compose, directory) ?? path.join(directory, "storage")),
                containerName,
                projectName: compose.name ?? "winboat",
                runtime,
                ports: portsFromCompose(compose, portsForSlot(installations.length)),
            });
        }
        if (!installations.length) installations.push(this.newEntry("Windows", [], "default"));
        const registry: Registry = { version: 1, activeId: installations[0].id, installations };
        this.validate(registry);
        this.save(registry);
        return registry;
    }

    private validateName(name: string, entries: Installation[], exceptId?: string): string {
        const trimmed = name.trim();
        if (!trimmed || trimmed.length > 80 || /[\x00-\x1f\x7f]/.test(trimmed))
            throw new Error("Use an installation name between 1 and 80 characters.");
        if (entries.some(entry => entry.id !== exceptId && entry.name.toLowerCase() === trimmed.toLowerCase())) {
            throw new Error("An installation with this name already exists.");
        }
        return trimmed;
    }

    private newEntry(name: string, entries: Installation[], id: string = crypto.randomUUID()): Installation {
        name = this.validateName(name, entries);
        const used = new Set(
            entries.flatMap(entry => {
                const refreshed = this.refresh(entry);
                return [
                    ...Object.values(refreshed.ports),
                    ...reservedComposePorts(readCompose(refreshed.directory, refreshed.runtime)),
                ];
            }),
        );
        let slot = 0;
        while (Object.values(portsForSlot(slot)).some(port => used.has(port))) slot++;
        const directory = path.join(this.root, "installations", id);
        if (fs.existsSync(directory)) throw new Error(`Refusing to reuse existing folder ${directory}.`);
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        return {
            id,
            name,
            directory,
            storagePath: path.join(directory, "storage"),
            containerName: `WinBoat-${id}`,
            projectName: `winboat-${id}`,
            runtime: "Docker",
            ports: portsForSlot(slot),
        };
    }

    list(): Installation[] {
        return this.load().installations.map(entry => this.refresh(entry));
    }
    active(): Installation {
        const registry = this.load();
        return this.refresh(registry.installations.find(entry => entry.id === registry.activeId)!);
    }
    get(id: string): Installation {
        const entry = this.list().find(entry => entry.id === id);
        if (!entry) throw new Error("This Windows installation no longer exists in the registry.");
        return entry;
    }
    create(name: string): Installation {
        const registry = this.load();
        const entry = this.newEntry(name, registry.installations);
        registry.installations.push(entry);
        this.save(registry);
        return entry;
    }
    rename(id: string, name: string): Installation {
        const registry = this.load();
        const entry = registry.installations.find(entry => entry.id === id);
        if (!entry) throw new Error("This Windows installation no longer exists in the registry.");
        entry.name = this.validateName(name, registry.installations, id);
        this.save(registry);
        return this.refresh(entry);
    }
    async getStatus(id: string): Promise<InstallationStatus> {
        return this.status(this.get(id));
    }

    async assertCanStart(id: string): Promise<void> {
        for (const entry of this.list()) {
            if (entry.id === id) continue;
            const status = await this.status(entry);
            if (ACTIVE_STATES.includes(status)) {
                throw new Error(
                    status === "unknown"
                        ? `Cannot verify whether “${entry.name}” is stopped. Check its container runtime before starting another Windows installation.`
                        : `Stop “${entry.name}” before starting another Windows installation. WinBoat runs one installation at a time.`,
                );
            }
        }
    }

    async select(id: string): Promise<void> {
        await this.withOperationLock(async () => {
            this.get(id);
            const current = this.active();
            if (current.id === id) return;
            const status = await this.status(current);
            if (ACTIVE_STATES.includes(status)) {
                throw new Error(
                    status === "unknown"
                        ? `Cannot verify whether “${current.name}” is stopped. Check its container runtime before switching.`
                        : `Stop “${current.name}” before switching installations.`,
                );
            }
            const registry = this.load();
            registry.activeId = id;
            this.save(registry);
        });
    }

    /** Serializes starts and switches, including multiple renderer requests. */
    async withOperationLock<T>(operation: () => Promise<T>): Promise<T> {
        fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
        const lockPath = path.join(this.root, ".installation-operation.lock");
        let handle: number;
        try {
            handle = fs.openSync(lockPath, "wx", 0o600);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            let stale = false;
            try {
                const pid = Number(fs.readFileSync(lockPath, "utf8"));
                if (Number.isInteger(pid) && pid > 0) {
                    try {
                        process.kill(pid, 0);
                    } catch (error) {
                        stale = (error as NodeJS.ErrnoException).code === "ESRCH";
                    }
                }
            } catch {
                /* Fail closed when ownership cannot be determined. */
            }
            if (!stale)
                throw new Error(
                    `Another installation operation is in progress. Wait for it to finish and try again. If WinBoat previously crashed, close every WinBoat window, then remove ${lockPath} before reopening it.`,
                );
            fs.unlinkSync(lockPath);
            handle = fs.openSync(lockPath, "wx", 0o600);
        }
        fs.writeFileSync(handle, String(process.pid));
        try {
            return await operation();
        } finally {
            fs.closeSync(handle);
            fs.unlinkSync(lockPath);
        }
    }

    validateStoragePath(storagePath: string): string {
        if (!path.isAbsolute(storagePath)) throw new Error("Choose an absolute Windows storage folder.");
        const target = physicalPath(storagePath);
        const active = this.active();
        for (const other of this.list()) {
            if (other.id === active.id) continue;
            for (const protectedPath of [other.storagePath, other.directory]) {
                const protectedReal = physicalPath(protectedPath);
                // Older XDG installs kept configuration directly in the registry
                // root. Its new profiles are intentional children of that root,
                // but may never overlap the old Windows storage itself.
                const ownDirectory = physicalPath(active.directory);
                if (
                    protectedPath === other.directory &&
                    protectedReal === physicalPath(this.root) &&
                    target.startsWith(ownDirectory + path.sep) &&
                    ownDirectory !== protectedReal
                )
                    continue;
                if (
                    target === protectedReal ||
                    target.startsWith(protectedReal + path.sep) ||
                    protectedReal.startsWith(target + path.sep)
                ) {
                    throw new Error(
                        `This folder overlaps “${other.name}”. Choose a separate empty Windows storage folder.`,
                    );
                }
            }
        }
        if (fs.existsSync(target) && (!fs.statSync(target).isDirectory() || fs.readdirSync(target).length)) {
            throw new Error("Choose an empty storage folder. Existing Windows disks are never overwritten by setup.");
        }
        return target;
    }
}

let store: InstallationStore | undefined;
export function getInstallationStore(): InstallationStore {
    return (store ??= new InstallationStore({
        root:
            process.env.WINBOAT_HOME ||
            path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "winboat-app"),
        legacyDirectory: process.env.WINBOAT_HOME ? undefined : path.join(os.homedir(), ".winboat"),
    }));
}
export const getInstallations = () => getInstallationStore().list();
export const getActiveInstallation = () => getInstallationStore().active();
export const createInstallation = (name: string) => getInstallationStore().create(name);
export const renameInstallation = (id: string, name: string) => getInstallationStore().rename(id, name);
export const selectInstallation = (id: string) => getInstallationStore().select(id);
export const getInstallationStatus = (id: string) => getInstallationStore().getStatus(id);
export const getDefaultStoragePath = () => getActiveInstallation().storagePath;

export async function withInstallationStart<T>(expectedId: string, operation: () => Promise<T>): Promise<T> {
    const store = getInstallationStore();
    return store.withOperationLock(async () => {
        if (store.active().id !== expectedId)
            throw new Error("The selected Windows installation changed. Reload WinBoat before continuing.");
        await store.assertCanStart(expectedId);
        return operation();
    });
}
