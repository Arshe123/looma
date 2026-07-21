import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import type { AgentEvent } from '../../../shared/types/agent-events'
import type { AgentMessage } from '../../../shared/types/agent-message'
import type { AgentRun, AgentTask } from '../../../shared/types/agent-state'
import { validateAgentMessageTranscript } from '../../../shared/utils/agent-message-invariants'
import type {
  AgentLedgerTransaction,
  AgentLedgerView,
  AgentOutboxEntry,
  AgentSnapshotEnvelope,
  RuntimeCheckpointEnvelope,
} from './agentLedgerTypes'

const TRANSACTION_FILE = /^(\d{16})-([A-Za-z0-9_-]{1,80})\.json$/
const MAX_TRANSACTION_BYTES = 2 * 1024 * 1024

const emptyView = (): AgentLedgerView => ({
  tasks: {},
  runs: {},
  messages: [],
  events: [],
  sources: [],
  outbox: {},
})

const stableJson = (value: unknown) => `${JSON.stringify(value)}\n`

const writeDurableFile = async (filePath: string, content: string) => {
  const handle = await open(filePath, 'wx', 0o600)
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

const parseBoundedJson = async <T>(filePath: string): Promise<T> => {
  const content = await readFile(filePath, 'utf8')
  if (Buffer.byteLength(content, 'utf8') > MAX_TRANSACTION_BYTES) {
    throw new Error(`Agent ledger record exceeds ${MAX_TRANSACTION_BYTES} bytes`)
  }
  return JSON.parse(content) as T
}

const messageCallIds = (message: AgentMessage) => new Set((message.tool_calls || []).map(call => call.id))

const validateToolCallCommit = (event: AgentEvent, message: AgentMessage, outbox: AgentOutboxEntry) => {
  if (event.type !== 'tool_call_requested' || message.role !== 'assistant') {
    throw new Error('tool_call_commit requires tool_call_requested event and assistant message')
  }
  const callId = event.payload.callId
  if (!messageCallIds(message).has(callId) || outbox.callId !== callId || outbox.status !== 'pending') {
    throw new Error(`tool_call_commit correlation mismatch (${callId})`)
  }
  if (message.taskId !== event.taskId || message.runId !== event.runId || outbox.taskId !== event.taskId || outbox.runId !== event.runId) {
    throw new Error(`tool_call_commit task/run mismatch (${callId})`)
  }
}

const validateToolResultCommit = (event: AgentEvent, message: AgentMessage, outbox: AgentOutboxEntry) => {
  if (event.type !== 'tool_result_recorded' || message.role !== 'tool') {
    throw new Error('tool_result_commit requires tool_result_recorded event and tool message')
  }
  const callId = event.payload.callId
  if (message.tool_call_id !== callId || message.name !== event.payload.tool || outbox.callId !== callId || outbox.status === 'pending') {
    throw new Error(`tool_result_commit correlation mismatch (${callId})`)
  }
  if (message.taskId !== event.taskId || message.runId !== event.runId || outbox.taskId !== event.taskId || outbox.runId !== event.runId) {
    throw new Error(`tool_result_commit task/run mismatch (${callId})`)
  }
}

export interface AgentLedgerAuditIssue {
  code: 'message_invariant' | 'duplicate_event_id' | 'duplicate_event_sequence' | 'missing_tool_call_fact' | 'missing_tool_result_fact' | 'orphan_outbox'
  runId?: string
  callId?: string
  detail: string
}

export interface LedgerCommitInput {
  kind: AgentLedgerTransaction['kind']
  tasks?: AgentTask[]
  runs?: AgentRun[]
  messages?: AgentMessage[]
  events?: AgentEvent[]
  sources?: AgentLedgerTransaction['sources']
  outbox?: AgentOutboxEntry[]
}

export class AgentLedgerStore {
  private readonly transactionsDir: string
  private readonly temporaryDir: string
  private readonly snapshotsDir: string
  private readonly checkpointsDir: string
  private queue: Promise<unknown> = Promise.resolve()
  private nextSequence = 1
  private initialized = false

  constructor(private readonly rootDir: string) {
    this.transactionsDir = path.join(rootDir, 'transactions')
    this.temporaryDir = path.join(rootDir, 'tmp')
    this.snapshotsDir = path.join(rootDir, 'snapshots')
    this.checkpointsDir = path.join(rootDir, 'checkpoints')
  }

  async init() {
    if (this.initialized) return
    await Promise.all([
      mkdir(this.transactionsDir, { recursive: true }),
      mkdir(this.temporaryDir, { recursive: true }),
      mkdir(this.snapshotsDir, { recursive: true }),
      mkdir(this.checkpointsDir, { recursive: true }),
    ])
    const files = await readdir(this.temporaryDir)
    await Promise.all(files.filter(file => file.endsWith('.tmp')).map(file => rm(path.join(this.temporaryDir, file), { force: true })))
    const sequences = (await readdir(this.transactionsDir))
      .map(file => TRANSACTION_FILE.exec(file))
      .filter((match): match is RegExpExecArray => Boolean(match))
      .map(match => Number(match[1]))
      .filter(Number.isSafeInteger)
    this.nextSequence = (sequences.length ? Math.max(...sequences) : 0) + 1
    this.initialized = true
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation)
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }

  async commit(input: LedgerCommitInput): Promise<AgentLedgerTransaction> {
    await this.init()
    return this.serialize(async () => {
      const ledgerSequence = this.nextSequence++
      const txId = `tx_${randomUUID().replace(/-/g, '')}`
      const transaction: AgentLedgerTransaction = {
        schemaVersion: 1,
        ledgerSequence,
        txId,
        createdAt: Date.now(),
        ...input,
      }
      const prefix = String(ledgerSequence).padStart(16, '0')
      const temporaryPath = path.join(this.temporaryDir, `${prefix}-${txId}.tmp`)
      const committedPath = path.join(this.transactionsDir, `${prefix}-${txId}.json`)
      await writeDurableFile(temporaryPath, stableJson(transaction))
      await rename(temporaryPath, committedPath)
      return transaction
    })
  }

  async commitToolCall(event: AgentEvent, message: AgentMessage, outbox: AgentOutboxEntry) {
    validateToolCallCommit(event, message, outbox)
    return this.commit({ kind: 'tool_call_commit', events: [event], messages: [message], outbox: [outbox] })
  }

  async commitToolResult(event: AgentEvent, message: AgentMessage, outbox: AgentOutboxEntry) {
    validateToolResultCommit(event, message, outbox)
    return this.commit({ kind: 'tool_result_commit', events: [event], messages: [message], outbox: [outbox] })
  }

  async readTransactions(): Promise<AgentLedgerTransaction[]> {
    await this.init()
    const files = (await readdir(this.transactionsDir))
      .filter(file => TRANSACTION_FILE.test(file))
      .sort((a, b) => a.localeCompare(b))
    const transactions: AgentLedgerTransaction[] = []
    for (const file of files) {
      const transaction = await parseBoundedJson<AgentLedgerTransaction>(path.join(this.transactionsDir, file))
      if (transaction.schemaVersion !== 1 || !Number.isSafeInteger(transaction.ledgerSequence)) {
        throw new Error(`Invalid Agent ledger transaction: ${file}`)
      }
      transactions.push(transaction)
    }
    return transactions
  }

  async materialize(): Promise<AgentLedgerView> {
    const view = emptyView()
    for (const transaction of await this.readTransactions()) {
      for (const task of transaction.tasks || []) view.tasks[task.id] = task
      for (const run of transaction.runs || []) view.runs[run.id] = run
      view.messages.push(...(transaction.messages || []))
      view.events.push(...(transaction.events || []))
      view.sources.push(...(transaction.sources || []))
      for (const entry of transaction.outbox || []) view.outbox[entry.callId] = entry
    }
    view.events.sort((a, b) => a.runId.localeCompare(b.runId) || a.sequence - b.sequence)
    return view
  }

  async audit(): Promise<AgentLedgerAuditIssue[]> {
    const view = await this.materialize()
    const issues: AgentLedgerAuditIssue[] = []
    const pendingCalls = new Set(Object.values(view.outbox).filter(entry => entry.status === 'pending').map(entry => entry.callId))
    for (const issue of validateAgentMessageTranscript(view.messages)) {
      if (issue.code === 'unmatched_tool_call' && issue.callId && pendingCalls.has(issue.callId)) continue
      issues.push({ code: 'message_invariant', callId: issue.callId, detail: `${issue.code}:${issue.messageId}` })
    }

    const eventIds = new Set<string>()
    const eventSequences = new Set<string>()
    const callFacts = new Set<string>()
    const resultFacts = new Set<string>()
    for (const event of view.events) {
      if (eventIds.has(event.id)) issues.push({ code: 'duplicate_event_id', runId: event.runId, detail: event.id })
      eventIds.add(event.id)
      const sequenceKey = `${event.runId}:${event.sequence}`
      if (eventSequences.has(sequenceKey)) issues.push({ code: 'duplicate_event_sequence', runId: event.runId, detail: sequenceKey })
      eventSequences.add(sequenceKey)
      if (event.type === 'tool_call_requested') callFacts.add(event.payload.callId)
      if (event.type === 'tool_result_recorded') resultFacts.add(event.payload.callId)
    }
    for (const entry of Object.values(view.outbox)) {
      if (!callFacts.has(entry.callId)) {
        issues.push({ code: 'missing_tool_call_fact', runId: entry.runId, callId: entry.callId, detail: entry.status })
        continue
      }
      if (entry.status !== 'pending' && !resultFacts.has(entry.callId)) {
        issues.push({ code: 'missing_tool_result_fact', runId: entry.runId, callId: entry.callId, detail: entry.status })
      }
    }
    for (const callId of callFacts) {
      if (!view.outbox[callId]) issues.push({ code: 'orphan_outbox', callId, detail: 'tool call has no outbox state' })
    }
    return issues
  }

  async eventLogPrefixHash(runId: string, throughSequence?: number) {
    const events = (await this.materialize()).events.filter(event => event.runId === runId && (throughSequence === undefined || event.sequence <= throughSequence))
    return createHash('sha256').update(JSON.stringify(events)).digest('hex')
  }

  private async writeReplaceableCache(directory: string, runId: string, value: unknown) {
    await this.init()
    const finalPath = path.join(directory, `${runId}.json`)
    const temporaryPath = path.join(this.temporaryDir, `${runId}-${randomUUID()}.tmp`)
    await writeDurableFile(temporaryPath, stableJson(value))
    await rm(finalPath, { force: true })
    await rename(temporaryPath, finalPath)
  }

  async writeSnapshot(snapshot: AgentSnapshotEnvelope) {
    await this.writeReplaceableCache(this.snapshotsDir, snapshot.runId, snapshot)
  }

  async writeCheckpoint(checkpoint: RuntimeCheckpointEnvelope) {
    await this.writeReplaceableCache(this.checkpointsDir, checkpoint.runId, checkpoint)
  }

  async readSnapshot(runId: string, expectedPrefixHash: string): Promise<AgentSnapshotEnvelope | null> {
    return this.readValidatedCache(this.snapshotsDir, runId, expectedPrefixHash)
  }

  async readCheckpoint(runId: string, expectedPrefixHash: string): Promise<RuntimeCheckpointEnvelope | null> {
    return this.readValidatedCache(this.checkpointsDir, runId, expectedPrefixHash)
  }

  private async readValidatedCache<T extends { eventLogPrefixHash: string }>(directory: string, runId: string, expectedPrefixHash: string): Promise<T | null> {
    try {
      const value = await parseBoundedJson<T>(path.join(directory, `${runId}.json`))
      return value.eventLogPrefixHash === expectedPrefixHash ? value : null
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      return null
    }
  }
}
