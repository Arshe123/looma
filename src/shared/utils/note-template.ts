export type NoteTemplateValue = string | number | boolean
export type NoteTemplateRuntimeVariables = Record<string, NoteTemplateValue>
export type NoteTemplateVariables = NoteTemplateRuntimeVariables

export type NoteTemplateVariable = {
  id: string
  name: string
  type: 'string' | 'number' | 'boolean'
  value: NoteTemplateValue
  afterUseExpression: string
}

export type NoteTemplateInput = {
  name: string
  fileNameTemplate: string
  contentTemplate: string
  variables: NoteTemplateVariable[]
}

export type NoteTemplate = NoteTemplateInput & {
  id: string
  createdAt: number
  updatedAt: number
}

export type NoteTemplateStore = {
  schemaVersion: 1
  revision: number
  templates: NoteTemplate[]
}

export type NoteTemplateErrorCode =
  | 'EMPTY_EXPRESSION'
  | 'EXPRESSION_TOO_LONG'
  | 'TOO_MANY_TOKENS'
  | 'NESTING_TOO_DEEP'
  | 'EVALUATION_LIMIT'
  | 'INVALID_TOKEN'
  | 'INVALID_EXPRESSION'
  | 'UNKNOWN_VARIABLE'
  | 'UNKNOWN_FUNCTION'
  | 'INVALID_ARGUMENT'
  | 'TYPE_ERROR'
  | 'DIVISION_BY_ZERO'
  | 'UNTERMINATED_EXPRESSION'
  | 'INVALID_FILENAME'
  | 'INVALID_TEMPLATE'
  | 'TEMPLATE_TOO_LONG'
  | 'RENDER_TOO_LONG'
  | 'TOO_MANY_VARIABLES'
  | 'INVALID_VARIABLE'
  | 'VARIABLE_TYPE_MISMATCH'
  | 'UNKNOWN_INPUT'

export type NoteTemplateError = {
  code: NoteTemplateErrorCode
  message: string
  position: number
}

export type NoteTemplateResult<T> =
  | { ok: true, value: T }
  | { ok: false, error: NoteTemplateError }

export const NOTE_TEMPLATE_LIMITS = {
  expressionLength: 1_000,
  tokens: 512,
  nestingDepth: 32,
  evaluationSteps: 256,
  nameLength: 100,
  filenameTemplateLength: 300,
  templateLength: 1_048_576,
  renderLength: 1_048_576,
  variables: 100,
  variableNameLength: 64,
  filenameLength: 255,
} as const

const isValidNumber = (value: unknown): value is number =>
  typeof value === 'number'
  && Number.isFinite(value)
  && (!Number.isInteger(value) || Number.isSafeInteger(value))

type TokenKind = 'number' | 'string' | 'identifier' | 'operator' | 'eof'
type Token = { kind: TokenKind; value: string; position: number }

type Expression =
  | { kind: 'literal'; value: NoteTemplateValue; position: number }
  | { kind: 'variable'; name: string; position: number }
  | { kind: 'call'; name: string; args: Expression[]; position: number }
  | { kind: 'unary'; operator: '!' | '+' | '-'; value: Expression; position: number }
  | { kind: 'binary'; operator: string; left: Expression; right: Expression; position: number }
  | { kind: 'conditional'; condition: Expression; truthy: Expression; falsy: Expression; position: number }

class TemplateExpressionError extends Error {
  constructor(
    readonly code: NoteTemplateErrorCode,
    message: string,
    readonly position: number,
  ) {
    super(message)
  }
}

const fail = (code: NoteTemplateErrorCode, message: string, position: number): NoteTemplateResult<never> => ({
  ok: false,
  error: { code, message, position },
})

const expressionError = (code: NoteTemplateErrorCode, message: string, position: number): never => {
  throw new TemplateExpressionError(code, message, position)
}

