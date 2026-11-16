// Tiny logger that redacts the agent token if it ever shows up in a message.
export function createLogger(secrets = [], sink = (l) => process.stderr.write(l + '\n')) {
  const redact = (s) => {
    let out = String(s)
    for (const sec of secrets) if (sec && sec.length >= 6) out = out.split(sec).join('[redacted]')
    return out
  }
  const log = (level, ...args) =>
    sink(`${new Date().toISOString()} ${level} ${redact(args.map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' '))}`)
  return { info: (...a) => log('INFO', ...a), warn: (...a) => log('WARN', ...a), error: (...a) => log('ERROR', ...a), redact }
}
