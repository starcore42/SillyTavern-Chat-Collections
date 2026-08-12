# Chat Collections

Chat Collections is a user-scoped SillyTavern UI extension for release 1.18.x. It adds virtual nested collections for saved solo and group chats without moving, renaming, deleting, or bulk-editing chat JSONL files.

## Open it

Open SillyTavern's **Extensions** menu and choose **Chat Collections**. The nearby **Move current to collection** command opens a small picker for the chat currently on screen.

The global browser includes:

- All Chats, Unfiled, Recently Used, Missing Files, and Archived views.
- Nested collections with create, rename, safe delete, reorder buttons, and drag/drop nesting.
- Chat-row drag/drop onto a collection.
- Global collections and collections limited to one character.
- Search and sorting by activity, owner, filename, or message count.
- Character/group, filename, activity, message count, and last-message preview.
- A non-modal floating browser that can be dragged by its title bar and resized from its lower-right corner. Window geometry is remembered in the current browser.
- Opening a selected live chat through SillyTavern's context API while keeping the collection browser open.
- Optional **Load on select** mode (enabled by default) to switch both the active character/group and chat with one row click. The orange left-edge marker identifies the active chat.
- Selected-chat controls for loading, starting a new chat with the same character/group, renaming, and deleting.
- Rename and new-chat actions use SillyTavern's current chat functions. Delete always displays SillyTavern's native confirmation popup and then uses its existing solo/group deletion functions and APIs.
- JSON export and confirmed import with an automatic pre-import backup.

## Storage and safety

The live organization index is stored at:

`user/files/chat_collections.json`

It is written through SillyTavern's authenticated `/api/files/upload` endpoint. Schema migrations first create a timestamped `chat_collections.backup-*.json` beside the index. Import also creates a backup.

Chat identities are the composite of chat type (`solo` or `group`), character avatar ID or group ID, and the `.jsonl` filename. The index keeps a catalog of previously seen chats and reconciliation records for missing/deleted owners, missing files, renames, and duplicate identities. Duplicate identities retain the first organization record and create a visible reconciliation record; they are never silently overwritten.

Deleting a collection only removes the collection definition. Its chats become Unfiled, child collections move up one level, and no chat file API is called. The separate **Delete** chat action is deliberately guarded by SillyTavern's native confirmation popup and routes deletion through SillyTavern's existing solo/group functions and APIs.

No external network requests are made. The extension requests only same-origin SillyTavern paths.

## Reconciliation behavior

The index refreshes in response to SillyTavern chat, character, and group events and when the browser is opened or manually refreshed. It does not poll or patch core functions.

- A native chat rename transfers an assignment only if the target composite identity is unused. A collision is recorded and neither assignment is overwritten.
- Character avatar-ID renames migrate matching solo identities and character-scoped folders.
- Deleted or absent chats and deleted character/group owners remain in the catalog and appear in Missing Files.
- A missing chat that reappears resolves its active missing/deleted reconciliation record.

The optional stable UUID in `chat_metadata` is intentionally not used: composite identities plus event-based reconciliation provide the feature without modifying message histories, even during normal saves.

## Files

- `manifest.json` — SillyTavern extension manifest.
- `index.js` — lifecycle and SillyTavern event integration.
- `inventory.js` — read-only global inventory and native open-chat actions.
- `model.js` — schema, collection operations, migrations, and reconciliation.
- `storage.js` — per-user file loading, atomic uploads, backups, import/export.
- `ui.js` / `style.css` — isolated browser and quick-move interface.
- `tests/migrations.test.mjs` — migration and safety regression tests.

## Tests

From this extension directory:

```powershell
npm test
```
