// Zen Tab Wand — browser-context UI: tidy button, command, workspace hooks.

import { CONFIG, LOG } from "./config.mjs";
import { domCache, getEligibleTabs } from "./tabs.mjs";
import { handleOrganizeClick, isOrganizing } from "./click-handler.mjs";
import { getAutoTidyThreshold } from "./rules.mjs";
import {
  hasUndoSnapshot,
  undoLastTidy,
  countDuplicateTabs,
  closeDuplicateTabs,
} from "./actions.mjs";

// Lucide "wand-sparkles" — the magic wand with a sparkle around the tip.
// Inline SVG (not an icon-font / external file) so it inherits currentColor from
// the toolbar theme and animates cleanly with the .zao-wiggling class.
const WAND_ICON_SVG = `
  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
       fill="none" stroke="currentColor" stroke-width="2"
       stroke-linecap="round" stroke-linejoin="round">
    <path d="M15 4V2"/>
    <path d="M15 16v-2"/>
    <path d="M8 9h2"/>
    <path d="M20 9h2"/>
    <path d="M17.8 11.8 19 13"/>
    <path d="M15 9h.01"/>
    <path d="M17.8 6.2 19 5"/>
    <path d="m3 21 9-9"/>
    <path d="M12.2 6.2 11 5"/>
  </svg>
`;

const buttonXul = () => `
  <toolbarbutton
    id="${CONFIG.BUTTON_ID}"
    command="${CONFIG.COMMAND_ID}"
    tooltiptext="Auto Organize Tabs (domain rules + AI fallback)">
    <hbox class="toolbarbutton-box" align="center">
      ${WAND_ICON_SVG}
    </hbox>
  </toolbarbutton>
`;

const ensureOrganizeButton = (separator) => {
  if (!separator || separator.querySelector(`#${CONFIG.BUTTON_ID}`)) return;

  try {
    // Position before the native clear button if it exists (matches Tidy Tabs).
    const nativeClearButton = separator.querySelector(
      ".zen-workspace-close-unpinned-tabs-button"
    );

    const buttonFragment = window.MozXULElement.parseXULToFragment(buttonXul());
    const button = buttonFragment.firstChild;
    if (nativeClearButton) {
      separator.insertBefore(button, nativeClearButton);
    } else {
      separator.appendChild(button);
    }
    setupWandMenu(button);
  } catch (e) {
    console.error(`${LOG} ensureOrganizeButton error:`, e);
  }
};

// Right-click menu on the wand: undo last tidy + duplicate cleanup.
// One shared menupopup per window, labels refreshed on every open.
let wandMenu = null;

const ensureWandMenu = () => {
  if (wandMenu?.isConnected) return wandMenu;
  try {
    const popupSet = document.getElementById("mainPopupSet") || document.documentElement;
    const frag = window.MozXULElement.parseXULToFragment(`
      <menupopup id="zao-wand-menu">
        <menuitem id="zao-undo-item" label="Undo last tidy"/>
        <menuitem id="zao-dupes-item" label="Close duplicate tabs"/>
      </menupopup>
    `);
    wandMenu = frag.firstChild;
    wandMenu.addEventListener("popupshowing", () => {
      try {
        const undoItem = wandMenu.querySelector("#zao-undo-item");
        const dupesItem = wandMenu.querySelector("#zao-dupes-item");
        if (undoItem) undoItem.disabled = !hasUndoSnapshot();
        if (dupesItem) {
          const n = countDuplicateTabs();
          dupesItem.label = n > 0 ? `Close duplicate tabs (${n})` : "Close duplicate tabs";
          dupesItem.disabled = n === 0;
        }
      } catch {}
    });
    wandMenu.querySelector("#zao-undo-item")?.addEventListener("command", () => {
      undoLastTidy(window.gZenWorkspaces?.activeWorkspace);
    });
    wandMenu.querySelector("#zao-dupes-item")?.addEventListener("command", () => {
      closeDuplicateTabs();
    });
    popupSet.appendChild(wandMenu);
  } catch (e) {
    console.error(`${LOG} wand menu error:`, e);
    wandMenu = null;
  }
  return wandMenu;
};

