import {
    SPECIAL_VIEWS,
    addFolder,
    assignChat,
    deleteFolder,
    folderAndDescendants,
    getAssignment,
    getMissingChats,
    identityKey,
    moveFolder,
    renameFolder,
    setArchived,
} from './model.js';
import { downloadIndex } from './storage.js';

const SPECIAL_LABELS = Object.freeze({
    [SPECIAL_VIEWS.ALL]: 'All Chats',
    [SPECIAL_VIEWS.UNFILED]: 'Unfiled',
    [SPECIAL_VIEWS.RECENT]: 'Recently Used',
    [SPECIAL_VIEWS.MISSING]: 'Missing Files',
    [SPECIAL_VIEWS.ARCHIVED]: 'Archived',
});

const WINDOW_GEOMETRY_KEY = 'chatCollections.windowGeometry.v1';
const LOAD_ON_SELECT_KEY = 'chatCollections.loadOnSelect.v1';

function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
}

function notify(type, message) {
    if (globalThis.toastr?.[type]) globalThis.toastr[type](message, 'Chat Collections');
    else if (type === 'error') console.error(`[Chat Collections] ${message}`);
    else console.info(`[Chat Collections] ${message}`);
}

function formatDate(value) {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? String(value) : date.toLocaleString();
}

function truncate(value, max = 180) {
    const text = String(value || '');
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, character => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        "'": '&#39;',
        '"': '&quot;',
    })[character]);
}

export class ChatCollectionsUI {
    constructor(controller) {
        this.controller = controller;
        this.index = null;
        this.inventory = [];
        this.view = { kind: 'special', id: SPECIAL_VIEWS.ALL };
        this.selectedKey = null;
        this.draggedFolderId = null;
        this.draggingChat = false;
        this.openingChatKey = null;
        this.chatActionPending = null;
        this.geometrySaveTimer = null;
        this.nodes = {};
    }

    mount() {
        const menu = document.getElementById('extensionsMenu');
        if (!menu || document.getElementById('chat_collections_menu_button')) return false;
        menu.append(this.makeMenuButton('chat_collections_menu_button', 'fa-folder-tree', 'Chat Collections', () => this.open()));
        menu.append(this.makeMenuButton('chat_collections_move_button', 'fa-folder-plus', 'Move current to collection', () => this.openQuickMove()));
        this.buildOverlay();
        this.buildQuickDialog();
        return true;
    }

    makeMenuButton(id, icon, label, handler) {
        const button = element('div', 'list-group-item flex-container flexGap5');
        button.id = id;
        const iconNode = element('div', `fa-solid ${icon} extensionsMenuExtensionButton`);
        const textNode = element('span', '', label);
        button.append(iconNode, textNode);
        button.addEventListener('click', handler);
        return button;
    }

