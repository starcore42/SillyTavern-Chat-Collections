import { identityKey, normalizeIdentity } from './model.js';
import { deleteCharacterChatByName, doNewChat } from '../../../../script.js';
import { deleteGroupChatByName } from '../../../group-chats.js';

function parseActivity(value) {
    const timestamp = typeof value === 'number' ? value : Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : 0;
}

export async function fetchInventory(context) {
    const response = await fetch('/api/chats/recent', {
        method: 'POST',
        headers: context.getRequestHeaders(),
        body: JSON.stringify({ max: Number.MAX_SAFE_INTEGER, metadata: false, pinned: [] }),
        cache: 'no-cache',
    });
    if (!response.ok) throw new Error(`Could not load the SillyTavern chat inventory (${response.status}).`);
    const data = await response.json();
    const characters = new Map((context.characters || []).map(character => [String(character.avatar), character]));
    const groups = new Map((context.groups || []).map(group => [String(group.id), group]));
    return (Array.isArray(data) ? data : []).flatMap(chat => {
        const type = chat.groupId || chat.group ? 'group' : 'solo';
        const ownerId = String(chat.groupId || chat.group || chat.pngFile || chat.avatar || '');
        if (!ownerId || !chat.file_name) return [];
        const owner = type === 'group' ? groups.get(ownerId) : characters.get(ownerId);
        if (!owner) return [];
        const identity = normalizeIdentity({ type, ownerId, fileName: chat.file_name });
        return [{
            identity,
            ownerName: String(owner.name || ownerId),
            fileName: identity.fileName,
            lastActivity: chat.last_mes || null,
            activityTimestamp: parseActivity(chat.last_mes),
            messageCount: Number(chat.chat_items || 0),
            preview: String(chat.mes || '').replace(/\s+/g, ' ').trim().slice(0, 500),
            fileSize: String(chat.file_size || ''),
            missing: false,
        }];
    });
}

export function currentChatIdentity(context) {
    const chatId = context.getCurrentChatId?.() || context.chatId;
    if (!chatId) return null;
    if (context.groupId) return normalizeIdentity({ type: 'group', ownerId: String(context.groupId), fileName: chatId });
    const character = context.characters?.[context.characterId];
    if (!character?.avatar) return null;
    return normalizeIdentity({ type: 'solo', ownerId: String(character.avatar), fileName: chatId });
}

export async function openInventoryChat(context, chat) {
    const fileId = chat.identity.fileName.replace(/\.jsonl$/i, '');
    if (chat.identity.type === 'group') {
        const group = context.groups.find(item => String(item.id) === chat.identity.ownerId);
        if (!group) throw new Error('The group for this chat no longer exists.');
        await context.openGroupChat(group.id, fileId);
    } else {
        const characterIndex = context.characters.findIndex(character => String(character.avatar) === chat.identity.ownerId);
        if (characterIndex < 0) throw new Error('The character for this chat no longer exists.');
        await context.selectCharacterById(characterIndex, { switchMenu: false });
        const freshContext = SillyTavern.getContext();
        if (freshContext.chatId !== fileId) await freshContext.openCharacterChat(fileId);
    }
    const activeIdentity = currentChatIdentity(SillyTavern.getContext());
    if (!activeIdentity || identityKey(activeIdentity) !== identityKey(chat.identity)) {
        throw new Error('SillyTavern did not activate the requested chat. It may have been renamed or removed.');
    }
}

export async function renameInventoryChat(context, chat, newName) {
    await openInventoryChat(context, chat);
    const oldName = chat.identity.fileName.replace(/\.jsonl$/i, '');
    await SillyTavern.getContext().renameChat(oldName, newName);
}

export async function deleteInventoryChat(context, chat) {
    const chatName = chat.identity.fileName.replace(/\.jsonl$/i, '');
    if (chat.identity.type === 'group') {
        const group = context.groups.find(item => String(item.id) === chat.identity.ownerId);
        if (!group) throw new Error('The group for this chat no longer exists.');
        await deleteGroupChatByName(group.id, chatName);
        return;
    }
    const characterIndex = context.characters.findIndex(character => String(character.avatar) === chat.identity.ownerId);
    if (characterIndex < 0) throw new Error('The character for this chat no longer exists.');
    await deleteCharacterChatByName(characterIndex, chatName);
}

export async function createInventoryChat(context, chat) {
    await openInventoryChat(context, chat);
    await doNewChat();
    const identity = currentChatIdentity(SillyTavern.getContext());
    if (!identity || identity.type !== chat.identity.type || identity.ownerId !== chat.identity.ownerId) {
        throw new Error('SillyTavern did not create a chat for the selected owner.');
    }
    return identity;
}

export async function createActiveInventoryChat() {
    await doNewChat();
    const identity = currentChatIdentity(SillyTavern.getContext());
    if (!identity) throw new Error('SillyTavern did not create a new chat.');
    return identity;
}
