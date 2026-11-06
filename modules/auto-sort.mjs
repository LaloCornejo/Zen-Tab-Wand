// Zen Tab Wand — auto-arrange newly opened tabs.
//
// Problem this solves: opening a link from inside a page makes Zen attach the
// new tab to its opener's tab-group. If the new page is unrelated to that
// group, it quietly stays there until the next wand click. This module runs
// the deterministic rule matcher on every newly opened tab and repairs that:
//
//   - rule match found        → move into that group (create it if needed)
//   - no match, inherited one → eject to the top of the workspace
//   - no match, never grouped → leave it alone
//
// Only the active workspace is touched (the workspace container anchor used by
// applyPass1 is the active one); tabs opened into other workspaces wait for
// the next tidy click. Everything is gated by the auto-sort-on-open pref.
//
// Guards that matter:
//   - burst detection: session restore / "open all in tabs" must not trigger
//     dozens of async move passes while the tab list is still being built
//   - tidy in flight: never race the full pipeline
//   - non-http URLs: about:newtab, about:preferences, chrome:// stay untouched
//   - each tab is processed once (_zaoAutoArranged expando)

import { CONFIG, LOG } from "./config.mjs";
import { getTabTitle, getTabUrl, getHostname } from "./tabs.mjs";
import { loadRules, readSkipDomainsPref, isAutoSortOnOpenEnabled } from "./rules.mjs";
import { findGroupForTab, matchesDomain, applyPass1 } from "./pass1.mjs";
import { moveTabsToTop } from "./groups.mjs";
import { isOrganizing } from "./click-handler.mjs";

const GROUP_SETTLE_MS = 200;      // let Zen finish attaching the inherited group
const READY_POLL_MS = 120;        // URL polling cadence
const READY_TIMEOUT_MS = 6000;    // give up if no real URL shows up in this window
const BURST_WINDOW_MS = 1500;     // bulk-open detection window
const BURST_LIMIT = 6;            // opens inside the window before we bail
const RULES_CACHE_MS = 5000;      // avoid re-reading rules for rapid tab opens

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── Rules cache ────────────────────────────────────────────────────────────
// loadRules() may hit rules.json with a cache-busting query, so a per-open
// fetch is wasteful when the user opens several tabs in a row.
let rulesCache = { ts: 0, rules: null };
const getRules = async () => {
  const now = Date.now();
  if (rulesCache.rules && now - rulesCache.ts < RULES_CACHE_MS) return rulesCache.rules;
  const rules = await loadRules();
  rulesCache = { ts: now, rules };
  return rules;
};

// ─── Burst detection ────────────────────────────────────────────────────────
let recentOpens = [];
const isBurstOpen = () => {
  const now = Date.now();
  recentOpens = recentOpens.filter((t) => now - t < BURST_WINDOW_MS);
  recentOpens.push(now);
  return recentOpens.length > BURST_LIMIT;
};

// ─── Tab readiness ──────────────────────────────────────────────────────────

const isHttpUrl = (url) => /^https?:\/\//i.test(String(url || ""));

// Resolve once the tab has a real page URL, or false when it never gets one
// within the deadline. New tabs start on about:blank while the load kicks
// off, and Ctrl+T followed by typing a URL can take a few seconds — polling
// covers both without leaking listeners on tabs that never navigate.
const waitForTabUrl = async (tab) => {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!tab?.isConnected) return false;
    if (isHttpUrl(getTabUrl(tab))) return true;
    await sleep(READY_POLL_MS);
  }
  return tab?.isConnected ? isHttpUrl(getTabUrl(tab)) : false;
};

const tabInfoFor = (tab) => {
  const url = getTabUrl(tab);
  const groupEl = tab.closest("tab-group");
  return {
    id: -1,
    title: getTabTitle(tab) || "(untitled)",
    url,
    hostname: getHostname(url),
    currentGroup: groupEl?.getAttribute("label") || null,
    _tab: tab,
  };
};

// ─── Pure decision ──────────────────────────────────────────────────────────
// Everything the arrange pass needs to know, without touching the DOM. Kept
// separate so it can be exercised in a plain node harness.
//
// Returns { action, group?, reason } where action is:
//   "move" — put the tab in `group` (rule match, different/absent group)
//   "eject" — pull the tab out of its group to the workspace top
//   "none" — leave the tab exactly where it is
export const decideArrangement = (info, rules, skipPatterns = []) => {
  const isSkipped = (skipPatterns || []).some((p) => matchesDomain(info.hostname, p));
  if (isSkipped) {
    return info.currentGroup
      ? { action: "eject", reason: "skip-domain" }
      : { action: "none", reason: "skip-domain" };
  }

  const target = findGroupForTab(info, rules);
  if (target) {
    if (info.currentGroup === target) {
      return { action: "none", group: target, reason: "already-placed" };
    }
    return { action: "move", group: target, reason: info.currentGroup ? "wrong-group" : "ungrouped-match" };
  }

  // No rule matched. Only repair inherited placement — an ungrouped unmatched
  // tab is none of our business.
  if (info.currentGroup) {
    return { action: "eject", reason: "inherited-unmatched" };
  }
  return { action: "none", reason: "unmatched-ungrouped" };
};

