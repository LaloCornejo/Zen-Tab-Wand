# `modules/browser-ui.mjs` — Toolbar button + command + workspace hooks

Everything that puts visible chrome into `browser.xhtml`. Loaded only in the browser context.

## Exports

| Name | Notes |
|---|---|
| `addButtonToAllSeparators()` | Idempotent: skips separators that already have our button. |
| `setupCommand()` | Registers `cmd_zenAutoOrganize` in `commandset#zenCommandSet` and wires its `command` event to `handleOrganizeClick`. The listener also starts the separator wave (`tidy-anim.mjs`) when animations are enabled. |
| `setupWorkspaceHooks()` | Monkey-patches `gZenWorkspaces.onTabBrowserInserted` and `updateTabsContainers` so the button is re-injected when workspaces switch. |

## Separator animations (`modules/tidy-anim.mjs`)

Wave sweep, failure pulse, and wand-button visibility gating live in their own module (split out so the click pipeline can drive them without an import cycle — this file already imports `click-handler.mjs` for the command listener). Lifecycle: the command listener starts the wave, `handleOrganizeClick` stops it in a `finally` when the run ends, and a Pass 2 exception hands the separator to the failure pulse (which self-resets after its pulses). All entry points no-op when the `tidy-animations` pref is false.

## Button placement

The button is inserted into every `.pinned-tabs-container-separator` element (one per workspace). It's placed BEFORE the native clear button if that exists, otherwise appended. This matches what Tidy Tabs does so the layout stays consistent.

The XUL is a `<toolbarbutton id="tab-wand-button" command="cmd_zenAutoOrganize">` with an inline Lucide wand-sparkles SVG icon embedded inside an `<hbox class="toolbarbutton-box">`. CSS in `userChrome.css` handles the wiggle animation on the `.zao-wiggling` class and the AI-thinking pulse on the `.zao-thinking` class (both added/removed by `click-handler.mjs`).

## Why workspace hooks

Each workspace has its own separator element. When you switch workspaces, Zen recreates the separator. Our button on the previous separator is still there but invisible; the new separator has no button. We invalidate `domCache.separators` and re-run `addButtonToAllSeparators()` to put a button on the new one.

## The command pattern

Standard Firefox/Zen wires menu items and toolbar buttons via `command` IDs in a central commandset. The element that triggers the action sets `command="cmd_zenAutoOrganize"`, and a single listener on the commandset dispatches based on `event.target.id`. We use that pattern for consistency — anything else that wants to trigger a tidy can just reference the same command.
