export type AgentConversationDisplayEventKind =
  | 'thought'
  | 'tool_call'
  | 'file_review'

export type AgentConversationDisplayEventStatus =
  | 'active'
  | 'completed'
  | 'error'
  | 'pending_approval'
  | 'approved'
  | 'rejected'
  | 'expired'
  | 'cancelled'

export interface AgentFileReviewDisplayData {
  approvalId: string
  path: string
  operation: 'create' | 'update'
  diff: string
  additions: number
  deletions: number
}

export interface AgentConversationDisplayEvent {
  id: string
  order: number
  kind: AgentConversationDisplayEventKind
  stepId: string
  callId?: string
  title: string
  content?: string
  tool?: string
  argumentsPreview?: string
  durationMs?: number
  status: AgentConversationDisplayEventStatus
  createdAt: number
  fileReview?: AgentFileReviewDisplayData
}

const SENSITIVE_KEY = /(api[-_]?key|token|authorization|cookie|password|passwd|secret|credential|private[-_]?key|access[-_]?key)/i
const MAX_ARGUMENT_PREVIEW = 4_000

const sanitizeDisplayValue = (value: unknown, depth = 0): unknown => {
  if (depth >= 4) return '[已省略过深内容]'
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') return value.length > 800 ? `${value.slice(0, 800)}…` : value
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeDisplayValue(item, depth + 1))
  if (!value || typeof value !== 'object') return String(value ?? '')

  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 40)) {
    result[key] = SENSITIVE_KEY.test(key) ? '[已脱敏]' : sanitizeDisplayValue(item, depth + 1)
  }
  return result
}

export const formatAgentArgumentsPreview = (value: unknown) => {
  try {
    const text = JSON.stringify(sanitizeDisplayValue(value), null, 2)
    if (text.length <= MAX_ARGUMENT_PREVIEW) return text
    let previewLength = Math.min(text.length, MAX_ARGUMENT_PREVIEW - 200)
    let truncated = ''
    do {
      truncated = JSON.stringify({
        truncated: true,
        preview: `${text.slice(0, previewLength)}…`,
      }, null, 2)
      previewLength = Math.max(0, previewLength - Math.max(100, truncated.length - MAX_ARGUMENT_PREVIEW))
    } while (truncated.length > MAX_ARGUMENT_PREVIEW && previewLength > 0)
    return truncated.length <= MAX_ARGUMENT_PREVIEW ? truncated : '{"truncated":true}'
  } catch {
    return '{}'
  }
}

export const countUnifiedDiffChanges = (diff: string) => {
  let additions = 0
  let deletions = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions += 1
    if (line.startsWith('-') && !line.startsWith('---')) deletions += 1
  }
  return { additions, deletions }
}

export interface SideBySideDiffRow {
  id: string
  kind: 'context' | 'addition' | 'deletion' | 'hunk'
  beforeLine?: number
  afterLine?: number
  before: string
  after: string
}

const parseHunkStart = (line: string) => {
  const match = line.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/)
  return match ? { before: Number(match[1]), after: Number(match[2]) } : null
}

export const buildSideBySideDiffRows = (diff: string): SideBySideDiffRow[] => {
  const rows: SideBySideDiffRow[] = []
  let beforeLine = 0
  let afterLine = 0
  let rowId = 0

  for (const line of diff.split('\n')) {
    if (line.startsWith('---') || line.startsWith('+++')) continue
    if (line.startsWith('@@')) {
      const start = parseHunkStart(line)
      if (start) {
        beforeLine = start.before
        afterLine = start.after
      }
      rows.push({ id: `row-${rowId += 1}`, kind: 'hunk', before: line, after: line })
      continue
    }
    if (line.startsWith('-')) {
      rows.push({ id: `row-${rowId += 1}`, kind: 'deletion', beforeLine, before: line.slice(1), after: '' })
      beforeLine += 1
      continue
    }
    if (line.startsWith('+')) {
      rows.push({ id: `row-${rowId += 1}`, kind: 'addition', afterLine, before: '', after: line.slice(1) })
      afterLine += 1
      continue
    }
    const content = line.startsWith(' ') ? line.slice(1) : line
    rows.push({ id: `row-${rowId += 1}`, kind: 'context', beforeLine, afterLine, before: content, after: content })
    beforeLine += 1
    afterLine += 1
  }

  return rows
}
