export const SCHEMA_VERSION = 2;
export const SPECIAL_VIEWS = Object.freeze({
    ALL: 'all',
    UNFILED: 'unfiled',
    RECENT: 'recent',
    MISSING: 'missing',
    ARCHIVED: 'archived',
});

const VALID_CHAT_TYPES = new Set(['solo', 'group']);
const VALID_SCOPES = new Set(['global', 'character']);

function nowIso(now = Date.now()) {
    return new Date(now).toISOString();
}

function clone(value) {
    return structuredClone(value);
}

export function newId(prefix = 'cc') {
    const value = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    return `${prefix}-${value}`;
}

export function normalizeFileName(fileName) {
    const value = String(fileName || '').trim();
    if (!value) throw new Error('A chat filename is required.');
    return value.toLowerCase().endsWith('.jsonl') ? value : `${value}.jsonl`;
}

export function normalizeIdentity(identity) {
    const type = String(identity?.type || '');
    const ownerId = String(identity?.ownerId ?? '').trim();
    if (!VALID_CHAT_TYPES.has(type)) throw new Error(`Unsupported chat type: ${type || '(empty)'}`);
    if (!ownerId) throw new Error('A character avatar ID or group ID is required.');
    return { type, ownerId, fileName: normalizeFileName(identity?.fileName) };
}

export function identityKey(identity) {
    const value = normalizeIdentity(identity);
    return JSON.stringify([value.type, value.ownerId, value.fileName]);
}

export function createEmptyIndex(now = Date.now()) {
    return {
        schemaVersion: SCHEMA_VERSION,
        revision: 0,
        updatedAt: nowIso(now),
        folders: [],
        assignments: [],
        catalog: [],
        reconciliation: [],
        preferences: { sort: 'activity-desc' },
    };
}

function normalizeFolder(folder, position, now) {
    const scopeKind = VALID_SCOPES.has(folder?.scope?.kind) ? folder.scope.kind : 'global';
    const ownerId = scopeKind === 'character' ? String(folder?.scope?.ownerId || '') : null;
    if (scopeKind === 'character' && !ownerId) throw new Error(`Folder "${folder?.name || position}" has no character scope ID.`);
    return {
        id: String(folder?.id || newId('folder')),
        name: String(folder?.name || 'Untitled collection').trim() || 'Untitled collection',
        parentId: folder?.parentId ? String(folder.parentId) : null,
        order: Number.isFinite(Number(folder?.order)) ? Number(folder.order) : position,
        scope: { kind: scopeKind, ownerId },
        createdAt: folder?.createdAt || now,
        updatedAt: folder?.updatedAt || now,
    };
}

function duplicateRecord(identity, details, now) {
    return {
        id: newId('reconcile'),
        identity: normalizeIdentity(identity),
        status: 'duplicate-identity',
        detectedAt: now,
        updatedAt: now,
        resolvedAt: null,
        replacementIdentity: null,
        details,
    };
}

function normalizeRecordList(records, kind, reconciliation, now) {
    const result = [];
    const seen = new Map();
    for (const raw of Array.isArray(records) ? records : []) {
        try {
            const identity = normalizeIdentity(raw.identity || raw);
            const key = identityKey(identity);
            if (seen.has(key)) {
                reconciliation.push(duplicateRecord(identity, `${kind} contains multiple records for one composite identity; the first record was preserved.`, now));
                continue;
            }
            const record = kind === 'assignment'
                ? {
                    identity,
                    folderId: raw.folderId ? String(raw.folderId) : null,
                    archived: Boolean(raw.archived),
                    createdAt: raw.createdAt || now,
                    updatedAt: raw.updatedAt || now,
                    lastKnown: raw.lastKnown && typeof raw.lastKnown === 'object' ? clone(raw.lastKnown) : {},
                }
                : {
                    identity,
                    firstSeenAt: raw.firstSeenAt || now,
                    lastSeenAt: raw.lastSeenAt || now,
                    lastKnown: raw.lastKnown && typeof raw.lastKnown === 'object' ? clone(raw.lastKnown) : {},
                };
            seen.set(key, record);
            result.push(record);
        } catch (error) {
            reconciliation.push({
                id: newId('reconcile'),
                identity: null,
                status: 'invalid-record',
                detectedAt: now,
                updatedAt: now,
                resolvedAt: null,
                replacementIdentity: null,
                details: `${kind}: ${error.message}`,
            });
        }
    }
    return result;
}

