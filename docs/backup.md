# Backup, restore, and upgrade

Persist the whole workspace directory (`/workspace` in Docker, `GOSSIP_BASE_DIR` otherwise). Files inside it are not interchangeable.

| Path | Back up | Restore | Upgrade |
|---|---|---|---|
| `data/gossip-state.json` (`GOSSIP_STATE_PATH`) | Yes. This is the board, comments, tellings, and spoken-event cursor. | Stop the process, replace the file, start again. | Keep the file. The process does not migrate by deleting it. |
| `prompt.md` | Yes, if you edited it. | Put the file back before start. | Left in place. A missing or empty file is seeded from `prompt.md.default`. |
| `prompt.md.default` | No. The image rewrites it on every start. | Do not restore it over a newer image copy. | Replaced from the image so the reference matches the release. |
| `gossip-types.json` (`GOSSIP_TYPES_PATH`) | Yes, once it has operator edits. | Put the file back before start. | A non-empty file is the live override and is not replaced. A missing or empty file is seeded once from the image catalog. |
| `logs/` | Optional. Exclude from shared backups, or encrypt them. `full` call logs contain prompts. | Restore only when you still want those diagnostics. | Safe to delete. New logs are created as needed. |

## Before a refresh or an upgrade

1. Stop extra writers. Leave at most one `serve` for that workspace.
2. Copy the workspace, or at least `data/gossip-state.json`, `prompt.md`, and `gossip-types.json`, to a versioned location named with the date and the image tag you are running.
3. Then run `refresh`, or pull the new image and start it.

`refresh` replaces the active board. The copy from step 2 is the way back.

## Corrupt state

If startup exits non-zero because the state file is not valid JSON, the process does not rewrite that file. Stop it, replace the file with the backup or repair the JSON in an external editor, then start again. Do not delete the file to get past the error if those bytes are still needed. A missing file is first-run behavior and comes up as an empty board.

## Image tags

Run a version tag such as `ghcr.io/<owner>/subwave-gossip-companion:1.2.3`, not `latest` and not the moving `main` image, for anything you need to roll back. Publish notes for a release should say whether the workspace files above must be restored, edited, or left alone. The image does not apply a separate migration tool; the backup from the previous tag is the rollback.
