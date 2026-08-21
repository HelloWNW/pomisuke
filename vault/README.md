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
- **`auto-log/facts.md`** — bot-written, lower-trust, only active in **vault**
  prompt mode (see above). Whenever Pomisuke improvises a new fact about
  itself or its world mid-conversation, it gets appended here automatically
  as a dated entry. Recent entries are included in the prompt as loose
  context (so Pomisuke doesn't immediately contradict itself), but nothing
  here is treated as canon. Periodically review this
  file and, if something's worth keeping, move/rewrite it into a
  `world-setting/` note yourself and link it from `index.md`. Feel free to
  delete or edit entries here freely — it's a scratch log, not an archive.

## Editing

Edit notes here like any other Obsidian vault, then commit + push. The
running bot reads directly from GitHub (not from a local clone), so changes
take effect on its next read after the push lands on `main`.
