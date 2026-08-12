import { createActiveInventoryChat, createInventoryChat, currentChatIdentity, deleteInventoryChat, fetchInventory, openInventoryChat, renameInventoryChat } from './inventory.js';
import {
    identityKey,
    markChatDeleted,
    markOwnerDeleted,
    normalizeFileName,
    reconcileIndex,
    renameCharacterOwner,
    renameIdentity,
} from './model.js';
import { CollectionStorage } from './storage.js';
import { ChatCollectionsUI } from './ui.js';

const EXTENSION_NAME = 'Chat Collections';
let index;
let inventory = [];
let storage;
let ui;
let refreshQueue = Promise.resolve();
let refreshTimer = null;

function context() {
    return SillyTavern.getContext();
}

function reportError(error) {
    console.error(`[${EXTENSION_NAME}]`, error);
    globalThis.toastr?.error?.(error.message || String(error), EXTENSION_NAME);
}

async function persist(value = index) {
    index = value;
    await storage.save(index);
    ui?.setData(index, inventory);
}

async function refreshInventory({ save = true } = {}) {
    refreshQueue = refreshQueue.catch(() => undefined).then(async () => {
        const nextInventory = await fetchInventory(context());
        inventory = nextInventory;
        reconcileIndex(index, inventory);

        const liveCharacters = new Set((context().characters || []).map(character => String(character.avatar)));
        const liveGroups = new Set((context().groups || []).map(group => String(group.id)));
        const missingCharacterOwners = new Set(index.catalog.filter(item => item.identity.type === 'solo' && !liveCharacters.has(item.identity.ownerId)).map(item => item.identity.ownerId));
        const missingGroupOwners = new Set(index.catalog.filter(item => item.identity.type === 'group' && !liveGroups.has(item.identity.ownerId)).map(item => item.identity.ownerId));
        for (const ownerId of missingCharacterOwners) markOwnerDeleted(index, 'solo', ownerId);
        for (const ownerId of missingGroupOwners) markOwnerDeleted(index, 'group', ownerId);

        if (save) await storage.save(index);
        ui?.setData(index, inventory);
        return inventory;
    });
    return refreshQueue;
}

function scheduleRefresh(delay = 350) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => refreshInventory().catch(reportError), delay);
}

function findDeletedIdentity(type, fileName) {
    const normalized = normalizeFileName(fileName);
    const live = new Set(inventory.map(chat => identityKey(chat.identity)));
    const candidates = index.catalog
        .map(item => item.identity)
        .filter(identity => identity.type === type && identity.fileName === normalized && !live.has(identityKey(identity)));
    if (candidates.length === 1) return candidates[0];
    const current = currentChatIdentity(context());
    return candidates.find(identity => current && identity.ownerId === current.ownerId) || null;
}

async function handleDeleted(type, fileName) {
    await refreshInventory({ save: false });
    const identity = findDeletedIdentity(type, fileName);
    if (identity) markChatDeleted(index, identity);
    await persist(index);
}

function bindEvents() {
    const { eventSource, eventTypes } = context();
    eventSource.on(eventTypes.CHAT_RENAMED, async data => {
        try {
            const type = data?.groupId ? 'group' : 'solo';
            const ownerId = String(data?.groupId || data?.avatarId || '');
            if (!ownerId || !data?.oldFileName || !data?.newFileName) return scheduleRefresh();
            renameIdentity(
                index,
                { type, ownerId, fileName: data.oldFileName },
                { type, ownerId, fileName: data.newFileName },
            );
            await persist(index);
            scheduleRefresh();
        } catch (error) {
            reportError(error);
        }
    });
    eventSource.on(eventTypes.CHARACTER_RENAMED, async (oldAvatar, newAvatar) => {
        try {
            renameCharacterOwner(index, String(oldAvatar), String(newAvatar));
            await persist(index);
            scheduleRefresh();
        } catch (error) {
            reportError(error);
        }
    });
    eventSource.on(eventTypes.CHARACTER_DELETED, async data => {
        try {
            const avatar = data?.character?.avatar;
            if (avatar) markOwnerDeleted(index, 'solo', String(avatar));
            await persist(index);
            scheduleRefresh();
        } catch (error) {
            reportError(error);
        }
    });
    eventSource.on(eventTypes.CHAT_DELETED, fileName => handleDeleted('solo', fileName).catch(reportError));
    eventSource.on(eventTypes.GROUP_CHAT_DELETED, fileName => handleDeleted('group', fileName).catch(reportError));
    for (const eventName of [eventTypes.CHAT_CREATED, eventTypes.GROUP_CHAT_CREATED, eventTypes.CHAT_CHANGED, eventTypes.CHAT_LOADED, eventTypes.GROUP_UPDATED]) {
        if (eventName) eventSource.on(eventName, () => scheduleRefresh());
    }
}

async function init() {
    try {
        const ctx = context();
        storage = new CollectionStorage(() => context().getRequestHeaders());
        const loaded = await storage.load();
        index = loaded.index;
        if (loaded.migrated) {
            globalThis.toastr?.info?.(`Organisation index migrated. Backup: ${loaded.backup}`, EXTENSION_NAME);
        }
        if (loaded.warnings.length) {
            globalThis.toastr?.warning?.(`${loaded.warnings.length} duplicate identities need reconciliation.`, EXTENSION_NAME);
        }
        ui = new ChatCollectionsUI({
            getContext: context,
            persist,
            refresh: () => refreshInventory(),
            openChat: chat => openInventoryChat(context(), chat),
            renameChat: (chat, newName) => renameInventoryChat(context(), chat, newName),
            deleteChat: chat => deleteInventoryChat(context(), chat),
            createChat: chat => createInventoryChat(context(), chat),
            createActiveChat: () => createActiveInventoryChat(),
            currentIdentity: () => currentChatIdentity(context()),
            importIndex: async imported => {
                const result = await storage.replaceWithImport(index, imported);
                index = result.index;
                await refreshInventory();
                return { ...result, index };
            },
        });
        const mounted = ui.mount();
        if (!mounted) ctx.eventSource.once(ctx.eventTypes.APP_READY, () => ui.mount());
        bindEvents();
        await refreshInventory();
        console.info(`[${EXTENSION_NAME}] Ready with ${inventory.length} chats.`);
    } catch (error) {
        reportError(error);
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
    init();
}
