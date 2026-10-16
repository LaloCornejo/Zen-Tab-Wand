// Zen Tab Wand — Tidy separator animations + wand-button visibility gating.
//
// Split out of browser-ui.mjs so the click pipeline (click-handler.mjs) can
// stop the wave / play the failure pulse without creating an import cycle
// (browser-ui already imports click-handler for the command listener).
// Pure rAF + DOM; no gBrowser dependency.

import { CONFIG, LOG } from "./config.mjs";
import { domCache } from "./tabs.mjs";

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
