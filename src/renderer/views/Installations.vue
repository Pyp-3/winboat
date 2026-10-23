<template>
    <section class="space-y-6 pb-8" aria-labelledby="installations-title">
        <div class="flex items-start justify-between gap-6">
            <div>
                <h2 id="installations-title" class="text-2xl font-semibold my-0">Your Windows installations</h2>
                <p class="text-neutral-400 mt-2 max-w-2xl">
                    Keep separate Windows environments for work, testing, or different versions.
                    Run one installation at a time and switch after shutting it down.
                </p>
            </div>
            <button class="primary-button shrink-0" @click="showCreateDialog" :disabled="busy">
                <Icon icon="fluent:add-24-filled" class="size-5" />
                Add Windows
            </button>
        </div>

        <p v-if="error" role="alert" class="rounded-xl border border-red-400/30 bg-red-500/10 p-4 text-red-200">
            {{ error }}
        </p>
        <div v-if="activeIsRunning" class="flex items-center gap-3 rounded-xl bg-amber-400/10 p-4 text-amber-100">
            <Icon icon="fluent:info-24-regular" class="size-6 shrink-0" />
            <p class="my-0">
                {{ active.name }} is {{ statuses[active.id] }}. Shut down Windows from
                <RouterLink to="/home" class="underline">Home</RouterLink> before switching installations.
            </p>
        </div>

        <div class="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <article
                v-for="installation in installations"
                :key="installation.id"
                class="installation-card rounded-2xl border p-6 bg-neutral-800/40"
                :class="installation.id === active.id ? 'border-violet-400/60' : 'border-neutral-700/60'"
            >
                <div class="flex items-start justify-between gap-4">
                    <div class="flex gap-3 items-center min-w-0">
                        <div class="rounded-xl bg-violet-400/10 p-3 text-violet-300">
                            <Icon icon="mage:microsoft-windows" class="size-7" />
                        </div>
                        <div class="min-w-0">
                            <h3 class="text-lg font-semibold my-0 break-words">{{ installation.name }}</h3>
                            <span class="text-sm text-neutral-400">{{ installation.runtime }}</span>
                        </div>
                    </div>
                    <span v-if="installation.id === active.id" class="rounded-full px-3 py-1 text-xs bg-violet-400/15 text-violet-200">
                        Selected
                    </span>
                </div>

                <div class="flex items-center gap-2 mt-5 text-sm">
                    <span class="size-2 rounded-full" :class="statusColor(statuses[installation.id])"></span>
                    <span>{{ statusLabel(installation) }}</span>
                </div>
                <dl class="mt-4 mb-6 text-sm space-y-3">
                    <div>
                        <dt class="text-neutral-500">Windows storage</dt>
                        <dd class="ml-0 mt-1 text-neutral-300 break-all font-mono text-xs">{{ installation.storagePath }}</dd>
                    </div>
                    <div>
                        <dt class="text-neutral-500">Settings and logs</dt>
                        <dd class="ml-0 mt-1 text-neutral-300 break-all font-mono text-xs">{{ installation.directory }}</dd>
                    </div>
                </dl>
                <div class="flex items-center gap-3">
                    <button class="primary-button" :disabled="busy" @click="openInstallation(installation)">
                        <Icon :icon="hasConfiguration(installation) ? 'fluent:open-24-regular' : 'fluent:settings-24-regular'" class="size-4" />
                        {{ hasPendingInstallation(installation.directory) ? 'Resume setup' : hasConfiguration(installation) ? 'Open installation' : 'Set up Windows' }}
                    </button>
                    <button class="secondary-button" :disabled="busy" @click="showRenameDialog(installation)">Rename</button>
                </div>
            </article>
        </div>

        <p class="text-sm text-neutral-500">
            Each installation has its own disk, settings, and container. Adding one reserves a folder;
            Windows is downloaded only when you start its setup.
        </p>

        <dialog ref="nameDialog" class="installation-dialog" @close="editingId = null" @keydown.esc.prevent.stop="closeNameDialog">
            <form @submit.prevent="saveName" class="space-y-5">
                <div>
                    <h2 class="my-0 text-xl font-semibold">{{ editingId ? 'Rename installation' : 'Add a Windows installation' }}</h2>
                    <p class="text-neutral-400 text-sm mt-2 mb-0">
                        {{ editingId ? 'Choose a name you can easily recognize.' : 'Give this environment a name. You can choose its Windows version and resources during setup.' }}
                    </p>
                </div>
                <div>
                    <label for="installation-name" class="block text-sm mb-2">Installation name</label>
                    <input
                        id="installation-name"
                        ref="nameInput"
                        v-model="name"
                        type="text"
                        maxlength="80"
                        required
                        autocomplete="off"
                        placeholder="For example, Windows 11 · Work"
                        class="w-full rounded-lg border border-neutral-600 bg-neutral-900 px-3 py-2 text-white focus:border-violet-400 focus:outline-none"
                    />
                </div>
                <p v-if="dialogError" class="text-red-300 text-sm" role="alert">{{ dialogError }}</p>
                <div class="flex justify-end gap-3">
                    <button type="button" class="secondary-button" :disabled="busy" @click="nameDialog?.close()">Cancel</button>
                    <button type="submit" class="primary-button" :disabled="busy || !name.trim()">
                        {{ editingId ? 'Save name' : 'Create and set up' }}
                    </button>
                </div>
            </form>
        </dialog>
    </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, useTemplateRef } from "vue";
