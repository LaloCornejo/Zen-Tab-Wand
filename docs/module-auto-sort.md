# `modules/auto-sort.mjs` — arrange tabs as they open and navigate

Watches `TabOpen` and top-level navigation, then runs the deterministic rule matcher on the tab. Exists because Zen attaches a tab opened from inside a page to its **opener's group**, and a tab that navigates to a new page keeps its old group — so an unrelated page silently inherits "Dev" merely because it started as a GitHub tab.

## Triggers

| Trigger | Detection | Pref |
|---|---|---|
| Tab open | `TabOpen` on `gBrowser.tabContainer` | `auto-sort-on-open` |
| URL change | `gBrowser.addTabsProgressListener` → `onLocationChange` (top-level only) | `auto-sort-on-navigate` |

`onLocationChange` is used instead of DOM observation because tab elements expose no URL attribute, and this listener also covers background tabs and SPA `pushState` route changes. Navigation events are debounced 600 ms so redirect chains and route churn settle before anything moves.

## Behavior

| Situation | Action |
|---|---|
| Rule matches, tab is elsewhere / ungrouped | `applyPass1` moves it into the rule's group (creating it if needed) |
| No rule matches, tab inherited a group | Eject to the top of the workspace, ungrouped |
| No rule matches, tab was never grouped | Leave alone |
| Hostname is on the skip-domains list | Eject if grouped; otherwise leave alone (skip list is authoritative) |

Both `move` and `eject` decisions come from the pure `decideArrangement(info, rules, skipPatterns)` — the same first-match-wins matcher and match-mode pref Pass 1 uses, so auto-arrange behavior can never drift from a full tidy click.

## Guards

- **URL claim** — each tab records `_zaoArrangedUrl`, so a redirect chain or duplicate event collapses into one pass instead of re-arranging repeatedly.
- **Burst detection** — more than 6 opens in 1.5 s, or more than 8 location changes in 2 s (session restore, "open all in tabs"), are treated as bulk activity and skipped.
- **Tidy in flight** — `isOrganizing()` from `click-handler.mjs` short-circuits, so an auto-arrange never races the full pipeline.
- **URL readiness** — the open path polls up to 6 s for a real `http(s)` URL; empty new tabs (`about:newtab`), settings pages, and `chrome://` URLs are ignored. The navigation path already has a URL.
- **Group settle** — the open path waits 200 ms after the URL appears so Zen has finished attaching the inherited group before it is read.
- **Eligibility** — pinned, essential, glance, and empty tabs are skipped; only the active workspace is touched (the group anchor used by `applyPass1` is the active workspace container).
- **Rules cache** — 5 s TTL, so rapid tab events don't re-read `rules.json` each time.

## Exports

| Name | Notes |
|---|---|
| `setupAutoSortOnOpen()` | Installs both hooks (idempotent via DOM expandos). |
| `teardownAutoSortOnOpen()` | Removes both hooks on window unload. |
| `decideArrangement(info, rules, skipPatterns)` | Pure decision: `{ action: "move" \| "eject" \| "none", group?, reason }`. |

## Prefs

- `extensions.zen-auto-organize.auto-sort-on-open` (default `true`) — **Auto-arrange new tabs**.
- `extensions.zen-auto-organize.auto-sort-on-navigate` (default `true`) — **Auto-arrange on navigation**.

Turning both off restores the previous behavior: tabs stay wherever Zen puts them until the next tidy click.

