'use strict'

const TABLET_BUTTON_ACTIONS = ['ink', 'eraser', 'undo', 'redo', 'pan', 'none', 'os']
const TABLET_BUTTON_IDS = ['pen-tip', 'pen-barrel', 'pen-upper', 'pen-eraser', 'tablet-1', 'tablet-2']

const DEFAULT_TABLET_BUTTON_ACTIONS = Object.freeze({
  'pen-tip': 'ink',
  'pen-barrel': 'eraser',
  'pen-upper': 'pan',
  'pen-eraser': 'eraser',
  'tablet-1': 'undo',
  'tablet-2': 'redo',
})

function sanitizeTabletButtonMap(value) {
  const next = { ...DEFAULT_TABLET_BUTTON_ACTIONS }
  if (!value || typeof value !== 'object') return next
  for (const id of TABLET_BUTTON_IDS) {
    const action = value[id]
    if (TABLET_BUTTON_ACTIONS.includes(action)) next[id] = action
  }
  return next
}

module.exports = {
  TABLET_BUTTON_ACTIONS,
  TABLET_BUTTON_IDS,
  DEFAULT_TABLET_BUTTON_ACTIONS,
  sanitizeTabletButtonMap,
}