const tokenize = (source: string): Token[] => {
  const tokens: Token[] = []
  let position = 0
  const add = (kind: TokenKind, value: string, start: number) => {
    tokens.push({ kind, value, position: start })
    if (tokens.length > NOTE_TEMPLATE_LIMITS.tokens) {
      expressionError('TOO_MANY_TOKENS', `表达式最多包含 ${NOTE_TEMPLATE_LIMITS.tokens} 个标记`, start)
    }
  }

  while (position < source.length) {
    if (/\s/.test(source[position])) {
      position += 1
      continue
    }

    const start = position
    const character = source[position]
    if (character === '"' || character === "'") {
      const quote = character
      position += 1
      let value = ''
      let closed = false
      while (position < source.length) {
        const current = source[position++]
        if (current === quote) {
          closed = true
          break
        }
        if (current !== '\\') {
          value += current
          continue
        }
        if (position >= source.length) break
        const escaped = source[position++]
        const escapes: Record<string, string> = { n: '\n', r: '\r', t: '\t', '\\': '\\', '"': '"', "'": "'" }
        if (!(escaped in escapes)) expressionError('INVALID_TOKEN', `不支持的转义序列 \\${escaped}`, position - 2)
        value += escapes[escaped]
      }
      if (!closed) expressionError('INVALID_TOKEN', '字符串缺少结束引号', start)
      add('string', value, start)
      continue
    }

    const number = /^(?:\d+(?:\.\d+)?|\.\d+)/.exec(source.slice(position))
    if (number) {
      add('number', number[0], start)
      position += number[0].length
      continue
    }

    const identifier = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(position))
    if (identifier) {
      add('identifier', identifier[0], start)
      position += identifier[0].length
      continue
    }

    const operator = /^(?:===|!==|<=|>=|&&|\|\||[()+\-*/%!,?:<>])/.exec(source.slice(position))
    if (operator) {
      add('operator', operator[0], start)
      position += operator[0].length
      continue
    }

    expressionError('INVALID_TOKEN', `意外的标记“${character}”`, position)
  }
  tokens.push({ kind: 'eof', value: '', position: source.length })
  return tokens
}

class ExpressionParser {
  private index = 0
  private depth = 0

  constructor(private readonly tokens: Token[]) {}

  parse(): Expression {
    const expression = this.parseConditional()
    const token = this.peek()
    if (token.kind !== 'eof') expressionError('INVALID_EXPRESSION', `意外的标记“${token.value}”`, token.position)
    return expression
  }

  private peek() {
    return this.tokens[this.index]
  }

  private take() {
    return this.tokens[this.index++]
  }

  private match(value: string) {
    if (this.peek().kind !== 'operator' || this.peek().value !== value) return false
    this.index += 1
    return true
  }

  private withDepth<T>(position: number, read: () => T): T {
    this.depth += 1
    if (this.depth > NOTE_TEMPLATE_LIMITS.nestingDepth) {
      expressionError('NESTING_TOO_DEEP', `表达式嵌套不能超过 ${NOTE_TEMPLATE_LIMITS.nestingDepth} 层`, position)
    }
    try {
      return read()
    } finally {
      this.depth -= 1
    }
  }

  private parseConditional(): Expression {
    const condition = this.parseOr()
    if (!this.match('?')) return condition
    return this.withDepth(condition.position, () => {
      const truthy = this.parseConditional()
      const separator = this.peek()
      if (!this.match(':')) expressionError('INVALID_EXPRESSION', '条件表达式中缺少“:”', separator.position)
      const falsy = this.parseConditional()
      return { kind: 'conditional', condition, truthy, falsy, position: condition.position }
    })
  }

  private parseOr(): Expression {
    return this.parseBinary(() => this.parseAnd(), ['||'])
  }

  private parseAnd(): Expression {
    return this.parseBinary(() => this.parseEquality(), ['&&'])
  }

  private parseEquality(): Expression {
    return this.parseBinary(() => this.parseComparison(), ['===', '!=='])
  }

  private parseComparison(): Expression {
    return this.parseBinary(() => this.parseAdditive(), ['<', '<=', '>', '>='])
  }

  private parseAdditive(): Expression {
    return this.parseBinary(() => this.parseMultiplicative(), ['+', '-'])
  }