function legacyAssignments(raw) {
    if (Array.isArray(raw)) return raw;
    if (!raw || typeof raw !== 'object') return [];
    return Object.entries(raw).map(([key, value]) => {
        let identity = value?.identity;
        if (!identity) {
            try {
                const [type, ownerId, fileName] = JSON.parse(key);
                identity = { type, ownerId, fileName };
            } catch {
                identity = null;
            }
        }
        return { ...value, identity };
    });
}

export function migrateIndex(raw, nowValue = Date.now()) {
    const now = nowIso(nowValue);
    if (!raw || typeof raw !== 'object') return { index: createEmptyIndex(nowValue), changed: true, warnings: [] };
    const sourceVersion = Number(raw.schemaVersion || 0);
    if (sourceVersion > SCHEMA_VERSION) throw new Error(`This index uses schema ${sourceVersion}, newer than supported schema ${SCHEMA_VERSION}.`);

    const reconciliation = Array.isArray(raw.reconciliation) ? clone(raw.reconciliation) : [];
    const folderSource = Array.isArray(raw.folders) ? raw.folders : (Array.isArray(raw.collections) ? raw.collections : []);
    const folders = folderSource.map((folder, position) => normalizeFolder(folder, position, now));
    const folderIds = new Set(folders.map(folder => folder.id));
    const foldersById = new Map(folders.map(folder => [folder.id, folder]));
    for (const folder of folders) {
        if (folder.parentId && !folderIds.has(folder.parentId)) folder.parentId = null;
        if (folder.parentId === folder.id) folder.parentId = null;
        const visited = new Set([folder.id]);
        let ancestor = folder.parentId ? foldersById.get(folder.parentId) : null;
        while (ancestor) {
            if (visited.has(ancestor.id)) {
                folder.parentId = null;
                break;
            }
            visited.add(ancestor.id);
            ancestor = ancestor.parentId ? foldersById.get(ancestor.parentId) : null;
        }
    }

    const assignments = normalizeRecordList(legacyAssignments(raw.assignments), 'assignment', reconciliation, now);
    for (const assignment of assignments) {
        if (assignment.folderId && !folderIds.has(assignment.folderId)) {
            reconciliation.push(duplicateRecord(assignment.identity, `Assignment referenced missing folder ${assignment.folderId}; it was moved to Unfiled.`, now));
            assignment.folderId = null;
        }
    }
    const catalog = normalizeRecordList(raw.catalog, 'catalog', reconciliation, now);

    const index = {
        schemaVersion: SCHEMA_VERSION,
        revision: Number.isFinite(Number(raw.revision)) ? Number(raw.revision) : 0,
        updatedAt: raw.updatedAt || now,
        folders,
        assignments,
        catalog,
        reconciliation,
        preferences: { sort: raw.preferences?.sort || 'activity-desc' },
    };
    const changed = sourceVersion !== SCHEMA_VERSION || JSON.stringify(index) !== JSON.stringify(raw);
    return { index, changed, warnings: reconciliation.filter(item => item.status === 'duplicate-identity') };
}

export function touch(index, now = Date.now()) {
    index.revision = Number(index.revision || 0) + 1;
    index.updatedAt = nowIso(now);
    return index;
}

export function getAssignment(index, identity) {
    const key = identityKey(identity);
    return index.assignments.find(item => identityKey(item.identity) === key) || null;
}

export function assignChat(index, chat, folderId, now = Date.now()) {
    const identity = normalizeIdentity(chat.identity || chat);
    const folder = folderId ? index.folders.find(item => item.id === folderId) : null;
    if (folderId && !folder) throw new Error('That collection no longer exists.');
    if (folder?.scope?.kind === 'character' && (identity.type !== 'solo' || identity.ownerId !== folder.scope.ownerId)) {
        throw new Error('This collection is limited to another character.');
    }
    let assignment = getAssignment(index, identity);
    const timestamp = nowIso(now);
    if (!assignment) {
        assignment = { identity, folderId: folderId || null, archived: false, createdAt: timestamp, updatedAt: timestamp, lastKnown: clone(chat.lastKnown || {}) };
        index.assignments.push(assignment);
    } else {
        assignment.folderId = folderId || null;
        assignment.updatedAt = timestamp;
        assignment.lastKnown = { ...assignment.lastKnown, ...(chat.lastKnown || {}) };
    }
    return touch(index, now);
}

