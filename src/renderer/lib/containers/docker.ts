import { ComposeConfig } from "../../../types";
import { DOCKER_DEFAULT_COMPOSE } from "../../data/docker";
import { capitalizeFirstLetter } from "../../utils/capitalize";
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
import { execFileAsync, stringifyExecFile } from "../exec-helper";

const path: typeof import("node:path") = require("node:path");
const fs: typeof import("node:fs") = require("node:fs");

export type DockerSpecs = {
    dockerInstalled: boolean;
    dockerComposeInstalled: boolean;
    dockerIsRunning: boolean;
    dockerIsInUserGroups: boolean;
};

export class DockerContainer extends ContainerManager {
    defaultCompose = structuredClone(DOCKER_DEFAULT_COMPOSE);
    composeFilePath = path.join(WINBOAT_DIR, "docker-compose.yml");
    executableAlias = "docker";

    constructor() {
        super();
    }

    writeCompose(compose: ComposeConfig): void {
        // These identities must never change when editing a profile's settings.
        compose.name = ACTIVE_INSTALLATION.projectName;
        compose.services.windows.container_name = ACTIVE_INSTALLATION.containerName;
        compose.services.windows.restart = "no";
        fs.mkdirSync(WINBOAT_DIR, { recursive: true, mode: 0o700 });
        const composeContent = YAML.stringify(compose, { nullStr: "" });
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
            const run = () => execFileAsync(this.executableAlias, args);
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
            removing: ContainerStatus.UNKNOWN,
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
            containerLogger.error(`Failed to get status of docker container ${e}'`);
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

    static override async _getSpecs(): Promise<DockerSpecs> {
        let specs: DockerSpecs = {
            dockerInstalled: false,
            dockerComposeInstalled: false,
            dockerIsRunning: false,
            dockerIsInUserGroups: false,
        };

        try {
            const { stdout: dockerOutput } = await execFileAsync("docker", ["--version"]);
            specs.dockerInstalled = !!dockerOutput;
        } catch (e) {
            console.error("Error checking for Docker installation:", e);
        }

        // Docker Compose plugin check with version validation
        try {
            const { stdout: dockerComposeOutput } = await execFileAsync("docker", ["compose", "version"]);
            if (dockerComposeOutput) {
                // Example output: "Docker Compose version v2.35.1"
                // Example output 2: "Docker Compose version 2.36.2"
                const versionMatch = /(\d+\.\d+\.\d+)/.exec(dockerComposeOutput);
                if (versionMatch) {
                    const majorVersion = Number.parseInt(versionMatch[1].split(".")[0], 10);
                    specs.dockerComposeInstalled = majorVersion >= 2;
                } else {
                    specs.dockerComposeInstalled = false; // No valid version found
                }
            } else {
                specs.dockerComposeInstalled = false; // No output, plugin not installed
            }
        } catch (e) {
            console.error("Error checking Docker Compose version:", e);
        }

        // Docker is running check
        try {
            const { stdout: dockerOutput } = await execFileAsync("docker", ["ps"]);
            specs.dockerIsRunning = !!dockerOutput;
        } catch (e) {
            console.error("Error checking if Docker is running:", e);
        }

        // Docker user group check
        try {
            const { stdout: userGroups } = await execFileAsync("id", ["-Gn"]);
            specs.dockerIsInUserGroups = userGroups.split(/\s+/).includes("docker");
        } catch (e) {
            console.error("Error checking user groups for docker:", e);
        }

        return specs;
    }
}