  private parseMultiplicative(): Expression {
    return this.parseBinary(() => this.parseUnary(), ['*', '/', '%'])
  }

  private parseBinary(readOperand: () => Expression, operators: string[]): Expression {
    let left = readOperand()
    while (this.peek().kind === 'operator' && operators.includes(this.peek().value)) {
      const operator = this.take()
      const right = readOperand()
      left = { kind: 'binary', operator: operator.value, left, right, position: operator.position }
    }
    return left
  }

  private parseUnary(): Expression {
    const token = this.peek()
    if (token.kind === 'operator' && (token.value === '!' || token.value === '+' || token.value === '-')) {
      this.take()
      return this.withDepth(token.position, () => ({
        kind: 'unary',
        operator: token.value as '!' | '+' | '-',
        value: this.parseUnary(),
        position: token.position,
      }))
    }
    return this.parsePrimary()
  }

  private parsePrimary(): Expression {
    const token = this.take()
    if (token.kind === 'number') {
      const value = Number(token.value)
      if (!isValidNumber(value)) expressionError('TYPE_ERROR', '数字必须是有限值，整数不能超出安全范围', token.position)
      return { kind: 'literal', value, position: token.position }
    }
    if (token.kind === 'string') return { kind: 'literal', value: token.value, position: token.position }
    if (token.kind === 'identifier') {
      if (token.value === 'true' || token.value === 'false') {
        return { kind: 'literal', value: token.value === 'true', position: token.position }
      }
      if (!this.match('(')) return { kind: 'variable', name: token.value, position: token.position }
      return this.withDepth(token.position, () => {
        const args: Expression[] = []
        if (!this.match(')')) {
          do {
            args.push(this.parseConditional())
          } while (this.match(','))
          const closing = this.peek()
          if (!this.match(')')) expressionError('INVALID_EXPRESSION', '函数参数后缺少“)”', closing.position)
        }
        return { kind: 'call', name: token.value, args, position: token.position }
      })
    }
    if (token.value === '(') {
      return this.withDepth(token.position, () => {
        const expression = this.parseConditional()
        const closing = this.peek()
        if (!this.match(')')) expressionError('INVALID_EXPRESSION', '缺少“)”', closing.position)
        return expression
      })
    }
    expressionError('INVALID_EXPRESSION', '此处应为字面量、变量或括号表达式', token.position)
  }
}

const requireNumber = (value: NoteTemplateValue, position: number): number => {
  if (!isValidNumber(value)) {
    expressionError('TYPE_ERROR', '此运算符要求有限数字，且整数不能超出安全范围', position)
  }
  return value as number
}

const requireArgs = (name: string, args: NoteTemplateValue[], min: number, max: number, position: number) => {
  if (args.length < min || args.length > max) {
    const expected = min === max ? String(min) : `${min}–${max}`
    expressionError('INVALID_ARGUMENT', `${name} 需要 ${expected} 个参数`, position)
  }
}

const twoDigits = (value: number) => String(value).padStart(2, '0')

const formatDate = (date: Date, format: string, position: number) => {
  if (Number.isNaN(date.getTime())) expressionError('INVALID_ARGUMENT', 'now() 收到了无效日期', position)
  const year = String(date.getFullYear()).padStart(4, '0')
  const weekday = date.getDay()
  const shortWeekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  const longWeekdays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']
  const replacements: Record<string, string> = {
    dddd: longWeekdays[weekday],
    ddd: shortWeekdays[weekday],
    E: String(weekday === 0 ? 7 : weekday),
    YYYY: year,
    YY: year.slice(-2),
    MM: twoDigits(date.getMonth() + 1),
    M: String(date.getMonth() + 1),
    DD: twoDigits(date.getDate()),
    D: String(date.getDate()),
    HH: twoDigits(date.getHours()),
    H: String(date.getHours()),
    mm: twoDigits(date.getMinutes()),
    m: String(date.getMinutes()),
    ss: twoDigits(date.getSeconds()),
    s: String(date.getSeconds()),
  }
  return format.replace(/dddd|ddd|YYYY|YY|MM|DD|HH|mm|ss|M|D|H|m|s|E/g, token => replacements[token])
}