export function setArchived(index, chat, archived, now = Date.now()) {
    assignChat(index, chat, getAssignment(index, chat.identity || chat)?.folderId || null, now);
    const assignment = getAssignment(index, chat.identity || chat);
    assignment.archived = Boolean(archived);
    assignment.updatedAt = nowIso(now);
    return touch(index, now);
}

export function addFolder(index, { name, parentId = null, scope = { kind: 'global', ownerId: null } }, now = Date.now()) {
    const timestamp = nowIso(now);
    if (parentId && !index.folders.some(item => item.id === parentId)) throw new Error('Parent collection not found.');
    const siblings = index.folders.filter(item => item.parentId === parentId);
    const folder = normalizeFolder({ id: newId('folder'), name, parentId, order: siblings.length, scope, createdAt: timestamp, updatedAt: timestamp }, siblings.length, timestamp);
    index.folders.push(folder);
    touch(index, now);
    return folder;
}

export function renameFolder(index, folderId, name, now = Date.now()) {
    const folder = index.folders.find(item => item.id === folderId);
    if (!folder) throw new Error('Collection not found.');
    folder.name = String(name || '').trim() || folder.name;
    folder.updatedAt = nowIso(now);
    return touch(index, now);
}

export function deleteFolder(index, folderId, now = Date.now()) {
    const folder = index.folders.find(item => item.id === folderId);
    if (!folder) return index;
    for (const child of index.folders.filter(item => item.parentId === folderId)) child.parentId = folder.parentId;
    for (const assignment of index.assignments.filter(item => item.folderId === folderId)) assignment.folderId = null;
    index.folders = index.folders.filter(item => item.id !== folderId);
    return touch(index, now);
}

function descendantIds(index, folderId) {
    const result = new Set([folderId]);
    let changed = true;
    while (changed) {
        changed = false;
        for (const folder of index.folders) {
            if (folder.parentId && result.has(folder.parentId) && !result.has(folder.id)) {
                result.add(folder.id);
                changed = true;
            }
        }
    }
    return result;
}

export function moveFolder(index, folderId, parentId, order = null, now = Date.now()) {
    const folder = index.folders.find(item => item.id === folderId);
    if (!folder) throw new Error('Collection not found.');
    if (parentId && !index.folders.some(item => item.id === parentId)) throw new Error('Parent collection not found.');
    if (parentId && descendantIds(index, folderId).has(parentId)) throw new Error('A collection cannot be moved inside itself.');
    folder.parentId = parentId || null;
    const siblings = index.folders.filter(item => item.parentId === folder.parentId && item.id !== folder.id).sort((a, b) => a.order - b.order);
    const target = order == null ? siblings.length : Math.max(0, Math.min(Number(order), siblings.length));
    siblings.splice(target, 0, folder);
    siblings.forEach((item, position) => { item.order = position; });
    folder.updatedAt = nowIso(now);
    return touch(index, now);
}

function upsertReconciliation(index, identity, status, details, now, extra = {}) {
    const key = identity ? identityKey(identity) : null;
    let record = index.reconciliation.find(item => !item.resolvedAt && item.status === status && (item.identity ? identityKey(item.identity) : null) === key);
    if (!record) {
        record = { id: newId('reconcile'), identity: identity ? normalizeIdentity(identity) : null, status, detectedAt: now, updatedAt: now, resolvedAt: null, replacementIdentity: null, details };
        index.reconciliation.push(record);
    } else {
        record.updatedAt = now;
        record.details = details || record.details;
    }
    Object.assign(record, extra);
    return record;
}

function snapshot(chat) {
    return {
        ownerName: String(chat.ownerName || ''),
        lastActivity: chat.lastActivity || null,
        messageCount: Number(chat.messageCount || 0),
        preview: String(chat.preview || '').slice(0, 500),
    };
}

