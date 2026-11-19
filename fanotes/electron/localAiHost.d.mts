export function parseDottedIpv4(text: string): number[] | null
export function parseIpv6(text: string): number[] | null
export function isLanIpv4(octets: readonly number[]): boolean
export function isLanIpv6(groups: readonly number[]): boolean
export function isLocalAiHostname(hostname: string): boolean