const callBuiltin = (
  name: string,
  args: NoteTemplateValue[],
  now: Date | undefined,
  position: number,
): NoteTemplateValue => {
  if (!['now', 'upper', 'lower', 'trim', 'pad', 'replace'].includes(name)) {
    expressionError('UNKNOWN_FUNCTION', `未知函数“${name}”`, position)
  }
  if (name === 'now') {
    requireArgs(name, args, 1, 1, position)
    if (!now) expressionError('INVALID_ARGUMENT', 'now() 需要调用方提供日期', position)
    return formatDate(now, String(args[0]), position)
  }
  if (name === 'upper' || name === 'lower' || name === 'trim') {
    requireArgs(name, args, 1, 1, position)
    const value = String(args[0])
    if (name === 'upper') return value.toUpperCase()
    if (name === 'lower') return value.toLowerCase()
    return value.trim()
  }
  if (name === 'pad') {
    requireArgs(name, args, 2, 3, position)
    const length = requireNumber(args[1], position)
    const fill = args.length === 3 ? String(args[2]) : '0'
    if (!Number.isInteger(length) || length < 0 || length > 10_000 || fill.length !== 1) {
      expressionError('INVALID_ARGUMENT', 'pad 长度必须是 0 到 10000 的整数，填充内容必须是单个字符', position)
    }
    return String(args[0]).padStart(length, fill)
  }
  requireArgs(name, args, 3, 3, position)
  return String(args[0]).replace(String(args[1]), String(args[2]))
}

const evaluate = (
  expression: Expression,
  variables: NoteTemplateVariables,
  now: Date | undefined,
  context: { steps: number },
): NoteTemplateValue => {
  context.steps += 1
  if (context.steps > NOTE_TEMPLATE_LIMITS.evaluationSteps) {
    expressionError('EVALUATION_LIMIT', `表达式最多执行 ${NOTE_TEMPLATE_LIMITS.evaluationSteps} 个求值步骤`, expression.position)
  }
  if (expression.kind === 'literal') return expression.value
  if (expression.kind === 'variable') {
    if (!Object.prototype.hasOwnProperty.call(variables, expression.name)) {
      expressionError('UNKNOWN_VARIABLE', `未知变量“${expression.name}”`, expression.position)
    }
    return variables[expression.name]
  }
  if (expression.kind === 'call') {
    const args = expression.args.map(argument => evaluate(argument, variables, now, context))
    return callBuiltin(expression.name, args, now, expression.position)
  }
  if (expression.kind === 'unary') {
    const value = evaluate(expression.value, variables, now, context)
    if (expression.operator === '!') return !value
    const number = requireNumber(value, expression.position)
    return expression.operator === '-' ? -number : number
  }
  if (expression.kind === 'conditional') {
    return evaluate(expression.condition, variables, now, context)
      ? evaluate(expression.truthy, variables, now, context)
      : evaluate(expression.falsy, variables, now, context)
  }

  const left = evaluate(expression.left, variables, now, context)
  if (expression.operator === '&&') return left ? evaluate(expression.right, variables, now, context) : left
  if (expression.operator === '||') return left ? left : evaluate(expression.right, variables, now, context)
  const right = evaluate(expression.right, variables, now, context)
  if (expression.operator === '===') return left === right
  if (expression.operator === '!==') return left !== right
  if (expression.operator === '+') {
    if (typeof left === 'string' || typeof right === 'string') return String(left) + String(right)
    return requireNumber(requireNumber(left, expression.position) + requireNumber(right, expression.position), expression.position)
  }
  if (typeof left === 'string' && typeof right === 'string'
    && ['<', '<=', '>', '>='].includes(expression.operator)) {
    if (expression.operator === '<') return left < right
    if (expression.operator === '<=') return left <= right
    if (expression.operator === '>') return left > right
    return left >= right
  }
  const leftNumber = requireNumber(left, expression.position)
  const rightNumber = requireNumber(right, expression.position)
  if (expression.operator === '-') return requireNumber(leftNumber - rightNumber, expression.position)
  if (expression.operator === '*') return requireNumber(leftNumber * rightNumber, expression.position)
  if (expression.operator === '/' || expression.operator === '%') {
    if (rightNumber === 0) expressionError('DIVISION_BY_ZERO', '不能除以零', expression.position)
    return requireNumber(expression.operator === '/' ? leftNumber / rightNumber : leftNumber % rightNumber, expression.position)
  }
  if (expression.operator === '<') return leftNumber < rightNumber
  if (expression.operator === '<=') return leftNumber <= rightNumber
  if (expression.operator === '>') return leftNumber > rightNumber
  return leftNumber >= rightNumber
}

