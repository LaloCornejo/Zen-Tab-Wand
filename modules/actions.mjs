// Zen Tab Wand — user-invoked corrective actions: undo, duplicates, dusty.
//
// Undo snapshots group membership BEFORE a tidy run and restores it on
// demand (membership only — tab order within the window is not restored).
// Snapshots are single-slot (last run wins) and in-memory only.

import { CONFIG, LOG } from "./config.mjs";
import {
  findExistingGroup,
  findSafeInsertAnchor,
  moveTabsToTop,
  syncAllGroupColors,
} from "./groups.mjs";
import { loadRules, writeRulesPref, getDustyDays } from "./rules.mjs";
import { getEligibleTabs } from "./tabs.mjs";
import { showToast } from "./ui-toast.mjs";

let lastSnapshot = null; // [{ tab, url, title, group, index }] | null

export const hasUndoSnapshot = () =>
  Array.isArray(lastSnapshot) && lastSnapshot.some((s) => s.tab?.isConnected);

export const takeSnapshot = (tabs) => {
  lastSnapshot = (tabs || []).map((t, i) => ({
    tab: t._tab,
    url: t.url,
    title: t.title,
    group: t.currentGroup || null,
    index: typeof t.id === "number" ? t.id : i,
  }));
};

export const undoLastTidy = async (workspaceId) => {
  if (!hasUndoSnapshot()) {
    showToast("Nothing to undo");
    return 0;
  }
  const rules = await loadRules();
  let restored = 0;
  for (const s of lastSnapshot) {
    const tab = s.tab;
    if (!tab?.isConnected) continue;
    try {
      if (s.group) {
        let groupEl = findExistingGroup(s.group, workspaceId);
        if (!groupEl?.isConnected) {
          groupEl = gBrowser.addTabGroup([tab], {
            label: s.group,
            insertBefore: findSafeInsertAnchor(),
          });
        } else if (tab.closest("tab-group") !== groupEl) {
          gBrowser.moveTabToExistingGroup(tab, groupEl);
        }
        restored++;
      } else if (tab.closest("tab-group")) {
        moveTabsToTop([tab], workspaceId);
        restored++;
      }
    } catch (e) {
      console.error(`${LOG} undo failed for "${s.title}":`, e);
    }
  }
  lastSnapshot = null;
  try {
    window.gZenWorkspaces?.updateTabsContainers?.();
  } catch {}
  try {
    if (workspaceId) syncAllGroupColors(workspaceId, rules);
  } catch {}
  showToast(`Undid last tidy (${restored} tab(s) restored)`);
  console.log(`${LOG} undo: restored ${restored} tab(s)`);
  return restored;
};

// ─── Duplicate tabs ─────────────────────────────────────────────────────────

const normalizeDupeUrl = (url) => {
  try {
    const u = new URL(url);
    u.hash = "";
    u.search = "";
    const s = u.toString();
    return s.endsWith("/") ? s.slice(0, -1) : s;
  } catch {
    return (url || "").split("#")[0];
  }
};

export const findDuplicateGroups = (tabs) => {
  const byUrl = new Map();
  for (const t of tabs || []) {
    const u = t.url || "";
    if (!u.startsWith("http://") && !u.startsWith("https://")) continue;
    const key = normalizeDupeUrl(u);
    if (!byUrl.has(key)) byUrl.set(key, []);
    byUrl.get(key).push(t);
  }
  return [...byUrl.values()].filter((g) => g.length > 1);
};

export const countDuplicateTabs = () => {
  try {
    return findDuplicateGroups(getEligibleTabs().tabs).reduce((n, g) => n + g.length - 1, 0);
  } catch {
    return 0;
  }
};

export const closeDuplicateTabs = () => {
  let groups = [];
  try {
    groups = findDuplicateGroups(getEligibleTabs().tabs);
  } catch (e) {
    console.error(`${LOG} duplicate scan failed:`, e);
    return 0;
  }
  let closed = 0;
  for (const g of groups) {
    // Keep the grouped copy when one exists, else the earliest tab.
    const sorted = [...g].sort(
      (a, b) =>
        (b._tab?.closest("tab-group") ? 1 : 0) - (a._tab?.closest("tab-group") ? 1 : 0) ||
        (a.id ?? 0) - (b.id ?? 0)
    );
    for (const t of sorted.slice(1)) {
      try {
        if (t._tab?.isConnected) {
          gBrowser.removeTab(t._tab);
          closed++;
        }
      } catch (e) {
        console.error(`${LOG} failed to close duplicate "${t.title}":`, e);
      }
    }
  }
  showToast(closed > 0 ? `Closed ${closed} duplicate tab(s)` : "No duplicate tabs");
  console.log(`${LOG} duplicates: closed ${closed} tab(s) across ${groups.length} group(s)`);
  return closed;
};

// ─── Dusty parking ──────────────────────────────────────────────────────────
// Tabs the user hasn't visited in getDustyDays() days collect into the Dusty
// group. Only tabs with a real lastAccessed timestamp qualify — never-visited
// background tabs are left for the normal flow (better under-parked than
// wrong-parked). The Dusty rule self-registers so stale-group sweeps keep it.

export const parkDustyTabs = async (tabs, workspaceId, rules) => {
  const days = getDustyDays();
  if (!days || days <= 0) return { parked: 0, remaining: tabs };
  const cutoff = Date.now() - days * 86400000;
  const stale = [];
  const remaining = [];
  for (const t of tabs) {
    const la = t._tab?.lastAccessed;
    if (typeof la === "number" && la > 0 && Date.now() - la > cutoff) stale.push(t);
    else remaining.push(t);
  }
  if (stale.length === 0) return { parked: 0, remaining };
  if (!rules.some((r) => r.name === CONFIG.DUSTY_GROUP_NAME)) {
    rules.push({ name: CONFIG.DUSTY_GROUP_NAME, domains: [] });
    try {
      writeRulesPref(rules);
    } catch {}
  }
  try {
    let groupEl = findExistingGroup(CONFIG.DUSTY_GROUP_NAME, workspaceId);
    const liveTabs = stale.map((t) => t._tab).filter((t) => t?.isConnected);
    if (liveTabs.length === 0) return { parked: 0, remaining: tabs };
    if (!groupEl?.isConnected) {
      groupEl = gBrowser.addTabGroup(liveTabs, {
        label: CONFIG.DUSTY_GROUP_NAME,
        insertBefore: findSafeInsertAnchor(),
      });
    } else {
      for (const tab of liveTabs) {
        if (tab.closest("tab-group") !== groupEl) gBrowser.moveTabToExistingGroup(tab, groupEl);
      }
    }
  } catch (e) {
    console.error(`${LOG} Dusty parking failed:`, e);
    return { parked: 0, remaining: tabs };
  }
  console.log(`${LOG} Dusty: parked ${stale.length} tab(s) unvisited for ${days}+ day(s)`);
  return { parked: stale.length, remaining };
};
