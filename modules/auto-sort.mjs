// Zen Tab Wand — auto-arrange tabs as they open and as they navigate.
//
// Problem this solves: opening a link from inside a page makes Zen attach the
// new tab to its opener's tab-group, and navigating an already-grouped tab to
// an unrelated page leaves it sitting in the old group. Both cases are only
// repaired by the next wand click. This module runs the deterministic rule
// matcher on every tab-open and URL change:
//
//   - rule match found        → move into that group (create it if needed)
//   - no match, inherited one → eject to the top of the workspace
//   - no match, never grouped → leave it alone
//
// Only the active workspace is touched (the workspace container anchor used by
// applyPass1 is the active one); tabs in other workspaces wait for the next
// tidy click. Two independent prefs gate the two triggers.
//
// Guards that matter:
//   - burst detection: session restore / "open all in tabs" must not trigger
//     dozens of async move passes while the tab list is still being built
//   - tidy in flight: never race the full pipeline
//   - non-http URLs: about:newtab, about:preferences, chrome:// stay untouched
//   - URL claim: each tab records the last URL it was arranged for, so a
//     redirect chain or an SPA pushState doesn't re-run the pass needlessly

import { CONFIG, LOG } from "./config.mjs";
import { getTabTitle, getTabUrl, getHostname } from "./tabs.mjs";
import {
  loadRules,
  readSkipDomainsPref,
  isAutoSortOnOpenEnabled,
  isAutoSortOnNavigateEnabled,
} from "./rules.mjs";
import { findGroupForTab, matchesDomain, applyPass1 } from "./pass1.mjs";
import { moveTabsToTop } from "./groups.mjs";
import { isOrganizing } from "./click-handler.mjs";

const GROUP_SETTLE_MS = 200;      // let Zen finish attaching the inherited group
const READY_POLL_MS = 120;        // URL polling cadence
const READY_TIMEOUT_MS = 6000;    // give up if no real URL shows up in this window
const NAV_DEBOUNCE_MS = 600;      // collapse redirect chains / SPA route changes
const OPEN_BURST_WINDOW_MS = 1500;
const OPEN_BURST_LIMIT = 6;       // opens inside the window before we bail
const NAV_BURST_WINDOW_MS = 2000;
const NAV_BURST_LIMIT = 8;        // location changes inside the window (session restore)
const RULES_CACHE_MS = 5000;      // avoid re-reading rules for rapid tab events

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── Rules cache ────────────────────────────────────────────────────────────
// loadRules() may hit rules.json with a cache-busting query, so a per-event
// fetch is wasteful when the user opens or navigates several tabs in a row.
let rulesCache = { ts: 0, rules: null };
const getRules = async () => {
  const now = Date.now();
  if (rulesCache.rules && now - rulesCache.ts < RULES_CACHE_MS) return rulesCache.rules;
  const rules = await loadRules();
  rulesCache = { ts: now, rules };
  return rules;
};

// ─── Burst detection ────────────────────────────────────────────────────────
// Bulk activity (session restore, "open all in tabs", mass reload) is not
// user intent to arrange. A small sliding-window counter per event type.
const makeBurstTracker = (windowMs, limit) => {
  let hits = [];
  return () => {
    const now = Date.now();
    hits = hits.filter((t) => now - t < windowMs);
    hits.push(now);
    return hits.length > limit;
  };
};
const isBurstOpen = makeBurstTracker(OPEN_BURST_WINDOW_MS, OPEN_BURST_LIMIT);
const isBurstNav = makeBurstTracker(NAV_BURST_WINDOW_MS, NAV_BURST_LIMIT);

// ─── Tab helpers ────────────────────────────────────────────────────────────

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