export const evaluateNoteTemplateExpression = (
  source: string,
  variables: NoteTemplateVariables,
  now?: Date,
): NoteTemplateResult<NoteTemplateValue> => {
  if (source.trim().length === 0) return fail('EMPTY_EXPRESSION', '模板表达式不能为空', 0)
  if (source.length > NOTE_TEMPLATE_LIMITS.expressionLength) {
    return fail('EXPRESSION_TOO_LONG', `表达式最多包含 ${NOTE_TEMPLATE_LIMITS.expressionLength} 个字符`, NOTE_TEMPLATE_LIMITS.expressionLength)
  }
  try {
    return { ok: true, value: evaluate(new ExpressionParser(tokenize(source)).parse(), variables, now, { steps: 0 }) }
  } catch (error) {
    if (error instanceof TemplateExpressionError) return fail(error.code, error.message, error.position)
    return fail('INVALID_EXPRESSION', '模板表达式无效', 0)
  }
}

const findTemplateExpressionClose = (source: string, start: number) => {
  let quote: '"' | "'" | null = null
  let escaped = false
  for (let index = start; index < source.length - 1; index += 1) {
    const character = source[index]
    if (quote) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === quote) quote = null
      continue
    }
    if (character === '"' || character === "'") quote = character
    else if (character === '}' && source[index + 1] === '}') return index
  }
  return -1
}

export const renderNoteTemplate = (
  source: string,
  variables: NoteTemplateVariables,
  now: Date,
): NoteTemplateResult<string> => {
  if (source.length > NOTE_TEMPLATE_LIMITS.templateLength) {
    return fail('TEMPLATE_TOO_LONG', `模板最多包含 ${NOTE_TEMPLATE_LIMITS.templateLength} 个字符`, NOTE_TEMPLATE_LIMITS.templateLength)
  }

  let output = ''
  let position = 0
  while (position < source.length) {
    if (source.startsWith('\\\\', position)) {
      output += '\\'
      position += 2
      continue
    }
    if (source.startsWith('\\{{', position)) {
      output += '{{'
      position += 3
      continue
    }
    if (!source.startsWith('{{', position)) {
      output += source[position]
      position += 1
      continue
    }

    const expressionStart = position + 2
    const close = findTemplateExpressionClose(source, expressionStart)
    if (close < 0) return fail('UNTERMINATED_EXPRESSION', '模板表达式缺少结束标记', position)
    const result = evaluateNoteTemplateExpression(source.slice(expressionStart, close), variables, now)
    if (result.ok === false) {
      return fail(result.error.code, result.error.message, expressionStart + result.error.position)
    }
    output += String(result.value)
    if (output.length > NOTE_TEMPLATE_LIMITS.renderLength) {
      return fail('RENDER_TOO_LONG', `模板渲染结果最多包含 ${NOTE_TEMPLATE_LIMITS.renderLength} 个字符`, position)
    }
    position = close + 2
  }
  if (output.length > NOTE_TEMPLATE_LIMITS.renderLength) {
    return fail('RENDER_TOO_LONG', `模板渲染结果最多包含 ${NOTE_TEMPLATE_LIMITS.renderLength} 个字符`, source.length)
  }
  return { ok: true, value: output }
}