const setupWandMenu = (button) => {
  if (!button || button._zaoMenu) return;
  button._zaoMenu = true;
  button.addEventListener("contextmenu", (e) => {
    try {
      e.preventDefault();
      e.stopPropagation();
      const menu = ensureWandMenu();
      if (menu) menu.openPopup(button, "after_pointer", 0, 0, true, false, e);
    } catch (err) {
      console.error(`${LOG} wand menu open error:`, err);
    }
  });
};

// Auto-tidy: when ungrouped tabs pile past the threshold, run the pipeline
// after a quiet period. Skipped while a run is in flight or a preview modal
// waits on the user — never interrupt those.
let autoTidyTimer = null;

const scheduleAutoTidy = () => {
  try {
    const threshold = getAutoTidyThreshold();
    if (!threshold || threshold <= 0) return;
    if (autoTidyTimer) clearTimeout(autoTidyTimer);
    autoTidyTimer = setTimeout(() => {
      autoTidyTimer = null;
      try {
        if (isOrganizing()) return;
        if (document.querySelector("dialog.zao-preview-dialog[open]")) return;
        const tabs = getEligibleTabs().tabs;
        const ungrouped = tabs.filter((t) => !t.currentGroup).length;
        if (ungrouped >= threshold) {
          console.log(`${LOG} auto-tidy: ${ungrouped} ungrouped tab(s) ≥ threshold ${threshold}`);
          handleOrganizeClick();
        }
      } catch (e) {
        console.error(`${LOG} auto-tidy error:`, e);
      }
    }, CONFIG.AUTO_TIDY_DEBOUNCE_MS);
  } catch {}
};

export const addButtonToAllSeparators = () => {
  const separators = domCache.getSeparators();
  if (separators.length > 0) {
    separators.forEach(ensureOrganizeButton);
  } else {
    const periphery = document.querySelector("#tabbrowser-arrowscrollbox-periphery");
    if (periphery && !periphery.querySelector(`#${CONFIG.BUTTON_ID}`)) {
      ensureOrganizeButton(periphery);
    }
  }
};

export const setupCommand = () => {
  const zenCommands = domCache.getCommandSet();
  if (!zenCommands) return;

  if (!zenCommands.querySelector(`#${CONFIG.COMMAND_ID}`)) {
    try {
      const cmd = window.MozXULElement.parseXULToFragment(
        `<command id="${CONFIG.COMMAND_ID}"/>`
      ).firstChild;
      zenCommands.appendChild(cmd);
    } catch (e) {
      console.error(`${LOG} command create error:`, e);
    }
  }

  // DOM-expando guard rather than a module-level flag — a module re-import
  // (during dev) would reset a module variable, accumulating listeners. The
  // expando survives module reloads because it's pinned to the DOM element.
  if (!zenCommands._zaoCommandListener) {
    const listener = (event) => {
      if (event.target.id === CONFIG.COMMAND_ID) {
        // TIDY_FUSION brush-sweep trigger (ported from tidy B4/C3: brushing class 800ms).
        try {
          if (Services.prefs.getBoolPref(CONFIG.TIDY_ANIMATIONS_PREF, true)) {
            const activeWorkspace = window.gZenWorkspaces?.activeWorkspaceElement;
            const sep = activeWorkspace?.querySelector(".pinned-tabs-container-separator");
            const btn = sep?.querySelector(`#${CONFIG.BUTTON_ID}`);
            if (btn) {
              btn.classList.add("brushing");
              setTimeout(() => {
                try { if (btn.isConnected) btn.classList.remove("brushing"); } catch {}
              }, 800);
              tidyStartWaveAnimation(sep);
            }
          }
        } catch {}
        handleOrganizeClick();
      }
    };
    zenCommands.addEventListener("command", listener);
    zenCommands._zaoCommandListener = listener;
  }
};