// Tabs we never touch, regardless of trigger.
const isEligibleTab = (tab) => {
  if (!tab?.isConnected) return false;
  if (tab.pinned) return false;
  if (tab.hasAttribute("zen-empty-tab")) return false;
  if (tab.hasAttribute("zen-glance-tab")) return false;
  if (tab.hasAttribute("zen-essential")) return false;
  return true;
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

/**
 * Evaluate one tab and apply the decision. Shared by the open and navigation
 * triggers.
 *
 * @param {object} tab
 * @param {string} workspaceId
 * @param {object} [opts]
 * @param {boolean} [opts.waitForUrl=false] — poll until a page URL exists
 *   (tab-open path); navigation already has one
 * @param {string} [opts.reason="open"] — log label only
 */
const maybeArrange = async (tab, workspaceId, { waitForUrl = false, reason = "open" } = {}) => {
  if (!tab?.isConnected) return;

  if (waitForUrl) {
    const ready = await waitForTabUrl(tab);
    if (!ready || !tab.isConnected) return;
    // Zen attaches inherited groups asynchronously; give it one beat so we
    // read the real parent group instead of null.
    await sleep(GROUP_SETTLE_MS);
    if (!tab.isConnected) return;
  }

  try {
    if (!isEligibleTab(tab)) return;

    // Only act on tabs in the active workspace — applyPass1 anchors new
    // groups to the active workspace container. An absent attribute means
    // "created here", so it's allowed; a different value means skip.
    const tabWorkspace = tab.getAttribute("zen-workspace-id");
    if (tabWorkspace && tabWorkspace !== workspaceId) return;

    if (isOrganizing()) {
      console.debug(`${LOG} auto-arrange(${reason}): tidy in flight — skipping "${getTabTitle(tab)}"`);
      return;
    }

    const url = getTabUrl(tab);
    if (!isHttpUrl(url)) return;
    // Claim the URL before any await so a redirect chain or a duplicate event
    // collapses into a single pass. Cleared again below if it moved meanwhile.
    if (tab._zaoArrangedUrl === url) return;
    tab._zaoArrangedUrl = url;

    const rules = await getRules();
    if (!tab.isConnected) return;

    const info = tabInfoFor(tab);
    if (info.url !== url) {
      // Navigated again while rules loaded — let the next debounced pass own it.
      if (tab._zaoArrangedUrl === url) tab._zaoArrangedUrl = null;
      return;
    }

    const decision = decideArrangement(info, rules, readSkipDomainsPref());

    if (decision.action === "move") {
      const result = applyPass1(new Map([[decision.group, [info]]]), workspaceId, rules);
      const moved = result.movedToExisting + result.movedToNew;
      if (moved > 0) {
        console.log(
          `${LOG} auto-arrange(${reason}): "${info.title}" → "${decision.group}"` +
          (info.currentGroup ? ` (was in "${info.currentGroup}")` : "")
        );
      } else if (result.errors.length > 0) {
        console.warn(`${LOG} auto-arrange(${reason}): could not place "${info.title}"`, result.errors);
      }
      return;
    }

    if (decision.action === "eject") {
      const moved = moveTabsToTop([tab], workspaceId);
      if (moved > 0) {
        const suffix = decision.reason === "skip-domain"
          ? "skip-domain tab"
          : `group "${info.currentGroup}"`;
        console.log(`${LOG} auto-arrange(${reason}): ejected "${info.title}" from ${suffix}`);
      }
    }
  } catch (e) {
    console.error(`${LOG} auto-arrange(${reason}) failed for "${getTabTitle(tab)}":`, e);
  }
};

// ─── Hooks ──────────────────────────────────────────────────────────────────

const findTabForBrowser = (browser) => {
  try {
    if (typeof gBrowser?.getTabForBrowser === "function") return gBrowser.getTabForBrowser(browser);
    for (const tab of gBrowser?.tabs || []) {
      if (tab.linkedBrowser === browser) return tab;
    }
  } catch {}
  return null;
};

// Tabs-progress listener: fires for every top-level navigation in this window,
// including background tabs, redirects, and SPA pushState changes. This is the
// reliable URL signal — tab elements have no URL attribute to observe.
const navListener = {
  onLocationChange(browser, webProgress, _request, _location) {
    try {
      if (!isAutoSortOnNavigateEnabled()) return;
      if (!webProgress?.isTopLevel) return;   // ignore iframes
      const tab = findTabForBrowser(browser);
      if (!tab?.isConnected) return;
      if (isBurstNav()) {
        tab._zaoArrangedUrl = getTabUrl(tab);
        return;
      }
      // Debounce so a redirect chain (auth hops, shorteners) and SPA route
      // churn settle before we move anything.
      if (tab._zaoNavTimer) clearTimeout(tab._zaoNavTimer);
      tab._zaoNavTimer = setTimeout(() => {
        tab._zaoNavTimer = null;
        if (!tab.isConnected) return;
        const workspaceId = window.gZenWorkspaces?.activeWorkspace;
        if (!workspaceId) return;
        void maybeArrange(tab, workspaceId, { reason: "nav" });
      }, NAV_DEBOUNCE_MS);
    } catch (e) {
      console.error(`${LOG} auto-arrange nav hook error:`, e);
    }
  },
};

export const setupAutoSortOnOpen = () => {
  if (typeof gBrowser === "undefined" || !gBrowser.tabContainer) return;

  // ── tab open ──────────────────────────────────────────────────────────────
  const container = gBrowser.tabContainer;
  if (!container._zaoAutoSortHook) {
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
          tab._zaoArrangedUrl = getTabUrl(tab);
          return;
        }

        if (isOrganizing()) return;
        void maybeArrange(tab, workspaceId, { waitForUrl: true, reason: "open" });
      } catch (e) {
        console.error(`${LOG} auto-arrange hook error:`, e);
      }
    };
    container.addEventListener("TabOpen", handler);
    container._zaoAutoSortHook = handler;
  }

  // ── navigation ────────────────────────────────────────────────────────────
  if (!gBrowser._zaoAutoSortNavListener) {
    try {
      gBrowser.addTabsProgressListener(navListener);
      gBrowser._zaoAutoSortNavListener = navListener;
    } catch (e) {
      console.warn(`${LOG} auto-arrange: navigation hook unavailable:`, e);
    }
  }

  console.log(`${LOG} auto-arrange on tab open + navigation installed`);
};

export const teardownAutoSortOnOpen = () => {
  if (typeof gBrowser === "undefined") return;
  const container = gBrowser.tabContainer;
  if (container?._zaoAutoSortHook) {
    try { container.removeEventListener("TabOpen", container._zaoAutoSortHook); } catch {}
    container._zaoAutoSortHook = null;
  }
  if (gBrowser._zaoAutoSortNavListener) {
    try { gBrowser.removeTabsProgressListener(gBrowser._zaoAutoSortNavListener); } catch {}
    gBrowser._zaoAutoSortNavListener = null;
  }
};

// Test seam — lets a node harness exercise the pure decision without a browser.
export const __testing = { isHttpUrl, tabInfoFor, isEligibleTab };
