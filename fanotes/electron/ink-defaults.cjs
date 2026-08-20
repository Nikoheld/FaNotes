'use strict'

/** Windows tablets treat a resting palm as touch/mouse. Pen-only is the factory default there. */
function defaultPenOnlyForPlatform(platform) {
  return String(platform ?? '') === 'win32'
}

function shouldRejectNonPenInk(pointerType, penOnly) {
  return Boolean(penOnly) && pointerType !== 'pen'
}

module.exports = {
  defaultPenOnlyForPlatform,
  shouldRejectNonPenInk,
}
