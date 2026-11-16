export const ARRIVAL_TTL_MS: number
export const ARRIVAL_CAP: number
export const SYNC_GRACE_MS: number
export const SYNC_WRITTEN_MS: number
type StorageLike = { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
export function arrivalStorageKey(vaultPath: string): string
export function loadArrivals(storage: StorageLike | null | undefined, vaultPath: string, now?: number): Map<string, number>
export function saveArrivals(storage: StorageLike | null | undefined, vaultPath: string, arrivals: Map<string, number>): void
export function externalArrivals(input: { files: string[]; now: number; syncBusy: boolean; syncEndedAt?: number; syncWritten?: Map<string, number>; ownRecently: boolean }): string[]