// Re-inject the tidy button on workspace changes (the separator element changes per workspace).
export const setupWorkspaceHooks = () => {
  if (typeof window.gZenWorkspaces === "undefined") return;
  // Guard against double-install: dev reloads of the entry script would
  // otherwise stack our wrappers, doubling the calls per workspace switch.
  if (window.gZenWorkspaces._zaoHooksInstalled) return;
  window.gZenWorkspaces._zaoHooksInstalled = true;

  const originalOnTabBrowserInserted = window.gZenWorkspaces.onTabBrowserInserted;
  const originalUpdateTabsContainers = window.gZenWorkspaces.updateTabsContainers;

  window.gZenWorkspaces.onTabBrowserInserted = function (event) {
    if (typeof originalOnTabBrowserInserted === "function") {
      try {
        originalOnTabBrowserInserted.call(window.gZenWorkspaces, event);
      } catch (e) {
        console.error(`${LOG} hook onTabBrowserInserted error:`, e);
      }
    }
    domCache.invalidate();
    addButtonToAllSeparators();
    scheduleAutoTidy();
  };

  window.gZenWorkspaces.updateTabsContainers = function (...args) {
    if (typeof originalUpdateTabsContainers === "function") {
      try {
        originalUpdateTabsContainers.apply(window.gZenWorkspaces, args);
      } catch (e) {
        console.error(`${LOG} hook updateTabsContainers error:`, e);
      }
    }
    domCache.invalidate();
    addButtonToAllSeparators();
    try { tidyUpdateButtonVisibility(); } catch {}
  };
};

// ── TIDY_FUSION: MIN_TABS gating + separator wave/failure animations ──
// Ported from tidy-extract.md sections B (B5/B6 MIN_TABS_FOR_SORT gating) and
// C (C3 wave amp3/freq8/seg50, C4 cleanup, C5 failure amp8/freq20/seg100 3x400ms).
// All entry points are guarded by the tidy-animations pref; when the pref is
// false every function below is a no-op and Wand behaves exactly as before.

let tidySortAnimationId = null;
let tidyIsPlayingFailureAnimation = false;

const tidyAnimationsEnabled = () => {
  try {
    return Services.prefs.getBoolPref(CONFIG.TIDY_ANIMATIONS_PREF, true);
  } catch {
    return true;
  }
};

const tidyGetActiveSeparator = () => {
  try {
    const activeWorkspace = window.gZenWorkspaces?.activeWorkspaceElement;
    return activeWorkspace?.querySelector(".pinned-tabs-container-separator") || null;
  } catch {
    return null;
  }
};

// TIDY_FUSION — reset the separator SVG path to a straight line.
export const tidyCleanupAnimation = () => {
  if (!tidyAnimationsEnabled()) return;
  if (tidyIsPlayingFailureAnimation) return;
  if (tidySortAnimationId !== null) {
    try { cancelAnimationFrame(tidySortAnimationId); } catch {}
    tidySortAnimationId = null;
    try {
      const pathElement = tidyGetActiveSeparator()?.querySelector("#separator-path");
      if (pathElement) pathElement.setAttribute("d", "M 0 1 L 100 1");
    } catch (e) {
      console.error(`${LOG} tidyCleanupAnimation error:`, e);
    }
  }
};

// TIDY_FUSION — wave sweep on the separator SVG (amp 3, freq 8, 50 segments).
export const tidyStartWaveAnimation = (separator) => {
  if (!tidyAnimationsEnabled()) return;
  if (tidySortAnimationId !== null) return;
  try {
    const sep = separator || tidyGetActiveSeparator();
    const pathElement = sep?.querySelector("#separator-path");
    if (!pathElement) return;
    const maxAmplitude = 3;
    const frequency = 8;
    const segments = 50;
    const growthDuration = 500;
    let t = 0;
    const startTime = performance.now();
    const animateWaveLoop = (timestamp) => {
      if (tidySortAnimationId === null) return;
      const elapsedTime = timestamp - startTime;
      const growthProgress = Math.min(elapsedTime / growthDuration, 1);
      const currentAmplitude = maxAmplitude * growthProgress;
      t += 0.5;
      const points = [];
      for (let i = 0; i <= segments; i++) {
        const x = (i / segments) * 100;
        const y = 1 + currentAmplitude * Math.sin((x / (100 / frequency)) * 2 * Math.PI + t * 0.1);
        points.push(`${x.toFixed(2)},${y.toFixed(2)}`);
      }
      if (pathElement?.isConnected) {
        pathElement.setAttribute("d", "M" + points.join(" L"));
        tidySortAnimationId = requestAnimationFrame(animateWaveLoop);
      } else {
        tidySortAnimationId = null;
      }
    };
    tidySortAnimationId = requestAnimationFrame(animateWaveLoop);
  } catch (e) {
    console.error(`${LOG} tidyStartWaveAnimation error:`, e);
  }
};

