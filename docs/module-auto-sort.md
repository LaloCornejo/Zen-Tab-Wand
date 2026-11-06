# `modules/auto-sort.mjs` — arrange tabs as they open

Watches `TabOpen` and runs the deterministic rule matcher on each new tab. Exists because Zen attaches a tab opened from inside a page to its **opener's group** — so an unrelated page silently inherits "Dev" merely because the link came from a GitHub tab.

## Behavior

| Situation | Action |
|---|---|
| Rule matches, tab is elsewhere / ungrouped | `applyPass1` moves it into the rule's group (creating it if needed) |
| No rule matches, tab inherited a group | Eject to the top of the workspace, ungrouped |
| No rule matches, tab was never grouped | Leave alone |
| Hostname is on the skip-domains list | Eject if grouped; otherwise leave alone (skip list is authoritative) |

Both `move` and `eject` decisions come from the pure `decideArrangement(info, rules, skipPatterns)` — the same first-match-wins matcher and match-mode pref Pass 1 uses, so tab-open behavior can never drift from a full tidy click.

## Guards

- **Burst detection** — more than 6 tab opens within 1.5 s (session restore, "open all in tabs") marks those tabs as handled and skips arrangement; a later tidy click covers them.
- **Tidy in flight** — `isOrganizing()` from `click-handler.mjs` short-circuits, so an auto-arrange never races the full pipeline.
- **URL readiness** — polls up to 6 s for a real `http(s)` URL. Empty new tabs (`about:newtab`), settings pages, and `chrome://` URLs are ignored.
- **Group settle** — waits 200 ms after the URL appears so Zen has finished attaching the inherited group before it is read.
- **Eligibility** — pinned, essential, glide/glance, and empty tabs are skipped; only the active workspace is touched (the group anchor used by `applyPass1` is the active workspace container).
- **Once per tab** — the `_zaoAutoArranged` expando prevents double processing.
- **Rules cache** — 5 s TTL, so opening several tabs in a row doesn't re-read `rules.json` each time.

## Exports

| Name | Notes |
|---|---|
| `setupAutoSortOnOpen()` | Installs the `TabOpen` listener (idempotent via a DOM expando). |
| `teardownAutoSortOnOpen()` | Removes it on window unload. |
| `decideArrangement(info, rules, skipPatterns)` | Pure decision: `{ action: "move" \| "eject" \| "none", group?, reason }`. |

## Pref

`extensions.zen-auto-organize.auto-sort-on-open` (default `true`), exposed as **Auto-arrange new tabs** under Look & Feel. Turning it off restores the previous behavior (new tabs stay wherever Zen puts them until the next tidy click).
