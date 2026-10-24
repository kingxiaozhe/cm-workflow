# Third-party notices

CM Workflow is MIT licensed. The following bundled materials retain their own
attribution and license status.

## Neat-freak read-only closeout principles

- Source: https://github.com/KKKKhazix/khazix-skills
- Fixed commit: `322346ded8129436b3f64707789a73e732ae24d9`, neat-freak 3.0.0
- Copyright: © 2026 数字生命卡兹克
- License: MIT; full upstream text is retained in `skills/cm-ai/references/knowledge-closeout.md`.
- Adaptation: only bounded, read-only evidence reconciliation and reporting principles.
  No upstream scripts, memory maintenance, cleanup, or additional authority is bundled.

## Darwin Skill

- Source: https://github.com/alchaincyf/darwin-skill
- Upstream author: 花叔 Huashu (`alchaincyf`)
- License declared by upstream: MIT
- Bundled path: `skills/darwin-skill/`

The upstream repository did not contain a standalone `LICENSE` file when this
copy was imported. Its README explicitly declares “MIT” in the license section
and “MIT License © 花叔 Huashu”. The local `NOTICE.md` records the imported
files and portability changes. The repository-level MIT license supplies the
full license text; this notice preserves the upstream attribution.

## Matt Pocock skills (optional, not bundled)

- Source: https://github.com/mattpocock/skills
- Fixed commit: `5beb35b040e3de97e54fa9e386d7e42d15c295c2`
- Copyright: © 2026 Matt Pocock
- License declared by upstream: MIT (`LICENSE` at the repository root)
- Not bundled: `scripts/cm-matt-skills.mjs` contains only skill names, paths and
  SHA-256 checksums. When the user runs its `install` command, it fetches the
  pinned files from upstream and copies the upstream `LICENSE` into each
  installed skill directory.

## Kenney pixel assets

The following source sheets and the generated `atlas-preview.png` are derived
from Kenney assets released under Creative Commons CC0 1.0:

- `roguelikeIndoor_transparent.png` — [Roguelike Indoors](https://kenney.nl/assets/roguelike-indoors)
- `roguelikeCity_tilemap.png` — [Roguelike Modern City](https://kenney.nl/assets/roguelike-modern-city)
- `roguelikeChar_transparent.png` — [Roguelike Characters](https://kenney.nl/assets/roguelike-characters)

License: [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/).
Attribution is not required by CC0, but is retained here for provenance.