export function reconcileIndex(index, inventory, nowValue = Date.now()) {
    const now = nowIso(nowValue);
    const current = new Map();
    for (const chat of inventory) {
        const identity = normalizeIdentity(chat.identity || chat);
        const key = identityKey(identity);
        if (current.has(key)) {
            upsertReconciliation(index, identity, 'duplicate-identity', 'The live chat inventory returned this composite identity more than once.', now);
            continue;
        }
        current.set(key, { ...chat, identity });
    }

    const catalogMap = new Map(index.catalog.map(item => [identityKey(item.identity), item]));
    for (const [key, chat] of current) {
        let entry = catalogMap.get(key);
        if (!entry) {
            entry = { identity: chat.identity, firstSeenAt: now, lastSeenAt: now, lastKnown: snapshot(chat) };
            index.catalog.push(entry);
            catalogMap.set(key, entry);
        } else {
            entry.lastSeenAt = now;
            entry.lastKnown = snapshot(chat);
        }
        const assignment = getAssignment(index, chat.identity);
        if (assignment) assignment.lastKnown = snapshot(chat);
        for (const record of index.reconciliation.filter(item => !item.resolvedAt && item.identity && identityKey(item.identity) === key && ['missing', 'deleted', 'owner-deleted'].includes(item.status))) {
            record.resolvedAt = now;
            record.updatedAt = now;
        }
    }

    for (const entry of index.catalog) {
        const key = identityKey(entry.identity);
        if (!current.has(key)) upsertReconciliation(index, entry.identity, 'missing', 'This previously seen chat is not present in SillyTavern’s current inventory.', now);
    }
    return touch(index, nowValue);
}

export function renameIdentity(index, oldIdentity, newIdentity, nowValue = Date.now()) {
    const now = nowIso(nowValue);
    const oldKey = identityKey(oldIdentity);
    const newValue = normalizeIdentity(newIdentity);
    const newKey = identityKey(newValue);
    const collision = index.assignments.some(item => identityKey(item.identity) === newKey) || index.catalog.some(item => identityKey(item.identity) === newKey);
    if (oldKey !== newKey && collision) {
        upsertReconciliation(index, oldIdentity, 'duplicate-identity', 'Rename target already has organization data; neither assignment was overwritten.', now, { replacementIdentity: newValue });
        return touch(index, nowValue);
    }
    for (const list of [index.assignments, index.catalog]) {
        for (const item of list.filter(value => identityKey(value.identity) === oldKey)) item.identity = newValue;
    }
    upsertReconciliation(index, oldIdentity, 'renamed', 'Chat identity was updated after SillyTavern renamed the chat.', now, { replacementIdentity: newValue, resolvedAt: now });
    return touch(index, nowValue);
}

export function renameCharacterOwner(index, oldOwnerId, newOwnerId, nowValue = Date.now()) {
    const affected = [...index.catalog, ...index.assignments].filter(item => item.identity.type === 'solo' && item.identity.ownerId === oldOwnerId).map(item => item.identity);
    const unique = new Map(affected.map(identity => [identityKey(identity), identity]));
    for (const identity of unique.values()) renameIdentity(index, identity, { ...identity, ownerId: newOwnerId }, nowValue);
    for (const folder of index.folders) {
        if (folder.scope.kind === 'character' && folder.scope.ownerId === oldOwnerId) folder.scope.ownerId = newOwnerId;
    }
    return touch(index, nowValue);
}

export function markOwnerDeleted(index, type, ownerId, nowValue = Date.now()) {
    const now = nowIso(nowValue);
    for (const entry of index.catalog.filter(item => item.identity.type === type && item.identity.ownerId === String(ownerId))) {
        upsertReconciliation(index, entry.identity, 'owner-deleted', `${type === 'solo' ? 'Character' : 'Group'} is no longer present. Chat files were not touched.`, now);
    }
    return touch(index, nowValue);
}

export function markChatDeleted(index, identity, nowValue = Date.now()) {
    const now = nowIso(nowValue);
    upsertReconciliation(index, identity, 'deleted', 'SillyTavern reported that this chat was deleted through its native workflow.', now);
    return touch(index, nowValue);
}

export function getMissingChats(index, inventory) {
    const live = new Set(inventory.map(chat => identityKey(chat.identity || chat)));
    return index.catalog.filter(item => !live.has(identityKey(item.identity))).map(item => ({
        identity: item.identity,
        ...item.lastKnown,
        missing: true,
    }));
}

export function folderAndDescendants(index, folderId) {
    return descendantIds(index, folderId);
}
