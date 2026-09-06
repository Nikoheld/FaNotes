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