    buildOverlay() {
        const overlay = element('div', 'cc-overlay');
        overlay.id = 'chat_collections_overlay';
        overlay.hidden = true;
        overlay.innerHTML = `
            <section class="cc-browser" role="dialog" aria-modal="false" aria-labelledby="cc-title">
                <header class="cc-header">
                    <div class="cc-title-block">
                        <h2 id="cc-title"><i class="fa-solid fa-grip-lines cc-drag-grip" aria-hidden="true"></i> Chat Collections</h2>
                        <span id="cc-status" class="cc-muted"></span>
                    </div>
                    <div class="cc-header-actions">
                        <button id="cc-refresh" type="button" title="Refresh chat inventory"><i class="fa-solid fa-rotate"></i> Refresh</button>
                        <button id="cc-export" type="button"><i class="fa-solid fa-file-export"></i> Export</button>
                        <button id="cc-import" type="button"><i class="fa-solid fa-file-import"></i> Import</button>
                        <input id="cc-import-file" type="file" accept="application/json,.json" hidden>
                        <button id="cc-reset-window" type="button" title="Reset window size and position" aria-label="Reset window size and position"><i class="fa-solid fa-up-right-and-down-left-from-center"></i></button>
                        <button id="cc-close" type="button" aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
                    </div>
                </header>
                <div class="cc-layout">
                    <aside class="cc-sidebar">
                        <nav id="cc-special-views" class="cc-nav"></nav>
                        <div class="cc-sidebar-heading">
                            <strong>Collections</strong>
                            <button id="cc-folder-root" type="button" title="Move selected collection to top level"><i class="fa-solid fa-turn-up"></i></button>
                        </div>
                        <div id="cc-folder-tree" class="cc-folder-tree"></div>
                        <label class="cc-field">New collection scope<select id="cc-new-scope"></select></label>
                        <div class="cc-folder-actions">
                            <button id="cc-folder-add" type="button"><i class="fa-solid fa-plus"></i> New</button>
                            <button id="cc-folder-rename" type="button">Rename</button>
                            <button id="cc-folder-delete" type="button">Delete</button>
                            <button id="cc-folder-up" type="button" title="Move up"><i class="fa-solid fa-arrow-up"></i></button>
                            <button id="cc-folder-down" type="button" title="Move down"><i class="fa-solid fa-arrow-down"></i></button>
                        </div>
                    </aside>
                    <main class="cc-main">
                        <div class="cc-toolbar">
                            <input id="cc-search" type="search" placeholder="Search character, filename, or preview">
                            <select id="cc-sort" aria-label="Sort chats">
                                <option value="activity-desc">Newest activity</option>
                                <option value="activity-asc">Oldest activity</option>
                                <option value="owner-asc">Character / group</option>
                                <option value="filename-asc">Filename</option>
                                <option value="messages-desc">Message count</option>
                            </select>
                        </div>
                        <div class="cc-selection-actions">
                            <div class="cc-chat-actions">
                                <label class="cc-load-on-select" title="Load a chat in SillyTavern when its row is selected"><input id="cc-load-on-select" type="checkbox"> Load on select</label>
                                <button id="cc-open" type="button" class="menu_button"><i class="fa-solid fa-arrow-up-right-from-square"></i> Load chat</button>
                                <button id="cc-new-chat" type="button"><i class="fa-solid fa-message"></i> New chat</button>
                                <button id="cc-rename-chat" type="button"><i class="fa-solid fa-pen"></i> Rename</button>
                                <button id="cc-delete-chat" type="button"><i class="fa-solid fa-trash"></i> Delete</button>
                            </div>
                            <div class="cc-organize-actions">
                                <select id="cc-move-target" aria-label="Move selected chat to collection"></select>
                                <button id="cc-move" type="button">Move selected</button>
                                <button id="cc-archive" type="button">Archive</button>
                            </div>
                        </div>
                        <div class="cc-table-wrap">
                            <table class="cc-table">
                                <thead><tr><th title="Character or group">Owner</th><th>Filename</th><th>Last activity</th><th title="Message count">Msgs</th><th>Preview</th></tr></thead>
                                <tbody id="cc-chat-rows"></tbody>
                            </table>
                            <div id="cc-empty" class="cc-empty" hidden>No chats in this view.</div>
                        </div>
                    </main>
                </div>
            </section>`;
        document.body.appendChild(overlay);
        this.nodes = {
            overlay,
            browser: overlay.querySelector('.cc-browser'),
            header: overlay.querySelector('.cc-header'),
            status: overlay.querySelector('#cc-status'),
            special: overlay.querySelector('#cc-special-views'),
            tree: overlay.querySelector('#cc-folder-tree'),
            scope: overlay.querySelector('#cc-new-scope'),
            search: overlay.querySelector('#cc-search'),
            sort: overlay.querySelector('#cc-sort'),
            loadOnSelect: overlay.querySelector('#cc-load-on-select'),
            moveTarget: overlay.querySelector('#cc-move-target'),
            rows: overlay.querySelector('#cc-chat-rows'),
            empty: overlay.querySelector('#cc-empty'),
        };
        overlay.querySelector('#cc-close').addEventListener('click', () => this.close());
        overlay.querySelector('#cc-reset-window').addEventListener('click', () => this.resetWindowGeometry());
        overlay.querySelector('#cc-refresh').addEventListener('click', () => this.refresh());
        overlay.querySelector('#cc-export').addEventListener('click', () => downloadIndex(this.index));
        overlay.querySelector('#cc-import').addEventListener('click', () => overlay.querySelector('#cc-import-file').click());
        overlay.querySelector('#cc-import-file').addEventListener('change', event => this.importFile(event));
        this.nodes.search.addEventListener('input', () => this.renderRows());
        this.nodes.sort.addEventListener('change', async () => {
            this.index.preferences.sort = this.nodes.sort.value;
            await this.controller.persist(this.index);
            this.renderRows();
        });
        overlay.querySelector('#cc-folder-add').addEventListener('click', () => this.createFolder());
        overlay.querySelector('#cc-folder-rename').addEventListener('click', () => this.renameSelectedFolder());
        overlay.querySelector('#cc-folder-delete').addEventListener('click', () => this.deleteSelectedFolder());
        overlay.querySelector('#cc-folder-up').addEventListener('click', () => this.reorderSelectedFolder(-1));
        overlay.querySelector('#cc-folder-down').addEventListener('click', () => this.reorderSelectedFolder(1));
        overlay.querySelector('#cc-folder-root').addEventListener('click', () => this.moveSelectedFolderToRoot());
        overlay.querySelector('#cc-folder-root').addEventListener('dragover', event => event.preventDefault());
        overlay.querySelector('#cc-folder-root').addEventListener('drop', event => this.dropFolder(event, null));
        overlay.querySelector('#cc-move').addEventListener('click', () => this.moveSelectedChat());
        overlay.querySelector('#cc-archive').addEventListener('click', () => this.archiveSelectedChat());
        overlay.querySelector('#cc-open').addEventListener('click', () => this.openSelectedChat());
        overlay.querySelector('#cc-new-chat').addEventListener('click', () => this.createNewChat());
        overlay.querySelector('#cc-rename-chat').addEventListener('click', () => this.renameSelectedChat());
        overlay.querySelector('#cc-delete-chat').addEventListener('click', () => this.deleteSelectedChat());
        this.nodes.loadOnSelect.checked = this.readLocalPreference(LOAD_ON_SELECT_KEY, true);
        this.nodes.loadOnSelect.addEventListener('change', () => this.writeLocalPreference(LOAD_ON_SELECT_KEY, this.nodes.loadOnSelect.checked));
        this.enableFloatingWindow();
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape' && !overlay.hidden) this.close();
        });
    }

    readLocalPreference(key, fallback) {
        try {
            const stored = localStorage.getItem(key);
            return stored === null ? fallback : JSON.parse(stored);
        } catch {
            return fallback;
        }
    }

    writeLocalPreference(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
        } catch {
            // Browser storage can be unavailable in restricted profiles.
        }
    }

    enableFloatingWindow() {
        const panel = this.nodes.browser;
        const header = this.nodes.header;
        header.addEventListener('pointerdown', event => {
            if (event.button !== 0 || event.target.closest('button, input, select, a') || window.matchMedia('(max-width: 760px)').matches) return;
            event.preventDefault();
            const rect = panel.getBoundingClientRect();
            const startX = event.clientX;
            const startY = event.clientY;
            const startLeft = rect.left;
            const startTop = rect.top;
            panel.classList.add('dragging');
            header.setPointerCapture(event.pointerId);

            const move = pointerEvent => {
                const maxLeft = Math.max(8, window.innerWidth - rect.width - 8);
                const maxTop = Math.max(8, window.innerHeight - rect.height - 8);
                const left = Math.max(8, Math.min(maxLeft, startLeft + pointerEvent.clientX - startX));
                const top = Math.max(8, Math.min(maxTop, startTop + pointerEvent.clientY - startY));
                panel.style.left = `${left}px`;
                panel.style.top = `${top}px`;
            };
            const stop = () => {
                panel.classList.remove('dragging');
                header.removeEventListener('pointermove', move);
                header.removeEventListener('pointerup', stop);
                header.removeEventListener('pointercancel', stop);
                this.saveWindowGeometry();
            };
            header.addEventListener('pointermove', move);
            header.addEventListener('pointerup', stop);
            header.addEventListener('pointercancel', stop);
        });

        this.windowResizeObserver = new ResizeObserver(() => this.scheduleGeometrySave());
        this.windowResizeObserver.observe(panel);
        window.addEventListener('resize', () => {
            if (!this.nodes.overlay.hidden) {
                this.syncOverlayToViewport();
                this.constrainWindowToViewport();
            }
        });
        window.addEventListener('scroll', () => {
            if (!this.nodes.overlay.hidden) this.syncOverlayToViewport();
        }, { passive: true });
    }

    syncOverlayToViewport() {
        this.nodes.overlay.style.left = `${window.scrollX}px`;
        this.nodes.overlay.style.top = `${window.scrollY}px`;
        this.nodes.overlay.style.width = `${window.innerWidth}px`;
        this.nodes.overlay.style.height = `${window.innerHeight}px`;
    }

    scheduleGeometrySave() {
        clearTimeout(this.geometrySaveTimer);
        this.geometrySaveTimer = setTimeout(() => this.saveWindowGeometry(), 250);
    }

    saveWindowGeometry() {
        if (this.nodes.overlay.hidden || window.matchMedia('(max-width: 760px)').matches) return;
        const rect = this.nodes.browser.getBoundingClientRect();
        this.writeLocalPreference(WINDOW_GEOMETRY_KEY, {
            left: Math.round(rect.left),
            top: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
        });
    }

    applyWindowGeometry() {
        if (window.matchMedia('(max-width: 760px)').matches) {
            for (const property of ['left', 'top', 'width', 'height']) this.nodes.browser.style.removeProperty(property);
            return;
        }
        const geometry = this.readLocalPreference(WINDOW_GEOMETRY_KEY, null);
        if (!geometry || !['left', 'top', 'width', 'height'].every(key => Number.isFinite(Number(geometry[key])))) {
            this.resetWindowGeometry(false);
            return;
        }
        const width = Math.max(680, Math.min(Number(geometry.width), window.innerWidth - 16));
        const height = Math.max(420, Math.min(Number(geometry.height), window.innerHeight - 16));
        this.nodes.browser.style.width = `${width}px`;
        this.nodes.browser.style.height = `${height}px`;
        this.nodes.browser.style.left = `${Math.max(8, Math.min(Number(geometry.left), window.innerWidth - width - 8))}px`;
        this.nodes.browser.style.top = `${Math.max(8, Math.min(Number(geometry.top), window.innerHeight - height - 8))}px`;
    }

    resetWindowGeometry(persist = true) {
        if (window.matchMedia('(max-width: 760px)').matches) return;
        const width = Math.min(1040, Math.round(window.innerWidth * 0.82));
        const height = Math.min(700, Math.round(window.innerHeight * 0.84));
        this.nodes.browser.style.width = `${width}px`;
        this.nodes.browser.style.height = `${height}px`;
        this.nodes.browser.style.left = `${Math.max(8, Math.round((window.innerWidth - width) / 2))}px`;
        this.nodes.browser.style.top = `${Math.max(8, Math.round((window.innerHeight - height) / 2))}px`;
        if (persist) this.saveWindowGeometry();
    }

    constrainWindowToViewport() {
        if (window.matchMedia('(max-width: 760px)').matches) return;
        const rect = this.nodes.browser.getBoundingClientRect();
        const width = Math.min(rect.width, window.innerWidth - 16);
        const height = Math.min(rect.height, window.innerHeight - 16);
        const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
        const top = Math.max(8, Math.min(rect.top, window.innerHeight - height - 8));
        this.nodes.browser.style.width = `${width}px`;
        this.nodes.browser.style.height = `${height}px`;
        this.nodes.browser.style.left = `${left}px`;
        this.nodes.browser.style.top = `${top}px`;
        this.scheduleGeometrySave();
    }

    buildQuickDialog() {
        const dialog = element('dialog', 'cc-quick-dialog');
        dialog.id = 'chat_collections_quick_dialog';
        dialog.innerHTML = `
            <form method="dialog">
                <h3>Move current chat</h3>
                <p id="cc-quick-current" class="cc-muted"></p>
                <label class="cc-field">Collection<select id="cc-quick-target"></select></label>
                <div class="cc-dialog-actions"><button value="cancel">Cancel</button><button id="cc-quick-save" value="default" class="menu_button">Move</button></div>
            </form>`;
        document.body.appendChild(dialog);
        this.nodes.quickDialog = dialog;
        this.nodes.quickTarget = dialog.querySelector('#cc-quick-target');
        this.nodes.quickCurrent = dialog.querySelector('#cc-quick-current');
        dialog.querySelector('#cc-quick-save').addEventListener('click', async event => {
            event.preventDefault();
            try {
                const chat = this.inventory.find(item => identityKey(item.identity) === dialog.dataset.chatKey);
                if (!chat) throw new Error('The current chat is not in the latest inventory. Refresh and try again.');
                assignChat(this.index, chat, this.nodes.quickTarget.value || null);
                await this.controller.persist(this.index);
                dialog.close();
                this.render();
                notify('success', 'Current chat moved.');
            } catch (error) {
                notify('error', error.message);
            }
        });
    }

    setData(index, inventory) {
        this.index = index;
        this.inventory = inventory;
        if (this.nodes.sort) this.nodes.sort.value = index.preferences?.sort || 'activity-desc';
        if (!this.nodes.overlay?.hidden) this.render();
    }

    async open() {
        this.nodes.overlay.hidden = false;
        this.syncOverlayToViewport();
        this.applyWindowGeometry();
        await this.refresh();
        this.nodes.search.focus();
    }

    close() {
        this.saveWindowGeometry();
        this.nodes.overlay.hidden = true;
    }

    async refresh() {
        this.nodes.status.textContent = 'Refreshing…';
        try {
            await this.controller.refresh();
            this.nodes.status.textContent = `${this.inventory.length.toLocaleString()} chats • index revision ${this.index.revision}`;
            this.render();
        } catch (error) {
            this.nodes.status.textContent = 'Refresh failed';
            notify('error', error.message);
        }
    }

    render() {
        this.renderSpecialViews();
        this.renderScopeOptions();
        this.renderFolders();
        this.renderRows();
    }

    renderSpecialViews() {
        this.nodes.special.replaceChildren();
        for (const [id, label] of Object.entries(SPECIAL_LABELS)) {
            const button = element('button', 'cc-nav-item', label);
            button.type = 'button';
            button.classList.toggle('active', this.view.kind === 'special' && this.view.id === id);
            button.addEventListener('click', () => {
                this.view = { kind: 'special', id };
                this.selectedKey = null;
                this.render();
            });
            this.nodes.special.appendChild(button);
        }
    }

    renderScopeOptions() {
        const current = this.nodes.scope.value;
        this.nodes.scope.replaceChildren(new Option('Global', 'global'));
        for (const character of this.controller.getContext().characters || []) {
            this.nodes.scope.appendChild(new Option(`Character: ${character.name}`, `character:${character.avatar}`));
        }
        if ([...this.nodes.scope.options].some(option => option.value === current)) this.nodes.scope.value = current;
    }

    renderFolders() {
        this.nodes.tree.replaceChildren();
        const children = new Map();
        for (const folder of this.index.folders) {
            const parent = folder.parentId || '__root__';
            if (!children.has(parent)) children.set(parent, []);
            children.get(parent).push(folder);
        }
        for (const list of children.values()) list.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
        const appendBranch = (parentId, container, depth) => {
            for (const folder of children.get(parentId || '__root__') || []) {
                const row = element('button', 'cc-folder-row');
                row.type = 'button';
                row.draggable = true;
                row.dataset.folderId = folder.id;
                row.style.setProperty('--cc-depth', depth);
                row.classList.toggle('active', this.view.kind === 'folder' && this.view.id === folder.id);
                const scope = folder.scope.kind === 'character' ? 'character' : 'global';
                row.append(element('i', 'fa-regular fa-folder'), element('span', 'cc-folder-name', folder.name), element('span', 'cc-folder-scope', scope));
                row.addEventListener('click', () => {
                    this.view = { kind: 'folder', id: folder.id };
                    this.selectedKey = null;
                    this.render();
                });
                row.addEventListener('dragstart', event => {
                    this.draggedFolderId = folder.id;
                    event.dataTransfer.setData('application/x-chat-collection-folder', folder.id);
                });
                row.addEventListener('dragover', event => event.preventDefault());
                row.addEventListener('drop', event => this.dropFolder(event, folder.id));
                container.appendChild(row);
                appendBranch(folder.id, container, depth + 1);
            }
        };
        appendBranch(null, this.nodes.tree, 0);
        if (!this.index.folders.length) this.nodes.tree.append(element('p', 'cc-muted cc-pad', 'No collections yet.'));
        this.updateFolderControls();
    }

    updateFolderControls() {
        const folder = this.view.kind === 'folder' ? this.index.folders.find(item => item.id === this.view.id) : null;
        const siblings = folder ? this.index.folders.filter(item => item.parentId === folder.parentId).sort((a, b) => a.order - b.order) : [];
        const position = folder ? siblings.findIndex(item => item.id === folder.id) : -1;
        this.nodes.overlay.querySelector('#cc-folder-rename').disabled = !folder;
        this.nodes.overlay.querySelector('#cc-folder-delete').disabled = !folder;
        this.nodes.overlay.querySelector('#cc-folder-root').disabled = !folder || folder.parentId === null;
        this.nodes.overlay.querySelector('#cc-folder-up').disabled = !folder || position <= 0;
        this.nodes.overlay.querySelector('#cc-folder-down').disabled = !folder || position < 0 || position >= siblings.length - 1;
    }

    visibleChats() {
        const assignments = new Map(this.index.assignments.map(item => [identityKey(item.identity), item]));
        let chats = [...this.inventory];
        if (this.view.kind === 'folder') {
            const folderIds = folderAndDescendants(this.index, this.view.id);
            chats = chats.filter(chat => folderIds.has(assignments.get(identityKey(chat.identity))?.folderId));
        } else if (this.view.id === SPECIAL_VIEWS.UNFILED) {
            chats = chats.filter(chat => {
                const assignment = assignments.get(identityKey(chat.identity));
                return !assignment?.folderId && !assignment?.archived;
            });
        } else if (this.view.id === SPECIAL_VIEWS.ARCHIVED) {
            const live = new Map(chats.map(chat => [identityKey(chat.identity), chat]));
            chats = this.index.assignments.filter(item => item.archived).map(item => live.get(identityKey(item.identity)) || ({ identity: item.identity, ...item.lastKnown, missing: true }));
        } else if (this.view.id === SPECIAL_VIEWS.MISSING) {
            chats = getMissingChats(this.index, this.inventory);
        } else if (this.view.id === SPECIAL_VIEWS.RECENT) {
            chats = chats.sort((a, b) => (b.activityTimestamp || Date.parse(b.lastActivity) || 0) - (a.activityTimestamp || Date.parse(a.lastActivity) || 0)).slice(0, 100);
        }

        const query = this.nodes.search.value.trim().toLocaleLowerCase();
        if (query) chats = chats.filter(chat => [chat.ownerName, chat.identity.fileName, chat.preview].some(value => String(value || '').toLocaleLowerCase().includes(query)));
        const sort = this.nodes.sort.value;
        chats.sort((a, b) => {
            if (sort === 'activity-asc') return this.chatTime(a) - this.chatTime(b);
            if (sort === 'owner-asc') return String(a.ownerName).localeCompare(String(b.ownerName)) || a.identity.fileName.localeCompare(b.identity.fileName);
            if (sort === 'filename-asc') return a.identity.fileName.localeCompare(b.identity.fileName);
            if (sort === 'messages-desc') return Number(b.messageCount || 0) - Number(a.messageCount || 0);
            return this.chatTime(b) - this.chatTime(a);
        });
        return chats;
    }

    chatTime(chat) {
        return Number(chat.activityTimestamp || Date.parse(chat.lastActivity) || 0);
    }

    renderRows() {
        const chats = this.visibleChats();
        this.nodes.rows.replaceChildren();
        for (const chat of chats) {
            const key = identityKey(chat.identity);
            const assignment = getAssignment(this.index, chat.identity);
            const row = element('tr', 'cc-chat-row');
            row.tabIndex = 0;
            row.draggable = !chat.missing;
            row.dataset.identityKey = key;
            row.classList.toggle('selected', key === this.selectedKey);
            const ownerCell = element('td');
            ownerCell.append(element('span', 'cc-type-badge', chat.identity.type === 'group' ? 'Group' : 'Solo'), document.createTextNode(` ${chat.ownerName || chat.identity.ownerId}`));
            const fileCell = element('td', '', chat.identity.fileName);
            if (assignment?.archived) fileCell.append(element('span', 'cc-state-badge', ' archived'));
            if (chat.missing) fileCell.append(element('span', 'cc-state-badge cc-missing', ' missing'));
            row.append(ownerCell, fileCell, element('td', '', formatDate(chat.lastActivity)), element('td', 'cc-number', Number(chat.messageCount || 0).toLocaleString()), element('td', 'cc-preview', truncate(chat.preview)));
            row.addEventListener('click', () => {
                if (this.draggingChat) return;
                this.selectedKey = key;
                this.nodes.rows.querySelector('.selected')?.classList.remove('selected');
                row.classList.add('selected');
                this.updateSelectionControls();
                if (this.nodes.loadOnSelect.checked && !chat.missing) void this.openSelectedChat(chat);
            });
            row.addEventListener('dblclick', () => {
                if (!this.nodes.loadOnSelect.checked) void this.openSelectedChat(chat);
            });
            row.addEventListener('keydown', event => {
                if (event.key === 'Enter') void this.openSelectedChat(chat);
            });
            row.addEventListener('dragstart', event => {
                this.draggingChat = true;
                event.dataTransfer.setData('application/x-chat-collection-chat', key);
            });
            row.addEventListener('dragend', () => setTimeout(() => { this.draggingChat = false; }, 0));
            this.nodes.rows.appendChild(row);
        }
        this.nodes.empty.hidden = chats.length > 0;
        this.updateSelectionControls();
        this.syncActiveChatRow();
    }

    updateSelectionControls() {
        const selected = this.selectedChat();
        this.populateMoveTargets(this.nodes.moveTarget, selected);
        const archiveButton = this.nodes.overlay.querySelector('#cc-archive');
        const moveButton = this.nodes.overlay.querySelector('#cc-move');
        const openButton = this.nodes.overlay.querySelector('#cc-open');
        const newButton = this.nodes.overlay.querySelector('#cc-new-chat');
        const renameButton = this.nodes.overlay.querySelector('#cc-rename-chat');
        const deleteButton = this.nodes.overlay.querySelector('#cc-delete-chat');
        const busy = Boolean(this.openingChatKey || this.chatActionPending);
        const actionable = Boolean(selected && !selected.missing && !busy);
        archiveButton.textContent = selected && getAssignment(this.index, selected.identity)?.archived ? 'Unarchive' : 'Archive';
        this.nodes.moveTarget.disabled = !selected || busy;
        moveButton.disabled = !selected || busy;
        archiveButton.disabled = !selected || busy;
        openButton.disabled = !actionable;
        newButton.disabled = !actionable;
        renameButton.disabled = !actionable;
        deleteButton.disabled = !actionable;
        openButton.textContent = this.openingChatKey ? 'Loading…' : 'Load chat';
    }

    syncActiveChatRow() {
        const activeIdentity = this.controller.currentIdentity();
        const activeKey = activeIdentity ? identityKey(activeIdentity) : null;
        for (const row of this.nodes.rows.querySelectorAll('.cc-chat-row')) {
            row.classList.toggle('active-chat', row.dataset.identityKey === activeKey);
        }
    }

    selectedChat() {
        if (!this.selectedKey) return null;
        return this.visibleChats().find(chat => identityKey(chat.identity) === this.selectedKey)
            || this.inventory.find(chat => identityKey(chat.identity) === this.selectedKey)
            || getMissingChats(this.index, this.inventory).find(chat => identityKey(chat.identity) === this.selectedKey)
            || null;
    }

    populateMoveTargets(select, chat) {
        const prior = select.value;
        select.replaceChildren(new Option('Unfiled', ''));
        for (const folder of [...this.index.folders].sort((a, b) => a.name.localeCompare(b.name))) {
            if (chat && folder.scope.kind === 'character' && (chat.identity.type !== 'solo' || folder.scope.ownerId !== chat.identity.ownerId)) continue;
            const label = folder.scope.kind === 'character' ? `${folder.name} (character)` : folder.name;
            select.appendChild(new Option(label, folder.id));
        }
        if (chat) select.value = getAssignment(this.index, chat.identity)?.folderId || '';
        else if ([...select.options].some(option => option.value === prior)) select.value = prior;
    }

    async createFolder() {
        const name = window.prompt('Collection name:');
        if (!name?.trim()) return;
        const value = this.nodes.scope.value;
        const scope = value.startsWith('character:') ? { kind: 'character', ownerId: value.slice('character:'.length) } : { kind: 'global', ownerId: null };
        const parentId = this.view.kind === 'folder' ? this.view.id : null;
        addFolder(this.index, { name, parentId, scope });
        await this.controller.persist(this.index);
        this.render();
    }

    async renameSelectedFolder() {
        if (this.view.kind !== 'folder') return notify('info', 'Select a collection first.');
        const folder = this.index.folders.find(item => item.id === this.view.id);
        const name = window.prompt('New collection name:', folder?.name || '');
        if (!name?.trim()) return;
        renameFolder(this.index, this.view.id, name);
        await this.controller.persist(this.index);
        this.render();
    }

    async deleteSelectedFolder() {
        if (this.view.kind !== 'folder') return notify('info', 'Select a collection first.');
        const folder = this.index.folders.find(item => item.id === this.view.id);
        if (!window.confirm(`Delete collection "${folder?.name}"?\n\nNo chat files will be deleted. Chats become Unfiled and child collections move up one level.`)) return;
        deleteFolder(this.index, this.view.id);
        this.view = { kind: 'special', id: SPECIAL_VIEWS.UNFILED };
        await this.controller.persist(this.index);
        this.render();
    }

    async reorderSelectedFolder(delta) {
        if (this.view.kind !== 'folder') return notify('info', 'Select a collection first.');
        const folder = this.index.folders.find(item => item.id === this.view.id);
        const siblings = this.index.folders.filter(item => item.parentId === folder.parentId).sort((a, b) => a.order - b.order);
        const index = siblings.findIndex(item => item.id === folder.id);
        moveFolder(this.index, folder.id, folder.parentId, index + delta);
        await this.controller.persist(this.index);
        this.renderFolders();
    }

    async moveSelectedFolderToRoot() {
        if (this.view.kind !== 'folder') return notify('info', 'Select a collection first.');
        moveFolder(this.index, this.view.id, null);
        await this.controller.persist(this.index);
        this.renderFolders();
    }

    async dropFolder(event, parentId) {
        event.preventDefault();
        event.stopPropagation();
        const chatKey = event.dataTransfer.getData('application/x-chat-collection-chat');
        if (chatKey && parentId) {
            const chat = this.inventory.find(item => identityKey(item.identity) === chatKey);
            if (!chat) return;
            try {
                assignChat(this.index, chat, parentId);
                await this.controller.persist(this.index);
                this.render();
            } catch (error) {
                notify('error', error.message);
            }
            return;
        }
        const folderId = event.dataTransfer.getData('application/x-chat-collection-folder') || this.draggedFolderId;
        if (!folderId || folderId === parentId) return;
        try {
            moveFolder(this.index, folderId, parentId);
            await this.controller.persist(this.index);
            this.renderFolders();
        } catch (error) {
            notify('error', error.message);
        }
    }

    async moveSelectedChat() {
        const chat = this.selectedChat();
        if (!chat) return notify('info', 'Select a chat first.');
        try {
            assignChat(this.index, chat, this.nodes.moveTarget.value || null);
            await this.controller.persist(this.index);
            this.render();
        } catch (error) {
            notify('error', error.message);
        }
    }

    async archiveSelectedChat() {
        const chat = this.selectedChat();
        if (!chat) return notify('info', 'Select a chat first.');
        const archived = !getAssignment(this.index, chat.identity)?.archived;
        setArchived(this.index, chat, archived);
        await this.controller.persist(this.index);
        this.render();
    }

    async openSelectedChat(chatOverride = null) {
        const chat = chatOverride || this.selectedChat();
        if (!chat) return notify('info', 'Select a chat first.');
        if (chat.missing) return notify('error', 'This chat file is missing and cannot be opened.');
        const key = identityKey(chat.identity);
        if (this.openingChatKey === key) return;
        if (this.openingChatKey) return notify('info', 'Please wait for the current chat to finish loading.');
        this.openingChatKey = key;
        this.nodes.status.textContent = `Loading ${chat.ownerName || chat.identity.ownerId} — ${chat.identity.fileName}…`;
        this.updateSelectionControls();
        try {
            await this.controller.openChat(chat);
            this.selectedKey = key;
            this.nodes.status.textContent = `Loaded ${chat.ownerName || chat.identity.ownerId} — ${chat.identity.fileName}`;
            this.syncActiveChatRow();
        } catch (error) {
            notify('error', error.message);
            this.nodes.status.textContent = 'Chat load failed';
        } finally {
            this.openingChatKey = null;
            this.updateSelectionControls();
        }
    }

    async runChatAction(label, action) {
        if (this.chatActionPending || this.openingChatKey) return notify('info', 'Please wait for the current chat action to finish.');
        this.chatActionPending = label;
        this.nodes.status.textContent = label;
        this.updateSelectionControls();
        try {
            await action();
        } catch (error) {
            this.nodes.status.textContent = `${label.replace(/…$/, '')} failed`;
            notify('error', error.message);
        } finally {
            this.chatActionPending = null;
            this.updateSelectionControls();
        }
    }

    async renameSelectedChat() {
        const chat = this.selectedChat();
        if (!chat || chat.missing) return notify('info', 'Select a live chat first.');
        const oldName = chat.identity.fileName.replace(/\.jsonl$/i, '');
        const input = await this.controller.getContext().Popup.show.input(
            'Rename Chat',
            `Rename <strong>${escapeHtml(chat.ownerName || chat.identity.ownerId)}</strong>'s selected chat.`,
            oldName,
            { okButton: 'Rename', cancelButton: 'Cancel' },
        );
        if (input === null) return;
        const newName = String(input).trim().replace(/\.jsonl$/i, '');
        if (!newName) return notify('warning', 'A chat name is required.');
        if (newName === oldName) return;

        await this.runChatAction('Renaming chat…', async () => {
            const oldKey = identityKey(chat.identity);
            await this.controller.renameChat(chat, newName);
            await this.controller.refresh();
            if (this.inventory.some(item => identityKey(item.identity) === oldKey)) throw new Error('The old chat name is still present. Rename was not completed.');
            const activeIdentity = this.controller.currentIdentity();
            this.selectedKey = activeIdentity ? identityKey(activeIdentity) : null;
            this.nodes.status.textContent = `Renamed chat to ${activeIdentity?.fileName || newName}`;
            this.render();
        });
    }

    async deleteSelectedChat() {
        const chat = this.selectedChat();
        if (!chat || chat.missing) return notify('info', 'Select a live chat first.');
        const result = await this.controller.getContext().Popup.show.confirm(
            'Delete Chat',
            `<p>Permanently delete this chat through SillyTavern?</p><p><strong>${escapeHtml(chat.ownerName || chat.identity.ownerId)}</strong><br><code>${escapeHtml(chat.identity.fileName)}</code></p><p>This cannot be undone. Collections and other chat files are not affected.</p>`,
            { okButton: 'Delete Chat', cancelButton: 'Cancel' },
        );
        if (!result) return;

        await this.runChatAction('Deleting chat…', async () => {
            const deletedKey = identityKey(chat.identity);
            const activeBefore = this.controller.currentIdentity();
            const wasActive = activeBefore && identityKey(activeBefore) === deletedKey;
            await this.controller.deleteChat(chat);
            await this.controller.refresh();
            if (this.inventory.some(item => identityKey(item.identity) === deletedKey)) throw new Error('SillyTavern still reports this chat as present. Deletion was not completed.');

            this.selectedKey = null;
            if (wasActive) {
                const replacement = this.inventory.find(item => item.identity.type === chat.identity.type && item.identity.ownerId === chat.identity.ownerId);
                if (replacement) {
                    await this.controller.openChat(replacement);
                    this.selectedKey = identityKey(replacement.identity);
                } else {
                    const newIdentity = await this.controller.createActiveChat();
                    await this.controller.refresh();
                    this.selectedKey = identityKey(newIdentity);
                }
            }
            this.nodes.status.textContent = `Deleted ${chat.identity.fileName}`;
            this.render();
        });
    }

    async createNewChat() {
        const chat = this.selectedChat();
        if (!chat || chat.missing) return notify('info', 'Select a live chat first.');
        await this.runChatAction('Starting new chat…', async () => {
            const sourceFolderId = getAssignment(this.index, chat.identity)?.folderId || null;
            const newIdentity = await this.controller.createChat(chat);
            await this.controller.refresh();
            const newChat = this.inventory.find(item => identityKey(item.identity) === identityKey(newIdentity));
            if (!newChat) throw new Error('The new chat was created but is not yet visible in the chat inventory. Refresh and try again.');
            if (sourceFolderId && this.index.folders.some(folder => folder.id === sourceFolderId)) {
                assignChat(this.index, newChat, sourceFolderId);
                await this.controller.persist(this.index);
            }
            this.selectedKey = identityKey(newIdentity);
            this.nodes.status.textContent = `Started ${newIdentity.fileName}`;
            this.render();
        });
    }

    async openQuickMove() {
        await this.controller.refresh();
        const identity = this.controller.currentIdentity();
        if (!identity) return notify('info', 'Open a solo or group chat first.');
        const key = identityKey(identity);
        const chat = this.inventory.find(item => identityKey(item.identity) === key);
        if (!chat) return notify('error', 'The current chat was not found in the inventory. Save it once, then try again.');
        this.nodes.quickDialog.dataset.chatKey = key;
        this.nodes.quickCurrent.textContent = `${chat.ownerName} — ${chat.identity.fileName}`;
        this.populateMoveTargets(this.nodes.quickTarget, chat);
        this.nodes.quickDialog.showModal();
    }

    async importFile(event) {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) return;
        try {
            const imported = JSON.parse(await file.text());
            if (!window.confirm('Replace the current organisation index with this JSON file? A backup will be created first. Chat files are not changed.')) return;
            const result = await this.controller.importIndex(imported);
            this.setData(result.index, this.inventory);
            this.render();
            notify('success', `Index imported. Backup: ${result.backup || 'not required'}`);
            if (result.warnings.length) notify('warning', `${result.warnings.length} duplicate identities were preserved as reconciliation records.`);
        } catch (error) {
            notify('error', `Import failed: ${error.message}`);
        }
    }
}
