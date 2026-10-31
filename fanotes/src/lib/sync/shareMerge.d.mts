import type { ShareInk, ShareTextColumn, ShareTextField } from './share'

export type ShareMergeNote = {
  path: string
  title: string
  content: string
  ink?: ShareInk
  textFields?: ShareTextField[]
  textColumn?: ShareTextColumn
}

export function mergeShareNotes(base: unknown, current: unknown, incoming: unknown): ShareMergeNote[]

export function mergeShareText(base: unknown, current: unknown, incoming: unknown): string

export function sanitizeSharePersonName(value: unknown): string