const variableValueMatchesType = (value: NoteTemplateValue, type: NoteTemplateVariable['type']) =>
  typeof value === type && (type !== 'number' || isValidNumber(value))

const asObject = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null

const NOTE_TEMPLATE_INPUT_KEYS = new Set(['name', 'fileNameTemplate', 'contentTemplate', 'variables'])
const NOTE_TEMPLATE_VARIABLE_KEYS = new Set(['id', 'name', 'type', 'value', 'afterUseExpression'])
const NOTE_TEMPLATE_KEYS = new Set([...NOTE_TEMPLATE_INPUT_KEYS, 'id', 'createdAt', 'updatedAt'])

export const normalizeNoteTemplateInput = (
  value: unknown,
  validationDate = new Date(2000, 0, 1),
): NoteTemplateResult<NoteTemplateInput> => {
  const input = asObject(value)
  if (!input) return fail('INVALID_TEMPLATE', '模板数据必须是对象', 0)
  const unknownInputKey = Object.keys(input).find(key => !NOTE_TEMPLATE_INPUT_KEYS.has(key))
  if (unknownInputKey) return fail('UNKNOWN_INPUT', `未知模板字段“${unknownInputKey}”`, 0)
  if (typeof input.name !== 'string' || input.name.trim().length === 0) {
    return fail('INVALID_TEMPLATE', '模板名不能为空', 0)
  }
  if (input.name.trim().length > NOTE_TEMPLATE_LIMITS.nameLength) {
    return fail('INVALID_TEMPLATE', `模板名最多包含 ${NOTE_TEMPLATE_LIMITS.nameLength} 个字符`, NOTE_TEMPLATE_LIMITS.nameLength)
  }
  if (typeof input.fileNameTemplate !== 'string' || input.fileNameTemplate.length === 0) {
    return fail('INVALID_TEMPLATE', '文件名模板不能为空', 0)
  }
  if (input.fileNameTemplate.length > NOTE_TEMPLATE_LIMITS.filenameTemplateLength) {
    return fail('INVALID_TEMPLATE', `文件名模板最多包含 ${NOTE_TEMPLATE_LIMITS.filenameTemplateLength} 个字符`, NOTE_TEMPLATE_LIMITS.filenameTemplateLength)
  }
  if (typeof input.contentTemplate !== 'string') {
    return fail('INVALID_TEMPLATE', '文件内容模板必须是字符串', 0)
  }
  if (input.contentTemplate.length > NOTE_TEMPLATE_LIMITS.templateLength) {
    return fail('TEMPLATE_TOO_LONG', `模板最多包含 ${NOTE_TEMPLATE_LIMITS.templateLength} 个字符`, NOTE_TEMPLATE_LIMITS.templateLength)
  }
  if (!Array.isArray(input.variables)) return fail('INVALID_TEMPLATE', '模板变量必须是数组', 0)
  if (input.variables.length > NOTE_TEMPLATE_LIMITS.variables) {
    return fail('TOO_MANY_VARIABLES', `模板最多定义 ${NOTE_TEMPLATE_LIMITS.variables} 个变量`, NOTE_TEMPLATE_LIMITS.variables)
  }

  const variables: NoteTemplateVariable[] = []
  const ids = new Set<string>()
  const names = new Set<string>()
  for (let index = 0; index < input.variables.length; index += 1) {
    const raw = asObject(input.variables[index])
    const unknownVariableKey = raw && Object.keys(raw).find(key => !NOTE_TEMPLATE_VARIABLE_KEYS.has(key))
    if (unknownVariableKey) return fail('UNKNOWN_INPUT', `未知变量字段“${unknownVariableKey}”`, index)
    const id = typeof raw?.id === 'string' ? raw.id.trim() : ''
    const name = typeof raw?.name === 'string' ? raw.name.trim() : ''
    const type = raw?.type
    const afterUseExpression = raw?.afterUseExpression === undefined ? '' : raw.afterUseExpression
    if (!id
      || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
      || ['now', 'upper', 'lower', 'trim', 'pad', 'replace'].includes(name)
      || name.length > NOTE_TEMPLATE_LIMITS.variableNameLength
      || (type !== 'string' && type !== 'number' && type !== 'boolean')
      || typeof afterUseExpression !== 'string'
      || !variableValueMatchesType(raw?.value as NoteTemplateValue, type)) {
      return fail('INVALID_VARIABLE', `第 ${index + 1} 个变量无效`, index)
    }
    if (ids.has(id)) return fail('INVALID_VARIABLE', `变量 ID“${id}”重复`, index)
    if (names.has(name)) return fail('INVALID_VARIABLE', `变量“${name}”重复`, index)
    ids.add(id)
    names.add(name)
    variables.push({ id, name, type, value: raw!.value as NoteTemplateValue, afterUseExpression })
  }

  const normalized: NoteTemplateInput = {
    name: input.name.trim(),
    fileNameTemplate: input.fileNameTemplate,
    contentTemplate: input.contentTemplate,
    variables,
  }
  const runtime = getNoteTemplateRuntimeVariables(variables)
  const content = renderNoteTemplate(normalized.contentTemplate, runtime, validationDate)
  if (content.ok === false) return content
  const renderedFilename = renderNoteTemplate(normalized.fileNameTemplate, runtime, validationDate)
  if (renderedFilename.ok === false) return renderedFilename
  const filename = normalizeMarkdownFilename(renderedFilename.value)
  if (filename.ok === false) return filename
  const afterUse = applyNoteTemplateAfterUse(variables, validationDate)
  if (afterUse.ok === false) return afterUse
  const nextRuntime = getNoteTemplateRuntimeVariables(afterUse.value)
  const nextContent = renderNoteTemplate(normalized.contentTemplate, nextRuntime, validationDate)
  if (nextContent.ok === false) return nextContent
  const nextRenderedFilename = renderNoteTemplate(normalized.fileNameTemplate, nextRuntime, validationDate)
  if (nextRenderedFilename.ok === false) return nextRenderedFilename
  const nextFilename = normalizeMarkdownFilename(nextRenderedFilename.value)
  if (nextFilename.ok === false) return nextFilename
  return { ok: true, value: normalized }
}

