import { linuxHyprlandRuntimeContext, sendDataPolicy, type SendDataLinuxRuntime } from './sendData'

export type ConfirmHost = 'fanotes' | 'compositor'

/**
 * Send Data (when on) plus Hyprland runtime picks the in-app FaNotes dialog.
 * Hyprland's window.confirm always spawns in the upper corner.
 * Delete paths always use the FaNotes host so they never call window.confirm.
 */
export const deleteConfirmHost = (input: {
  sendDataEnabled?: unknown
  linux?: Parameters<typeof linuxHyprlandRuntimeContext>[0] | SendDataLinuxRuntime
} = {}): ConfirmHost => {
  const policy = sendDataPolicy(input.sendDataEnabled)
  const linux = linuxHyprlandRuntimeContext(input.linux)
  if (policy.enabled && linux.hyprland) return 'fanotes'
  return 'fanotes'
}

export const shouldUseInAppDeleteConfirm = (
  input: Parameters<typeof deleteConfirmHost>[0] = {},
) => deleteConfirmHost(input) === 'fanotes'

/**
 * Keys the open dialog answers itself. Escape cancels from anywhere in the
 * window; Enter is left to the focused button, so a stray Enter cannot confirm
 * a delete the user has not looked at.
 */
export const confirmDialogKeyAction = (key: string): 'cancel' | null => (
  key === 'Escape' || key === 'Esc' ? 'cancel' : null
)

/**
 * Tab cycles through the dialog's buttons only. Returns the button index to
 * focus, or null to leave the browser's default when focus is not in the
 * dialog yet (it then enters at the first button).
 */
export const confirmDialogTabTarget = (buttonCount: number, focusedIndex: number, backwards: boolean) => {
  if (buttonCount <= 0) return null
  if (focusedIndex < 0) return backwards ? buttonCount - 1 : 0
  return (focusedIndex + (backwards ? buttonCount - 1 : 1)) % buttonCount
}
