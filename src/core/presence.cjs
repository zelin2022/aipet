"use strict";
const PROVIDERS = new Set(["claude", "codex"]);
const GRACE_MS = 15000;
function validatePresence(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "foreground,fullscreen,running"
  )
    return null;
  if (
    ![...PROVIDERS, "unknown"].includes(value.foreground) ||
    !Array.isArray(value.running) ||
    value.running.length > 2 ||
    value.running.some((p) => !PROVIDERS.has(p))
  )
    return null;
  let fullscreen = null;
  if (value.fullscreen !== null) {
    const box = value.fullscreen;
    if (
      !box ||
      Object.keys(box).sort().join(",") !== "height,width,x,y" ||
      !Object.values(box).every(
        (n) => Number.isSafeInteger(n) && Math.abs(n) <= 100000,
      ) ||
      box.width <= 0 ||
      box.height <= 0
    )
      return null;
    fullscreen = { x: box.x, y: box.y, width: box.width, height: box.height };
  }
  return {
    foreground: PROVIDERS.has(value.foreground) ? value.foreground : null,
    running: [...new Set(value.running)],
    fullscreen,
  };
}
class Presence {
  constructor() {
    this.mode = "auto";
    this.lastSeen = -Infinity;
    this.metadata = { foreground: null, running: [], fullscreen: null };
  }
  update(value) {
    const parsed = validatePresence(value);
    if (!parsed) return false;
    this.metadata = parsed;
    return true;
  }
  setMode(mode) {
    if (!["auto", "shown", "hidden"].includes(mode)) return false;
    this.mode = mode;
    return true;
  }
  decide({
    settings,
    activityProviders = [],
    bounds,
    preview = false,
    now = Date.now(),
  }) {
    const providers = [
      ...new Set([...this.metadata.running, ...activityProviders]),
    ].filter((p) => PROVIDERS.has(p));
    if (providers.length) this.lastSeen = now;
    let show =
      !settings.autoDormant ||
      providers.length > 0 ||
      now - this.lastSeen < GRACE_MS;
    let reason = show
      ? providers.length
        ? "ai-present"
        : "settling"
      : "dormant";
    if (this.mode === "shown" || preview) {
      show = true;
      reason = "manual";
    }
    if (this.mode === "hidden") {
      show = false;
      reason = "hidden";
    }
    const full = this.metadata.fullscreen;
    if (show && settings.fullscreenHide && full && bounds) {
      const x = bounds.x + bounds.width / 2,
        y = bounds.y + bounds.height / 2;
      if (
        x >= full.x &&
        x < full.x + full.width &&
        y >= full.y &&
        y < full.y + full.height
      ) {
        show = false;
        reason = "fullscreen";
      }
    }
    return { show, reason, mode: this.mode, providers };
  }
}
module.exports = { Presence, validatePresence, GRACE_MS };
