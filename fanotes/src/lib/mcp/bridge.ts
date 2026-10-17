import { mcpReaderRequest, type McpGrantInfo } from './client'
import type { SyncSession } from '../sync/api'
import { answerVaultTool, collectVaultNotes, type VaultReader } from './vaultQuery'

type Job = { id: string; tool: string; arguments: Record<string, unknown> }

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export const startMcpBridge = (deps: {
  session: () => SyncSession | null
  readerKey: () => string | null
  reader: VaultReader
  onRejected?: () => void
}) => {
  let stopped = false
  const loop = async () => {
    while (!stopped) {
      const session = deps.session()
      const readerKey = deps.readerKey()
      if (!session || !readerKey) {
        await sleep(2_000)
        continue
      }
      try {
        const body = await mcpReaderRequest(session, '/reader/poll', {
          method: 'POST',
          readerKey,
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        }) as { job?: Job | null }
        const job = body?.job
        if (!job || stopped) continue
        const notes = await collectVaultNotes(job.tool, job.arguments ?? {}, deps.reader)
        const result = answerVaultTool(job.tool, job.arguments ?? {}, notes)
        await mcpReaderRequest(session, '/reader/result', {
          method: 'POST',
          readerKey,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: job.id, result }),
        })
      } catch (error) {
        const status = (error as { status?: number }).status
        if (status === 401) deps.onRejected?.()
        await sleep(4_000)
      }
    }
  }
  void loop()
  return () => { stopped = true }
}

export type { McpGrantInfo }