// TIDY_FUSION — spiky failure wave (amp 8, freq 20, 100 segments, 3x400ms pulses).
export const tidyStartFailureAnimation = () => {
  if (!tidyAnimationsEnabled()) return;
  try {
    if (tidySortAnimationId !== null) {
      try { cancelAnimationFrame(tidySortAnimationId); } catch {}
    }
    tidyIsPlayingFailureAnimation = true;
    const pathElement = tidyGetActiveSeparator()?.querySelector("#separator-path");
    if (pathElement) {
      const maxAmplitude = 8;
      const frequency = 20;
      const segments = 100;
      const pulseDuration = 400;
      const totalPulses = 3;
      let currentPulse = 0;
      let t = 0;
      const startTime = performance.now();
      let pulseStartTime = startTime;
      const animateFailureLoop = (timestamp) => {
        if (tidySortAnimationId === null) return;
        const elapsedSincePulseStart = timestamp - pulseStartTime;
        const pulseProgress = elapsedSincePulseStart / pulseDuration;
        if (pulseProgress >= 1) {
          currentPulse++;
          if (currentPulse >= totalPulses) {
            pathElement.setAttribute("d", "M 0 1 L 100 1");
            tidySortAnimationId = null;
            tidyIsPlayingFailureAnimation = false;
            return;
          }
          pulseStartTime = timestamp;
        }
        const currentProgress = Math.min(pulseProgress, 1);
        const intensity = Math.sin(currentProgress * Math.PI);
        const currentAmplitude = maxAmplitude * intensity;
        t += 1.2;
        const points = [];
        for (let i = 0; i <= segments; i++) {
          const x = (i / segments) * 100;
          const baseWave = Math.sin((x / (100 / frequency)) * 2 * Math.PI + t * 0.15);
          const sharpWave = Math.sign(baseWave) * Math.pow(Math.abs(baseWave), 0.3);
          const y = 1 + currentAmplitude * sharpWave;
          points.push(`${x.toFixed(2)},${y.toFixed(2)}`);
        }
        if (pathElement?.isConnected) {
          pathElement.setAttribute("d", "M" + points.join(" L"));
          tidySortAnimationId = requestAnimationFrame(animateFailureLoop);
        } else {
          tidySortAnimationId = null;
          tidyIsPlayingFailureAnimation = false;
        }
      };
      tidySortAnimationId = requestAnimationFrame(animateFailureLoop);
    }
  } catch (e) {
    console.error(`${LOG} tidyStartFailureAnimation error:`, e);
    tidyIsPlayingFailureAnimation = false;
  }
};

// TIDY_FUSION — MIN_TABS gating (ported from tidy B5/B6).
// Show the wand button when groups exist and any ungrouped tab remains,
// otherwise only when ungrouped tabs reach TIDY_MIN_TABS_FOR_SORT (6).
export const tidyUpdateButtonVisibility = () => {
  if (!tidyAnimationsEnabled()) return;
  try {
    const separators = domCache.getSeparators();
    if (!separators || separators.length === 0) return;
    const workspaceId = window.gZenWorkspaces?.activeWorkspace;
    if (!workspaceId || typeof gBrowser === "undefined" || !gBrowser.tabs) return;
    let ungroupedTotal = 0;
    let hasGroupedTabs = false;
    for (const tab of gBrowser.tabs) {
      try {
        if (tab.pinned) continue;
        const wsId = tab.getAttribute?.("zen-workspace-id");
        if (wsId && wsId !== workspaceId) continue;
        if (tab.closest?.("tab-group")) hasGroupedTabs = true;
        else ungroupedTotal++;
      } catch {}
    }
    const shouldShow = hasGroupedTabs
      ? ungroupedTotal > 0
      : ungroupedTotal >= CONFIG.TIDY_MIN_TABS_FOR_SORT;
    for (const separator of separators) {
      if (!separator?.isConnected) continue;
      const btn = separator.querySelector(`#${CONFIG.BUTTON_ID}`);
      if (!btn) continue;
      if (shouldShow) btn.classList.remove("hidden-button");
      else btn.classList.add("hidden-button");
    }
  } catch (e) {
    console.error(`${LOG} tidyUpdateButtonVisibility error:`, e);
  }
};
