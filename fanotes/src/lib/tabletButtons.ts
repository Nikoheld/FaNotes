/** Wacom pen and pad buttons the Pointer Event path can actually see. */

export const TABLET_BUTTON_ACTIONS = ['ink', 'eraser', 'undo', 'redo', 'pan', 'none', 'os'] as const
export type TabletButtonAction = (typeof TABLET_BUTTON_ACTIONS)[number]

export const TABLET_BUTTON_CONTROLS = [
  { id: 'pen-tip', group: 'pen', label: 'Spitze', hint: 'Kontakt · Button 0' },
  { id: 'pen-barrel', group: 'pen', label: 'Seitliche Taste', hint: 'Barrel · Button 2' },
  { id: 'pen-upper', group: 'pen', label: 'Obere Taste', hint: 'Oft Mittelklick · Button 1' },
  { id: 'pen-eraser', group: 'pen', label: 'Radierer-Ende', hint: 'Button 5' },
  { id: 'tablet-1', group: 'tablet', label: 'Tablett-Taste 1', hint: 'Zurück · Button 3' },
  { id: 'tablet-2', group: 'tablet', label: 'Tablett-Taste 2', hint: 'Vor · Button 4' },
] as const

export type TabletButtonId = (typeof TABLET_BUTTON_CONTROLS)[number]['id']
export type TabletButtonGroup = 'pen' | 'tablet'
export type TabletButtonMap = Record<TabletButtonId, TabletButtonAction>

export const TABLET_BUTTON_ACTION_LABELS: Record<TabletButtonAction, string> = {
  ink: 'Schreiben',
  eraser: 'Radierer',
  undo: 'Rückgängig',
  redo: 'Wiederholen',
  pan: 'Schwenken',
  none: 'Keine Aktion',
  os: 'System / Rechtsklick',
}

export const DEFAULT_TABLET_BUTTON_ACTIONS: TabletButtonMap = {
  'pen-tip': 'ink',
  'pen-barrel': 'eraser',
  'pen-upper': 'pan',
  'pen-eraser': 'eraser',
  'tablet-1': 'undo',
  'tablet-2': 'redo',
}

const ACTION_SET = new Set<string>(TABLET_BUTTON_ACTIONS)
const CONTROL_IDS = new Set<string>(TABLET_BUTTON_CONTROLS.map((control) => control.id))

export const isTabletButtonAction = (value: unknown): value is TabletButtonAction => (
  typeof value === 'string' && ACTION_SET.has(value)
)

export const isTabletButtonId = (value: unknown): value is TabletButtonId => (
  typeof value === 'string' && CONTROL_IDS.has(value)
)

export const sanitizeTabletButtonMap = (value: unknown): TabletButtonMap => {
  const next: TabletButtonMap = { ...DEFAULT_TABLET_BUTTON_ACTIONS }
  if (!value || typeof value !== 'object') return next
  const raw = value as Record<string, unknown>
  for (const control of TABLET_BUTTON_CONTROLS) {
    const action = raw[control.id]
    if (isTabletButtonAction(action)) next[control.id] = action
  }
  return next
}

export type PointerButtonLike = {
  pointerType?: string
  button?: number
  buttons?: number
}

/**
 * Which listed control a Pointer Event is. Stylus-as-mouse (Wacom barrel as
 * right/middle click) is accepted when `asStylus` is set. Extra pad keys
 * (button 3/4) are tablet controls even when Chromium reports `mouse`.
 */
export const tabletButtonIdentityFromPointer = (
  event: PointerButtonLike,
  asStylus = false,
): TabletButtonId | null => {
  const pointerType = event.pointerType || ''
  const pen = pointerType === 'pen'
  const stylus = pen || asStylus
  const button = Number.isFinite(event.button) ? Number(event.button) : -1
  const mask = Number(event.buttons) || 0

  if (button === 5 || (mask & 32) !== 0) return 'pen-eraser'
  if (button === 3 || (mask & 8) !== 0) return 'tablet-1'
  if (button === 4 || (mask & 16) !== 0) return 'tablet-2'
  if (button === 2 || (stylus && (mask & 2) !== 0)) {
    return stylus ? 'pen-barrel' : null
  }
  if (button === 1 || (stylus && (mask & 4) !== 0)) {
    return stylus ? 'pen-upper' : null
  }
  if (pen && (button === 0 || button === -1 || (mask & 1) !== 0)) return 'pen-tip'
  return null
}

export const tabletButtonAction = (
  assignments: unknown,
  identity: TabletButtonId | null | undefined,
): TabletButtonAction => {
  if (!identity) return 'os'
  return sanitizeTabletButtonMap(assignments)[identity]
}

export const tabletButtonActionFromPointer = (
  assignments: unknown,
  event: PointerButtonLike,
  asStylus = false,
) => tabletButtonAction(assignments, tabletButtonIdentityFromPointer(event, asStylus))

export const shouldInterceptTabletButton = (action: TabletButtonAction) => action !== 'os'

export const tabletButtonControlsInGroup = (group: TabletButtonGroup) => (
  TABLET_BUTTON_CONTROLS.filter((control) => control.group === group)
)
