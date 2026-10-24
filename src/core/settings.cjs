'use strict';
const DEFAULTS = Object.freeze({ character: 'claude', followActivity: true, showBoth: true, foregroundEnabled: true, autoDormant: true, fullscreenHide: true, alwaysOnTop: true, edgeDock: false, reducedMotion: false, size: 100, position: null });
function sanitizeSettings(input, characterIds) {
  const value = { ...DEFAULTS };
  if (!input || typeof input !== 'object') return value;
  if (Object.hasOwn(input, 'character') && characterIds.includes(input.character)) value.character = input.character;
  for (const key of ['followActivity', 'showBoth', 'foregroundEnabled', 'autoDormant', 'fullscreenHide', 'alwaysOnTop', 'edgeDock', 'reducedMotion']) if (Object.hasOwn(input, key) && typeof input[key] === 'boolean') value[key] = input[key];
  if (Object.hasOwn(input, 'size') && Number.isFinite(input.size)) value.size = Math.max(70, Math.min(140, Math.round(input.size)));
  const coordinate = n => Number.isSafeInteger(n) && n >= -2147483648 && n <= 2147483647;
  if (Object.hasOwn(input, 'position') && input.position && coordinate(input.position.x) && coordinate(input.position.y)) value.position = { x: input.position.x, y: input.position.y };
  return value;
}
function clampBounds(position, workArea, width, height) {
  return { x: Math.max(workArea.x, Math.min(position.x, workArea.x + Math.max(0, workArea.width - width))), y: Math.max(workArea.y, Math.min(position.y, workArea.y + Math.max(0, workArea.height - height))) };
}
module.exports = { DEFAULTS, sanitizeSettings, clampBounds };