export const validateNoteTemplateInput = normalizeNoteTemplateInput

export const normalizeMarkdownFilename = (value: string): NoteTemplateResult<string> => {
  const filename = value.trim()
  if (filename.length === 0) return fail('INVALID_FILENAME', '文件名不能为空', 0)
  const invalidCharacterPosition = [...filename].findIndex(character =>
    character.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(character),
  )
  if (invalidCharacterPosition >= 0) {
    return fail('INVALID_FILENAME', '文件名包含跨平台不允许的字符', invalidCharacterPosition)
  }
  if (filename === '.' || filename === '..') return fail('INVALID_FILENAME', '文件名不能是“.”或“..”', 0)
  if (/[. ]$/.test(filename)) return fail('INVALID_FILENAME', '文件名不能以句点或空格结尾', filename.length - 1)

  const lower = filename.toLowerCase()
  const lastDot = filename.lastIndexOf('.')
  if (lastDot >= 0 && !lower.endsWith('.md')) {
    return fail('INVALID_FILENAME', '仅支持 .md 文件扩展名', lastDot)
  }
  const basename = lower.endsWith('.md') ? filename.slice(0, -3) : filename
  if (basename.length === 0) return fail('INVALID_FILENAME', '文件名不能只有扩展名', 0)
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(basename)) {
    return fail('INVALID_FILENAME', `“${basename}”是 Windows 保留文件名`, 0)
  }
  const normalized = `${basename}.md`
  if (normalized.length > NOTE_TEMPLATE_LIMITS.filenameLength) {
    return fail('INVALID_FILENAME', `文件名最多包含 ${NOTE_TEMPLATE_LIMITS.filenameLength} 个字符`, NOTE_TEMPLATE_LIMITS.filenameLength)
  }
  return { ok: true, value: normalized }
}

