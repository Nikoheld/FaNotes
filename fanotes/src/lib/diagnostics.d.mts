export type DiagnosticsConsent = { usage?: boolean; logs?: boolean }
export type DiagnosticsContext = { homeDir?: string; vaultPath?: string; userName?: string }
export type DescribedError = { class: string; code: string; frames: Array<{ file: string; line: number }>; hash: string }
export type DiagnosticsPayload = {
  schemaVersion: 1
  kind: 'daily' | 'report'
  installId: string
  sentAt: number
  app: { version: string; platform: string; arch: string; language: string }
  usage?: {
    counters: Record<string, number>
    errors: Record<string, number>
    perf: { startupMs: number }
    vault: { notes: number; sizeMb: number }
  }
  logs?: DiagnosticsLogEntry[]
  comment?: string
}
export type DiagnosticsLogEntry = { at: number; class: string; code: string; frames: Array<{ file: string; line: number }>; hash: string }
export const DIAGNOSTICS_SCHEMA: 1
export const DIAGNOSTICS_PATH: string
export const DIAGNOSTICS_ORIGIN: string
export const DIAGNOSTICS_INTERVAL_MS: number
export const DIAGNOSTICS_MAX_LOGS: number
export const DIAGNOSTICS_MAX_COUNTERS: number
export const DIAGNOSTICS_MAX_MESSAGE: number
export const DIAGNOSTICS_MAX_COMMENT: number
export const COUNTER_NAME: RegExp
export const INSTALL_ID: RegExp
export function scrubText(input: unknown, context?: DiagnosticsContext, max?: number): string
export function identityFromPath(vaultPath: string): Required<DiagnosticsContext>
export const ERROR_CLASSES: string[]
export const ERROR_CODE: RegExp
export const ERROR_HASH: RegExp
export const ERROR_KEY: RegExp
export const BUNDLE_FILE: RegExp
export function hashText(text: string): string
export function describeError(error: unknown, fallbackMessage?: string): DescribedError
export function errorGroupKey(entry: DescribedError): string
export function noteCountBucket(count: number): number
export function vaultSizeBucketMb(bytes: number): number
export function roundMs(ms: number, step?: number): number
export function newInstallId(randomBytes?: Uint8Array): string
export function cleanCounters(counters: unknown): Record<string, number>
export function buildDiagnosticsPayload(input: {
  consent?: DiagnosticsConsent
  installId: string
  app?: { version?: string; platform?: string; arch?: string; language?: string }
  usage?: { counters?: Record<string, number>; errors?: Record<string, number>; perf?: { startupMs?: number }; vault?: { notes?: number; bytes?: number } }
  logs?: Array<Partial<DiagnosticsLogEntry> & { at: number }>
  comment?: string
  context?: DiagnosticsContext
  now?: number
  manual?: boolean
}): DiagnosticsPayload | null
export function dailySendDue(consent: DiagnosticsConsent | undefined, lastSentAt: number | null | undefined, now?: number): boolean
