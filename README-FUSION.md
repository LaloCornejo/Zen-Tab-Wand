# Zen Tidy Wand Fusion (Cosine)

Wand skeleton + Tidy donor DNA + ATG dependency. Version 1.1.0-fusion.

## Base / donor

- Base: Wand (`flantig/Zen-Tab-Wand`) @ `09d7baa` — entry `auto-organize.uc.mjs`,
  rules-first Pass 1 + Local (zao-embedding) / Ollama Pass 2, preview modal, Wand prefs.
- Donor: Tidy (`Vertex-Mods/Zen-Tidy-Tabs`) @ `b9214f7` (`tidy-tabs.uc.js`, 1883 lines).
- Dependency (not vendored): `Vertex-Mods/Advanced-Tab-Groups` via `theme.json` `modules`.
- Source of truth: `_fusion_work/wand-analysis.md`, `cosine-spec.md`, `tidy-extract.md`.

## What was merged

- `theme.json`: Wand skeleton kept (id `zen-tab-wand`, one script
  `auto-organize.uc.mjs` with 3 includes, `supportsUnload: false`,
  `style.chrome userChrome.css`, local `preferences.json`); added
  `"modules": ["Vertex-Mods/Advanced-Tab-Groups"]`; version `1.1.0-fusion`.
- `preferences.json`: full Wand file + Tidy `browser.ml.enable` checkbox
  (`force: true`, default `true`) at top of AI Sorting section + two
  pref-gated checkboxes: `extensions.zen-auto-organize.tidy-animations`
  (default true), `extensions.zen-auto-organize.tidy-atg-colors` (default true).
- `modules/config.mjs`: added `TIDY_LOW 0.45`, `TIDY_HIGH 0.65`,
  `TIDY_MIN_TABS_FOR_SORT 6` beside `AI_EXISTING_GROUP_THRESHOLD`
  (`// TIDY_FUSION`); Wand keys untouched. Added `TIDY_ANIMATIONS_PREF` /
  `TIDY_ATG_COLORS_PREF` pref-name constants.
- `modules/groups.mjs` `applyGroupColor`: `// TIDY_FUSION ATG hook` at top —
  when `tidy-atg-colors` pref is true and `groupEl._useFaviconColor` is a
  function, call it in try/catch then return; else Wand logic unchanged.
- `modules/browser-ui.mjs`: kept `BUTTON_ID tab-wand-button` / `COMMAND_ID`
  unchanged; added `// TIDY_FUSION` brush-sweep trigger in the command listener,
  `tidyStartWaveAnimation` (amp 3 / freq 8 / seg 50), `tidyStartFailureAnimation`
  (amp 8 / freq 20 / seg 100, 3x400ms), `tidyCleanupAnimation`,
  `tidyUpdateButtonVisibility` MIN_TABS gating (show when groups exist + any
  ungrouped tab, else require >= 6 ungrouped). All guarded by the
  `tidy-animations` pref (false = pure Wand behavior).
- `userChrome.css`: appended `/* TIDY_FUSION */` block — brush-sweep +
  loading-pulse-tab keyframes, `.tab-is-sorting`, separator SVG rules, dual
  `#sort-button, #tab-wand-button` hover/visibility logic so both selectors work.
- NOT shipped: `tidy-tabs.uc.js` as a runnable script (single `.uc.mjs` entry only).
- NOT changed: Wand pref keys, button/command IDs, rules/Ollama/preview-modal logic.

Every graft is pref-gated, so disabling both `tidy-*` prefs restores stock Wand.

## Cosine sideload steps

1. Install Sine v2 Cosine build, restart Zen.
2. Sine settings → test-mods box → type `<owner>/zen-tidy-wand-fusion`.
3. Enable mod, restart if prompted (`supportsUnload: false`).
4. Confirm ATG auto-installed (group headers, `browser.tabs.groups.*` prefs).
5. After script edits: `about:support` → Clear Startup Cache → restart.

## Test checklist

- [ ] Wand icon appears in workspace separator.
- [ ] One `@`-domain rule → click wand → tabs group correctly.
- [ ] Engine Local → first click works (`browser.ml.enable` true in `about:config`).
- [ ] Separator wave + button brush animation play on click (disable via
      `tidy-animations=false` → no animations).
- [ ] New AI groups pick up favicon color when ATG present (disable via
      `tidy-atg-colors=false` → Wand palette colors).
- [ ] Button hides when < 6 ungrouped tabs and no groups exist.
- [ ] Disable mod → clean state after restart; Browser Console
      (`Ctrl+Shift+J`, `[ZenTabWand]`) shows no errors.
- [ ] `node --check auto-organize.uc.mjs` passes; both JSONs parse.