export const getNoteTemplateRuntimeVariables = (
  variables: NoteTemplateVariable[],
): NoteTemplateRuntimeVariables => Object.fromEntries(
  variables.map(variable => [variable.name, variable.value]),
)

export const applyNoteTemplateAfterUse = (
  variables: NoteTemplateVariable[],
  now: Date,
): NoteTemplateResult<NoteTemplateVariable[]> => {
  const snapshot = Object.freeze({ ...getNoteTemplateRuntimeVariables(variables) })
  const next = [...variables]

  for (let index = 0; index < variables.length; index += 1) {
    const variable = variables[index]
    if (!variable.afterUseExpression.trim()) continue
    const result = evaluateNoteTemplateExpression(variable.afterUseExpression, snapshot, now)
    if (result.ok === false) return result
    if (!variableValueMatchesType(result.value, variable.type)) {
      const typeName = variable.type === 'string' ? '字符串' : variable.type === 'number' ? '数字' : '布尔值'
      return fail('VARIABLE_TYPE_MISMATCH', `变量“${variable.name}”的使用后结果必须是${typeName}`, index)
    }
    next[index] = { ...variable, value: result.value }
  }
  return { ok: true, value: next }
}

export const evaluateNoteTemplateAfterUse = applyNoteTemplateAfterUse
export const evaluateNoteTemplateVariablesAfterUse = applyNoteTemplateAfterUse

export const validateNoteTemplate = (value: unknown): NoteTemplateResult<NoteTemplate> => {
  const template = asObject(value)
  if (!template) return fail('INVALID_TEMPLATE', '模板必须是对象', 0)
  const unknownTemplateKey = Object.keys(template).find(key => !NOTE_TEMPLATE_KEYS.has(key))
  if (unknownTemplateKey) return fail('UNKNOWN_INPUT', `未知模板字段“${unknownTemplateKey}”`, 0)
  if (typeof template.id !== 'string' || template.id.trim().length === 0) {
    return fail('INVALID_TEMPLATE', '模板 ID 不能为空', 0)
  }
  if (typeof template.createdAt !== 'number' || !Number.isFinite(template.createdAt)
    || typeof template.updatedAt !== 'number' || !Number.isFinite(template.updatedAt)) {
    return fail('INVALID_TEMPLATE', '模板时间戳必须是有限数字', 0)
  }
  const input = normalizeNoteTemplateInput({
    name: template.name,
    fileNameTemplate: template.fileNameTemplate,
    contentTemplate: template.contentTemplate,
    variables: template.variables,
  })
  if (input.ok === false) return input
  return { ok: true, value: value as NoteTemplate }
}

export type RenderedNoteTemplate = {
  filename: string
  content: string
  nextVariables: NoteTemplateVariable[]
}

export const renderNoteTemplateInstance = (
  template: NoteTemplate,
  now: Date,
): NoteTemplateResult<RenderedNoteTemplate> => {
  const validTemplate = validateNoteTemplate(template)
  if (validTemplate.ok === false) return validTemplate
  const variables = getNoteTemplateRuntimeVariables(template.variables)
  const content = renderNoteTemplate(template.contentTemplate, variables, now)
  if (content.ok === false) return content
  const renderedFilename = renderNoteTemplate(template.fileNameTemplate, variables, now)
  if (renderedFilename.ok === false) return renderedFilename
  const filename = normalizeMarkdownFilename(renderedFilename.value)
  if (filename.ok === false) return filename
  const nextVariables = applyNoteTemplateAfterUse(template.variables, now)
  if (nextVariables.ok === false) return nextVariables
  const nextState = normalizeNoteTemplateInput({
    name: template.name,
    fileNameTemplate: template.fileNameTemplate,
    contentTemplate: template.contentTemplate,
    variables: nextVariables.value,
  }, now)
  if (nextState.ok === false) return nextState
  return {
    ok: true,
    value: { filename: filename.value, content: content.value, nextVariables: nextState.value.variables },
  }
}
