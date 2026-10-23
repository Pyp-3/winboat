import { ComposeConfig } from "../../../types";
import { PODMAN_DEFAULT_COMPOSE } from "../../data/podman";
import { ACTIVE_INSTALLATION, WINBOAT_DIR, refreshActiveInstallationPorts } from "../constants";
import { withInstallationStart } from "../installations";
import {
    ComposeArguments,
    ComposeDirection,
    ContainerAction,
    containerLogger,
    ContainerManager,
    ContainerStatus,
} from "./container";
import YAML from "yaml";
import { capitalizeFirstLetter } from "../../utils/capitalize";
import { concatEnv, execFileAsync, stringifyExecFile } from "../exec-helper";

const path: typeof import("node:path") = require("node:path");
const fs: typeof import("node:fs") = require("node:fs");
const process: typeof import("process") = require("node:process");

export type PodmanSpecs = {
    podmanInstalled: boolean;
    podmanComposeInstalled: boolean;
};

export enum PodmanAPIStatus {
    AVAILABLE = "Available",
    UNAVAILABLE = "Unavailable",
}

type PodmanInfo = {
    host: {
        remoteSocket: {
            exists: boolean;
            path: string;
        };
        [Key: string]: any;
    };
    plugins: object;
    registries: {
        search: string[];
    };
    store: object;
    version: object;
};

const COMPOSE_ENV_VARS = { PODMAN_COMPOSE_PROVIDER: "podman-compose", PODMAN_COMPOSE_WARNING_LOGS: "false" };

export class PodmanContainer extends ContainerManager {
    defaultCompose = structuredClone(PODMAN_DEFAULT_COMPOSE);
    composeFilePath = path.join(WINBOAT_DIR, "podman-compose.yml");
    executableAlias = "podman";

    constructor() {
        super();
    }

    writeCompose(compose: ComposeConfig): void {
        // These identities must never change when editing a profile's settings.
        compose.name = ACTIVE_INSTALLATION.projectName;
        compose.services.windows.container_name = ACTIVE_INSTALLATION.containerName;
        compose.services.windows.restart = "no";
        fs.mkdirSync(WINBOAT_DIR, { recursive: true, mode: 0o700 });
        const composeContent = YAML.stringify(compose, {
            nullStr: "",
            defaultStringType: "QUOTE_DOUBLE",
            defaultKeyType: "PLAIN",
        });
        fs.writeFileSync(this.composeFilePath, composeContent, { encoding: "utf-8", mode: 0o600 });

        containerLogger.info(`Wrote to compose file at: ${this.composeFilePath}`);
    }

    async compose(direction: ComposeDirection, extraArgs: ComposeArguments[] = []): Promise<void> {
        const args = ["compose", "-f", this.composeFilePath, direction, ...extraArgs];

        if (direction === "up") {
            // Run compose in detached mode if we are running compose up
            args.push("-d");
        }

        try {
            const run = () => execFileAsync(this.executableAlias, args, {
                env: concatEnv(process.env as { [key: string]: string }, COMPOSE_ENV_VARS),
            });
            const { stderr } = direction === "up" && !extraArgs.includes("--no-start")
                ? await withInstallationStart(ACTIVE_INSTALLATION.id, async () => {
                    const result = await run();
                    await refreshActiveInstallationPorts();
                    return result;
                }) : await run();
            if (stderr) {
                containerLogger.error(stderr);
            }
        } catch (e) {
            containerLogger.error(`Failed to run compose command '${stringifyExecFile(this.executableAlias, args)}'`);
            containerLogger.error(e);
            throw e;
        }
    }

    async container(action: ContainerAction): Promise<void> {
        const args = ["container", action, this.containerName];
        try {
            const run = () => execFileAsync(this.executableAlias, args);
            const { stdout } = ["start", "restart", "unpause"].includes(action)
                ? await withInstallationStart(ACTIVE_INSTALLATION.id, async () => {
                    const result = await run();
                    await refreshActiveInstallationPorts();
                    return result;
                }) : await run();
            containerLogger.info(`Container action '${action}' response: '${stdout}'`);
        } catch (e) {
            containerLogger.error(`Failed to run container action '${stringifyExecFile(this.executableAlias, args)}'`);
            containerLogger.error(e);
            throw e;
        }
    }

    async remove(): Promise<void> {
        const args = ["rm", this.containerName];

        try {
            await execFileAsync(this.executableAlias, args);
        } catch (e) {
            containerLogger.error(`Failed to remove container '${this.containerName}'`);
            containerLogger.error(e);
        }
    }

    async getStatus(): Promise<ContainerStatus> {
        const statusMap = {
            created: ContainerStatus.CREATED,
            restarting: ContainerStatus.UNKNOWN,
            initialized: ContainerStatus.UNKNOWN,
            removing: ContainerStatus.UNKNOWN,
            stopping: ContainerStatus.EXITED,
            stopped: ContainerStatus.EXITED,
            running: ContainerStatus.RUNNING,
            paused: ContainerStatus.PAUSED,
            exited: ContainerStatus.EXITED,
            dead: ContainerStatus.UNKNOWN,
        } as const;
        const args = ["inspect", "--format={{.State.Status}}", this.containerName];

        try {
            const { stdout } = await execFileAsync(this.executableAlias, args);
            const status = stdout.trim() as keyof typeof statusMap;
            return statusMap[status];
        } catch (e) {
            containerLogger.error(`Failed to get status of podman container ${e}'`);
            return ContainerStatus.UNKNOWN;
        }
    }

    async exists(): Promise<boolean> {
        const args = ["ps", "-a", "--filter", `name=${this.containerName}`, "--format", "{{.Names}}"];
        try {
            const { stdout: exists } = await execFileAsync(this.executableAlias, args);
            return exists.split(/\r?\n/).includes(this.containerName);
        } catch (e) {
            containerLogger.error(
                `Failed to get container status, is ${capitalizeFirstLetter(this.executableAlias)} installed?`,
            );
            containerLogger.error(e);
            return false;
        }
    }

    get containerName(): string {
        return ACTIVE_INSTALLATION.containerName;
    }

    static override async _getSpecs(): Promise<PodmanSpecs> {
        let specs: PodmanSpecs = {
            podmanInstalled: false,
            podmanComposeInstalled: false,
        };

        try {
            const { stdout: podmanOutput } = await execFileAsync("podman", ["--version"]);
            specs.podmanInstalled = !!podmanOutput;
        } catch (e) {
            containerLogger.error("Error checking podman version");
            containerLogger.error(e);
        }

        try {
            const { stdout: podmanComposeOutput } = await execFileAsync("podman", ["compose", "--version"], {
                env: concatEnv(process.env as { [key: string]: string }, COMPOSE_ENV_VARS),
            });
            specs.podmanComposeInstalled = !!podmanComposeOutput;
        } catch (e) {
            containerLogger.error("Error checking podman compose version");
            containerLogger.error(e);
        }

        return specs;
    }
}