import { RouterLink, useRouter } from "vue-router";
import { Icon } from "@iconify/vue";
import { openInstallationWindow } from "../utils/installationNavigation";
import { hasPendingInstallation } from "../lib/install";
import {
    createInstallation,
    getActiveInstallation,
    getInstallations,
    getInstallationStatus,
    renameInstallation,
    selectInstallation,
    type Installation,
} from "../lib/installations";

const fs: typeof import("node:fs") = require("node:fs");
const path: typeof import("node:path") = require("node:path");
const router = useRouter();
const installations = ref(getInstallations());
const active = ref(getActiveInstallation());
const statuses = ref<Record<string, string>>({});
const busy = ref(false);
let openingWindow = false;
const error = ref("");
const dialogError = ref("");
const name = ref("");
const editingId = ref<string | null>(null);
const nameDialog = useTemplateRef("nameDialog");
const nameInput = useTemplateRef("nameInput");
let refreshInterval: ReturnType<typeof setInterval> | undefined;
let refreshing = false;
let disposed = false;

const activeIsRunning = computed(() => ["running", "paused", "restarting"].includes(statuses.value[active.value.id]));

function hasConfiguration(installation: Installation) {
    return fs.existsSync(path.join(installation.directory, "winboat.config.json")) &&
        fs.existsSync(path.join(installation.directory, installation.runtime === "Podman" ? "podman-compose.yml" : "docker-compose.yml"));
}

function statusLabel(installation: Installation) {
    const status = statuses.value[installation.id];
    if (!status) return "Checking status…";
    if (status === "missing") return hasPendingInstallation(installation.directory) ? "Setup incomplete" : hasConfiguration(installation) ? "Container not created" : "Ready for setup";
    if (status === "unknown") return "Status unavailable";
    if (status === "exited") return "Stopped";
    return status.charAt(0).toUpperCase() + status.slice(1);
}

function statusColor(status?: string) {
    if (status === "running") return "bg-green-400";
    if (["paused", "restarting", "unknown"].includes(status || "")) return "bg-amber-400";
    return "bg-neutral-500";
}

async function refreshStatuses() {
    if (refreshing) return;
    refreshing = true;
    try {
        const results = await Promise.all(installations.value.map(async installation => [
            installation.id,
            await getInstallationStatus(installation.id).catch(() => "unknown"),
        ]));
        if (!disposed) statuses.value = Object.fromEntries(results);
    } finally {
        refreshing = false;
    }
}

function refreshInstallations() {
    installations.value = getInstallations();
    active.value = getActiveInstallation();
    window.dispatchEvent(new Event("winboat:installations-changed"));
    void refreshStatuses();
}

async function showCreateDialog() {
    editingId.value = null;
    name.value = "";
    dialogError.value = "";
    nameDialog.value?.showModal();
    await nextTick();
    nameInput.value?.focus();
}

function closeNameDialog() {
    if (!busy.value) nameDialog.value?.close();
}

async function showRenameDialog(installation: Installation) {
    editingId.value = installation.id;
    name.value = installation.name;
    dialogError.value = "";
    nameDialog.value?.showModal();
    await nextTick();
    nameInput.value?.select();
}

async function saveName() {
    if (busy.value || !name.value.trim()) return;
    busy.value = true;
    dialogError.value = "";
    try {
        if (editingId.value) {
            renameInstallation(editingId.value, name.value.trim());
            refreshInstallations();
            nameDialog.value?.close();
        } else {
            const installation = createInstallation(name.value.trim());
            refreshInstallations();
            nameDialog.value?.close();
            // Keep the created draft available if another VM prevents activation.
            await activateInstallation(installation);
        }
    } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        if (nameDialog.value?.open) dialogError.value = message;
        else error.value = message;
    } finally {
        if (!openingWindow) busy.value = false;
    }
}

async function activateInstallation(installation: Installation) {
    const destination = hasConfiguration(installation) && !hasPendingInstallation(installation.directory) ? "/home" : "/setup";
    if (installation.id === active.value.id && !hasConfiguration(installation)) {
        await router.push(destination);
        return;
    }
    if (installation.id !== active.value.id) await selectInstallation(installation.id);
    openingWindow = true;
    openInstallationWindow(destination);
}

async function openInstallation(installation: Installation) {
    if (busy.value) return;
    busy.value = true;
    error.value = "";
    try {
        await activateInstallation(installation);
    } catch (cause) {
        error.value = cause instanceof Error ? cause.message : String(cause);
    } finally {
        if (!openingWindow) busy.value = false;
    }
}

onMounted(() => {
    void refreshStatuses();
    refreshInterval = setInterval(refreshStatuses, 5000);
});

onUnmounted(() => {
    disposed = true;
    if (refreshInterval) clearInterval(refreshInterval);
});
</script>

<style scoped>
.primary-button,
.secondary-button {
    @apply inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed;
}
.primary-button { @apply bg-violet-500 text-white hover:bg-violet-400; }
.secondary-button { @apply border border-neutral-600 text-neutral-200 hover:bg-neutral-700; }
.installation-dialog { @apply w-[480px] max-w-[90vw] rounded-2xl bg-neutral-800 border border-neutral-600 p-6 text-white; }
</style>