// ─── The arrange pass ───────────────────────────────────────────────────────

const arrangeTab = async (tab, workspaceId) => {
  if (tab._zaoAutoArranged) return;
  const ready = await waitForTabUrl(tab);
  if (!ready || !tab.isConnected) return;
  if (tab._zaoAutoArranged) return;
  tab._zaoAutoArranged = true;

  try {
    // Skip tabs that are not eligible for tidying at all.
    if (tab.pinned) return;
    if (tab.hasAttribute("zen-empty-tab")) return;
    if (tab.hasAttribute("zen-glance-tab")) return;
    if (tab.hasAttribute("zen-essential")) return;
    // Only act on tabs in the active workspace — applyPass1 anchors new
    // groups to the active workspace container. An absent attribute means
    // "created here", so it's allowed; a different value means skip.
    const tabWorkspace = tab.getAttribute("zen-workspace-id");
    if (tabWorkspace && tabWorkspace !== workspaceId) return;
    if (isOrganizing()) {
      console.debug(`${LOG} auto-arrange: tidy in flight — skipping "${getTabTitle(tab)}"`);
      return;
    }

    // Zen attaches inherited groups asynchronously; give it one beat so we
    // read the real parent group instead of null.
    await sleep(GROUP_SETTLE_MS);
    if (!tab.isConnected) return;

    const rules = await getRules();
    const info = tabInfoFor(tab);
    if (!info.url || !isHttpUrl(info.url)) return;

    const decision = decideArrangement(info, rules, readSkipDomainsPref());

    if (decision.action === "move") {
      const result = applyPass1(new Map([[decision.group, [info]]]), workspaceId, rules);
      const moved = result.movedToExisting + result.movedToNew;
      if (moved > 0) {
        console.log(
          `${LOG} auto-arrange: "${info.title}" → "${decision.group}"` +
          (info.currentGroup ? ` (was in "${info.currentGroup}")` : "")
        );
      } else if (result.errors.length > 0) {
        console.warn(`${LOG} auto-arrange: could not place "${info.title}"`, result.errors);
      }
      return;
    }

    if (decision.action === "eject") {
      const moved = moveTabsToTop([tab], workspaceId);
      if (moved > 0) {
        const suffix = decision.reason === "skip-domain"
          ? "skip-domain tab"
          : `inherited group "${info.currentGroup}"`;
        console.log(`${LOG} auto-arrange: ejected "${info.title}" from ${suffix}`);
      }
    }
  } catch (e) {
    console.error(`${LOG} auto-arrange failed for "${getTabTitle(tab)}":`, e);
  }
};

// ─── Hook ───────────────────────────────────────────────────────────────────

export const setupAutoSortOnOpen = () => {
  if (typeof gBrowser === "undefined" || !gBrowser.tabContainer) return;
  const container = gBrowser.tabContainer;
  if (container._zaoAutoSortHook) return;

  const handler = (event) => {
    const tab = event.target;
    if (!tab?.isConnected) return;
    try {
      if (!isAutoSortOnOpenEnabled()) return;
      const workspaceId = window.gZenWorkspaces?.activeWorkspace;
      if (!workspaceId) return;

      // Bulk opens (session restore, "open all in tabs") are not user intent
      // to arrange; let the normal tidy click handle them later.
      if (isBurstOpen()) {
        tab._zaoAutoArranged = true;
        return;
      }

      if (isOrganizing()) return;
      void arrangeTab(tab, workspaceId);
    } catch (e) {
      console.error(`${LOG} auto-arrange hook error:`, e);
    }
  };

  container.addEventListener("TabOpen", handler);
  container._zaoAutoSortHook = handler;
  console.log(`${LOG} auto-arrange on tab open installed`);
};

export const teardownAutoSortOnOpen = () => {
  if (typeof gBrowser === "undefined" || !gBrowser.tabContainer) return;
  const container = gBrowser.tabContainer;
  if (!container._zaoAutoSortHook) return;
  try { container.removeEventListener("TabOpen", container._zaoAutoSortHook); } catch {}
  container._zaoAutoSortHook = null;
};

// Test seam — lets a node harness exercise the pure decision without a browser.
export const __testing = { isHttpUrl, tabInfoFor };