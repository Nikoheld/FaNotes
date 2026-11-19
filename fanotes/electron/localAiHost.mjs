// Which hosts count as "local" for the local AI providers (LM Studio, Ollama,
// OpenCode). Notes are sent to these servers without a cloud consent prompt, so
// only addresses that cannot leave the device or the private LAN qualify:
//
// - the name `localhost`;
// - IPv4 `0/8`, loopback `127/8`, RFC 1918 (`10/8`, `172.16/12`, `192.168/16`)
//   and link-local `169.254/16`;
// - IPv6 loopback `::1`, link-local `fe80::/10`, unique local `fc00::/7`, and
//   IPv4-mapped `::ffff:a.b.c.d` when the mapped address is on the IPv4 list.
//
// Any other name is resolved by DNS and may point anywhere, so it is refused,
// even when it looks like an address prefix (`fd.example.com`, `fcbank.com`,
// `10.0.0.1e1`). The input is `URL.hostname`, which the WHATWG URL parser has
// already canonicalised: decimal, octal and hex IPv4 forms become dotted
// decimal, and IPv6 literals keep their brackets.
//
// The Rust host (`crates/fanotes-host/src/policy.rs`) applies the same rule;
// both read `scripts/fixtures/local-ai-hosts.json`.

const DOTTED_OCTET = /^(?:0|[1-9][0-9]{0,2})$/u
const HEX_GROUP = /^[0-9a-f]{1,4}$/u

/** Strict dotted-decimal IPv4, the only form `URL.hostname` produces. */
export function parseDottedIpv4(text) {
  const parts = String(text).split('.')
  if (parts.length !== 4) return null
  const octets = []
  for (const part of parts) {
    if (!DOTTED_OCTET.test(part)) return null
    const value = Number(part)
    if (value > 255) return null
    octets.push(value)
  }
  return octets
}

/** An IPv6 literal (without brackets) as eight 16-bit groups, or null. */
export function parseIpv6(text) {
  let value = String(text).toLowerCase()
  if (!value.includes(':')) return null
  const tailStart = value.lastIndexOf(':') + 1
  const tail = value.slice(tailStart)
  let tailGroups = []
  if (tail.includes('.')) {
    const v4 = parseDottedIpv4(tail)
    if (!v4) return null
    tailGroups = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]]
    value = value.slice(0, tailStart)
    // `::1.2.3.4` leaves `::`; `1::1.2.3.4` leaves `1::`; `1:2:3:4:5:6:1.2.3.4` leaves `...6:`.
    if (value.endsWith(':') && !value.endsWith('::')) value = value.slice(0, -1)
  }
  const halves = value.split('::')
  if (halves.length > 2) return null
  const groupsOf = (half) => {
    if (half === '') return []
    const groups = half.split(':')
    if (!groups.every((group) => HEX_GROUP.test(group))) return null
    return groups.map((group) => Number.parseInt(group, 16))
  }
  const head = groupsOf(halves[0])
  if (!head) return null
  if (halves.length === 1) {
    const groups = [...head, ...tailGroups]
    return groups.length === 8 ? groups : null
  }
  const rest = groupsOf(halves[1])
  if (!rest) return null
  const known = head.length + rest.length + tailGroups.length
  if (known > 7) return null
  return [...head, ...new Array(8 - known).fill(0), ...rest, ...tailGroups]
}

export function isLanIpv4(octets) {
  const [a, b] = octets
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

export function isLanIpv6(groups) {
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return true
  if ((groups[0] & 0xffc0) === 0xfe80) return true
  if ((groups[0] & 0xfe00) === 0xfc00) return true
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return isLanIpv4([groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff])
  }
  return false
}

/** True when a `URL.hostname` names this device or the private LAN. */
export function isLocalAiHostname(hostname) {
  const host = String(hostname ?? '').toLowerCase()
  if (host === 'localhost') return true
  if (host.startsWith('[') && host.endsWith(']')) {
    const groups = parseIpv6(host.slice(1, -1))
    return groups !== null && isLanIpv6(groups)
  }
  const octets = parseDottedIpv4(host)
  return octets !== null && isLanIpv4(octets)
}
