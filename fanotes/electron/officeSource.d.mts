export type OfficeSource = { path: string; size: number; mtimeMs: number; engine: 'word' | 'powerpoint' | 'libreoffice' | 'builtin'; convertedAt?: string }
export function parseOfficeSource(value: unknown): OfficeSource | null
