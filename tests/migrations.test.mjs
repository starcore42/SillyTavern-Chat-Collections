import test from 'node:test';
import assert from 'node:assert/strict';

import {
    SCHEMA_VERSION,
    addFolder,
    assignChat,
    createEmptyIndex,
    deleteFolder,
    getAssignment,
    getMissingChats,
    identityKey,
    migrateIndex,
    reconcileIndex,
    renameCharacterOwner,
    renameIdentity,
} from '../model.js';

const NOW = Date.parse('2026-08-11T00:00:00.000Z');
const SOLO = { type: 'solo', ownerId: 'Writer.png', fileName: 'Draft One.jsonl' };

test('fresh schema migrates idempotently', () => {
    const original = createEmptyIndex(NOW);
    const first = migrateIndex(original, NOW);
    const second = migrateIndex(first.index, NOW);
    assert.equal(first.index.schemaVersion, SCHEMA_VERSION);
    assert.equal(first.changed, false);
    assert.equal(second.changed, false);
    assert.deepEqual(second.index, first.index);
});

test('legacy collections and object assignments migrate to arrays', () => {
    const key = JSON.stringify(['solo', 'Writer.png', 'Draft One.jsonl']);
    const legacy = {
        schemaVersion: 1,
        collections: [{ id: 'ideas', name: 'Ideas', order: 0 }],
        assignments: { [key]: { folderId: 'ideas', archived: false } },
    };
    const result = migrateIndex(legacy, NOW);
    assert.equal(result.changed, true);
    assert.equal(result.index.folders[0].id, 'ideas');
    assert.equal(result.index.assignments.length, 1);
    assert.equal(identityKey(result.index.assignments[0].identity), key);
});

test('migration breaks corrupt folder cycles and remains idempotent', () => {
    const raw = createEmptyIndex(NOW);
    raw.folders = [
        { id: 'a', name: 'A', parentId: 'b', order: 0, scope: { kind: 'global' } },
        { id: 'b', name: 'B', parentId: 'a', order: 0, scope: { kind: 'global' } },
    ];
    const first = migrateIndex(raw, NOW);
    assert.ok(first.index.folders.some(folder => folder.parentId === null));
    const second = migrateIndex(first.index, NOW);
    assert.equal(second.changed, false);
});

test('duplicate composite identities never overwrite the first assignment', () => {
    const raw = createEmptyIndex(NOW);
    raw.assignments = [
        { identity: SOLO, folderId: 'first' },
        { identity: SOLO, folderId: 'second' },
    ];
    const result = migrateIndex(raw, NOW);
    assert.equal(result.index.assignments.length, 1);
    assert.equal(result.index.assignments[0].folderId, null, 'missing folders become Unfiled');
    assert.ok(result.index.reconciliation.some(item => item.status === 'duplicate-identity'));
});

test('folder deletion unfiles chats and never removes catalog entries', () => {
    const index = createEmptyIndex(NOW);
    const folder = addFolder(index, { name: 'Drafts' }, NOW);
    assignChat(index, { identity: SOLO, lastKnown: { preview: 'Opening' } }, folder.id, NOW);
    reconcileIndex(index, [{ identity: SOLO, ownerName: 'Writer', preview: 'Opening', messageCount: 1 }], NOW);
    deleteFolder(index, folder.id, NOW);
    assert.equal(getAssignment(index, SOLO).folderId, null);
    assert.equal(index.catalog.length, 1);
});

test('reconciliation marks missing chats and resolves them when they return', () => {
    const index = createEmptyIndex(NOW);
    reconcileIndex(index, [{ identity: SOLO, ownerName: 'Writer', preview: 'Opening', messageCount: 1 }], NOW);
    reconcileIndex(index, [], NOW + 1000);
    assert.equal(getMissingChats(index, []).length, 1);
    const missing = index.reconciliation.find(item => item.status === 'missing');
    assert.equal(missing.resolvedAt, null);
    reconcileIndex(index, [{ identity: SOLO, ownerName: 'Writer', preview: 'Returned', messageCount: 2 }], NOW + 2000);
    assert.ok(missing.resolvedAt);
});

test('rename collision is recorded without overwriting either identity', () => {
    const index = createEmptyIndex(NOW);
    const other = { ...SOLO, fileName: 'Draft Two.jsonl' };
    assignChat(index, { identity: SOLO }, null, NOW);
    assignChat(index, { identity: other }, null, NOW);
    renameIdentity(index, SOLO, other, NOW);
    assert.equal(index.assignments.length, 2);
    assert.ok(index.reconciliation.some(item => item.status === 'duplicate-identity'));
});

test('character rename updates chat owners and character-scoped folders', () => {
    const index = createEmptyIndex(NOW);
    const folder = addFolder(index, { name: 'Writer only', scope: { kind: 'character', ownerId: 'Writer.png' } }, NOW);
    assignChat(index, { identity: SOLO }, folder.id, NOW);
    renameCharacterOwner(index, 'Writer.png', 'Author.png', NOW);
    assert.equal(index.assignments[0].identity.ownerId, 'Author.png');
    assert.equal(index.folders[0].scope.ownerId, 'Author.png');
});
