export class FamdCorruptError extends Error {
  code: 'FAMD_CORRUPT'
}

export const FAMD_V2_SCHEMA: string

export function famdEncodingForSave(existing: string | null | undefined): 'v1' | 'v2'

export function isActiveV2(source: string): boolean

export function v2CutIndex(source: string): number

export function readV2Payload(source: string): Record<string, unknown>

export function encodeV2Document(body: string, payload: {
  updatedAt: string
  ink: unknown
  worksheets: string[]
  paperStyle?: string
  noteLinks?: unknown[]
  noteBackups?: unknown[]
  pageStats?: unknown
  textFields?: unknown[]
}): string
