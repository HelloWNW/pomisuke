# Pomisuke Knowledge Vault

This folder is Pomisuke's world-setting/persona knowledge base. Open this whole
repo (or just this folder) in Obsidian to browse it as a normal vault — graph
view, backlinks, and `[[wikilinks]]` all work as usual.

This file is documentation only. The bot never reads `vault/README.md` — only
`world-setting/index.md` and the notes linked from it.

## How it works

- **`world-setting/`** — curated, human-edited canon. This becomes Pomisuke's
  system prompt only when the admin dashboard's (`/admin`) Prompt Mode is set
  to **vault** (in `normal` mode, the bot uses the static system prompt edited
  on that page instead). When vault mode is active, the bot starts at
  `world-setting/index.md` and follows its `[[wikilinks]]` **one level deep**
  — so a new note only affects the bot's behavior once you link it from
  `index.md`. No other note is auto-included, and there's no deeper traversal.
- **Auto-growing facts (vault mode only)** — a separate reviewer conversation
  (configurable model + prompt on `/admin`) reads each of Pomisuke's replies
  alongside the current `world-setting/vocabulary.md` and
  `world-setting/pomisuke-fact.md`, and appends any genuinely new,
  non-duplicate entries it finds straight into those two notes (`word =
  meaning` bullets in `vocabulary.md`, `key: info` bullets in
  `pomisuke-fact.md`) — both are ordinary linked `world-setting/` notes, read
  by the main chat like any other. There's a code-level dedup check on top of
  the reviewer's own judgment, so the same word/key won't be appended twice.
- **`auto-log/facts.md`** — legacy. The bot no longer writes here (superseded
  by the mechanism above); the file is left in place as a historical record
  of earlier entries. Safe to delete or archive manually if you don't need it.

## Editing

Edit notes here like any other Obsidian vault, then commit + push. The
running bot reads directly from GitHub (not from a local clone), so changes
take effect on its next read after the push lands on `main`.
