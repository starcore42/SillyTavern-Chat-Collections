import { createEmptyIndex, migrateIndex, SCHEMA_VERSION } from './model.js';

export const INDEX_FILE_NAME = 'chat_collections.json';
export const INDEX_URL = `/user/files/${INDEX_FILE_NAME}`;

function encodeBase64(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return btoa(binary);
}

function backupName(label = 'migration') {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return `chat_collections.backup-${label}-${stamp}.json`;
}

export class CollectionStorage {
    constructor(getRequestHeaders) {
        this.getRequestHeaders = getRequestHeaders;
        this.writeQueue = Promise.resolve();
    }

    async fetchRaw() {
        const response = await fetch(`${INDEX_URL}?v=${Date.now()}`, { cache: 'no-store' });
        if (response.status === 404) return null;
        if (!response.ok) throw new Error(`Could not read ${INDEX_URL} (${response.status}).`);
        return response.json();
    }

    async upload(name, value) {
        const response = await fetch('/api/files/upload', {
            method: 'POST',
            headers: this.getRequestHeaders(),
            body: JSON.stringify({ name, data: encodeBase64(`${JSON.stringify(value, null, 2)}\n`) }),
        });
        if (!response.ok) throw new Error(`Could not save ${name} (${response.status}).`);
        return response.json();
    }

    async backup(value, label) {
        if (!value) return null;
        const name = backupName(label);
        await this.upload(name, value);
        return name;
    }

    async load() {
        const raw = await this.fetchRaw();
        if (!raw) {
            const index = createEmptyIndex();
            await this.upload(INDEX_FILE_NAME, index);
            return { index, created: true, migrated: false, backup: null, warnings: [] };
        }
        const result = migrateIndex(raw);
        let backup = null;
        if (result.changed) {
            backup = await this.backup(raw, `schema-${raw.schemaVersion || 0}-to-${SCHEMA_VERSION}`);
            await this.upload(INDEX_FILE_NAME, result.index);
        }
        return { index: result.index, created: false, migrated: result.changed, backup, warnings: result.warnings };
    }

    save(index) {
        const snapshot = structuredClone(index);
        this.writeQueue = this.writeQueue.then(() => this.upload(INDEX_FILE_NAME, snapshot));
        return this.writeQueue;
    }

    async replaceWithImport(currentIndex, importedRaw) {
        const result = migrateIndex(importedRaw);
        const backup = await this.backup(currentIndex, 'before-import');
        await this.upload(INDEX_FILE_NAME, result.index);
        return { index: result.index, backup, warnings: result.warnings };
    }
}

export function downloadIndex(index) {
    const blob = new Blob([`${JSON.stringify(index, null, 2)}\n`], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `chat_collections-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
}
