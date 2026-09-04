import { describe, expect, it } from 'vitest'
import {
  NOTE_TEMPLATE_LIMITS,
  applyNoteTemplateAfterUse,
  evaluateNoteTemplateExpression,
  normalizeMarkdownFilename,
  normalizeNoteTemplateInput,
  renderNoteTemplate,
  renderNoteTemplateInstance,
  validateNoteTemplate,
  validateNoteTemplateInput,
  type NoteTemplate,
} from '../note-template'

describe('note template expressions', () => {
  it('renders variables, literals, and arithmetic without executing JavaScript', () => {
    const variables = { title: 'Looma', count: 3, enabled: true }

    expect(evaluateNoteTemplateExpression('count * 2 + 1', variables)).toEqual({
      ok: true,
      value: 7,
    })
    expect(renderNoteTemplate(
      '# {{ title }} {{ enabled ? count + 1 : 0 }}',
      variables,
      new Date(2026, 8, 3, 1, 2, 3),
    )).toEqual({ ok: true, value: '# Looma 4' })
    expect(renderNoteTemplate(
      '{{ replace("a}}b", "}}", "-") }}',
      variables,
      new Date(2026, 8, 3, 1, 2, 3),
    )).toEqual({ ok: true, value: 'a-b' })
  })

  it('supports the complete operator grammar with precedence, parentheses, and short-circuiting', () => {
    const variables = { a: 10, b: 3, text: 'x', yes: true }

    expect(evaluateNoteTemplateExpression('-(a % b) + 5 * 2 / 2', variables)).toEqual({ ok: true, value: 4 })
    expect(evaluateNoteTemplateExpression('a >= 10 && b < 4 && !false', variables)).toEqual({ ok: true, value: true })
    expect(evaluateNoteTemplateExpression('a === 10 && text !== "y"', variables)).toEqual({ ok: true, value: true })
    expect(evaluateNoteTemplateExpression('false && missing', variables)).toEqual({ ok: true, value: false })
    expect(evaluateNoteTemplateExpression('yes ? "chosen" : missing', variables)).toEqual({ ok: true, value: 'chosen' })
    expect(evaluateNoteTemplateExpression('1 + 2 * 3 === 7 || false', variables)).toEqual({ ok: true, value: true })
    expect(evaluateNoteTemplateExpression('"alpha" < "beta"', variables)).toEqual({ ok: true, value: true })
  })

  it('only calls built-in string helpers and uses the supplied Date', () => {
    const now = new Date(2026, 8, 3, 1, 2, 3)
    const variables = { title: '  Looma  ', n: 7 }

    expect(renderNoteTemplate(
      '{{ upper(trim(title)) }} {{ lower("ABC") }} {{ pad(n, 3, "0") }} {{ replace("a-b-a", "a", "x") }} {{ now("YYYY-MM-DD HH:mm:ss") }} {{ now("YY M D H m s") }} {{ now("ddd dddd E") }}',
      variables,
      now,
    )).toEqual({ ok: true, value: 'LOOMA abc 007 x-b-a 2026-09-03 01:02:03 26 9 3 1 2 3 周四 星期四 4' })
    expect(renderNoteTemplate('{{ now("ddd E") }}', {}, new Date(2026, 8, 6)))
      .toEqual({ ok: true, value: '周日 7' })
  })

  it('returns stable errors with source positions for unsafe or invalid syntax', () => {
    expect(evaluateNoteTemplateExpression('unknown + 1', {})).toEqual({
      ok: false,
      error: {
        code: 'UNKNOWN_VARIABLE',
        message: '未知变量“unknown”',
        position: 0,
      },
    })
    expect(evaluateNoteTemplateExpression('globalThis.process', {})).toMatchObject({
      ok: false,
      error: { code: 'INVALID_TOKEN', position: 10 },
    })
    expect(evaluateNoteTemplateExpression('danger()', {})).toMatchObject({
      ok: false,
      error: { code: 'UNKNOWN_FUNCTION', position: 0 },
    })
  })

  it('leaves escaped expression openers literal and reports unterminated expressions', () => {
    const now = new Date(2026, 8, 3, 1, 2, 3)

    expect(renderNoteTemplate('literal: \\{{ title }}; value: {{ title }}', { title: 'ok' }, now))
      .toEqual({ ok: true, value: 'literal: {{ title }}; value: ok' })
    expect(renderNoteTemplate('slash: \\\\; literal: \\{{', {}, now))
      .toEqual({ ok: true, value: 'slash: \\; literal: {{' })
    expect(renderNoteTemplate('before {{ title', { title: 'ok' }, now)).toMatchObject({
      ok: false,
      error: { code: 'UNTERMINATED_EXPRESSION', position: 7 },
    })
  })

  it('evaluates all after-use expressions against one old-value snapshot', () => {
    const definitions = [
      { id: 'a', name: 'a', type: 'number' as const, value: 1, afterUseExpression: 'b + 1' },
      { id: 'b', name: 'b', type: 'number' as const, value: 10, afterUseExpression: 'a + 1' },
      { id: 'label', name: 'label', type: 'string' as const, value: 'kept', afterUseExpression: '' },
    ]

    expect(applyNoteTemplateAfterUse(definitions, new Date(0))).toEqual({
      ok: true,
      value: [
        { ...definitions[0], value: 11 },
        { ...definitions[1], value: 2 },
        definitions[2],
      ],
    })
  })

  it('normalizes safe Markdown filenames and rejects cross-platform hazards', () => {
    expect(normalizeMarkdownFilename(' Daily Note ')).toEqual({ ok: true, value: 'Daily Note.md' })
    expect(normalizeMarkdownFilename('report.MD')).toEqual({ ok: true, value: 'report.md' })
    expect(normalizeMarkdownFilename('bad/name')).toEqual({
      ok: false,
      error: { code: 'INVALID_FILENAME', message: '文件名包含跨平台不允许的字符', position: 3 },
    })

    for (const filename of ['note.txt', '../note', 'folder/note', 'folder\\note', '.', '..', '.md', '\0bad', 'CON', 'CON.foo.md', 'aux.md', 'LPT9.md', 'bad. ']) {
      expect(normalizeMarkdownFilename(filename), filename).toMatchObject({
        ok: false,
        error: { code: 'INVALID_FILENAME' },
      })
    }
  })

  it('validates template structure and renders content, filename, and next values with one Date', () => {
    const template: NoteTemplate = {
      id: 'daily',
      name: 'Daily note',
      fileNameTemplate: '{{ now("YYYY-MM-DD") }}-{{ slug }}',
      contentTemplate: '# {{ title }}\nCreated {{ now("YYYY-MM-DD HH:mm:ss") }}',
      variables: [
        { id: 'title', name: 'title', type: 'string', value: 'Plan', afterUseExpression: '' },
        { id: 'slug', name: 'slug', type: 'string', value: 'WEEK', afterUseExpression: 'lower(slug)' },
      ],
      createdAt: 1,
      updatedAt: 1,
    }
    const now = new Date(2026, 8, 3, 1, 2, 3)

    expect(validateNoteTemplate(template)).toEqual({ ok: true, value: template })
    expect(validateNoteTemplate({ ...template, unexpected: true }))
      .toMatchObject({ ok: false, error: { code: 'UNKNOWN_INPUT' } })
    expect(renderNoteTemplateInstance(template, now)).toEqual({
      ok: true,
      value: {
        filename: '2026-09-03-WEEK.md',
        content: '# Plan\nCreated 2026-09-03 01:02:03',
        nextVariables: [
          template.variables[0],
          { ...template.variables[1], value: 'week' },
        ],
      },
    })
  })

  it('rejects an after-use state that would make the next filename invalid', () => {
    const template: NoteTemplate = {
      id: 'stateful',
      name: 'Stateful note',
      fileNameTemplate: '{{ slug }}',
      contentTemplate: '',
      variables: [
        { id: 'slug', name: 'slug', type: 'string', value: 'safe', afterUseExpression: '"/"' },
      ],
      createdAt: 1,
      updatedAt: 1,
    }

    expect(renderNoteTemplateInstance(template, new Date(0))).toMatchObject({
      ok: false,
      error: { code: 'INVALID_FILENAME' },
    })
    expect(validateNoteTemplateInput({
      name: template.name,
      fileNameTemplate: template.fileNameTemplate,
      contentTemplate: template.contentTemplate,
      variables: template.variables,
    })).toMatchObject({ ok: false, error: { code: 'INVALID_FILENAME' } })
  })

  it('rejects a candidate state whose following after-use result has the wrong type', () => {
    const template: NoteTemplate = {
      id: 'conditional-state',
      name: 'Conditional state',
      fileNameTemplate: 'safe.md',
      contentTemplate: '{{ count }}',
      variables: [{
        id: 'count',
        name: 'count',
        type: 'number',
        value: 1,
        afterUseExpression: 'count === 1 ? 2 : "bad"',
      }],
      createdAt: 1,
      updatedAt: 1,
    }

    expect(renderNoteTemplateInstance(template, new Date(0))).toMatchObject({
      ok: false,
      error: { code: 'VARIABLE_TYPE_MISMATCH' },
    })
  })

  it('normalizes and validates canonical template inputs', () => {
    const input = {
      name: '  Daily  ',
      fileNameTemplate: 'daily',
      contentTemplate: '# Daily',
      variables: [{ id: 'title', name: 'title', type: 'string', value: 'x', afterUseExpression: '' }],
    }

    expect(normalizeNoteTemplateInput(input)).toEqual({
      ok: true,
      value: { ...input, name: 'Daily' },
    })
    expect(validateNoteTemplateInput({ ...input, variables: [{ ...input.variables[0], name: 'bad.name' }] }))
      .toMatchObject({ ok: false, error: { code: 'INVALID_VARIABLE', position: 0 } })
    expect(validateNoteTemplateInput({ ...input, variables: [{ ...input.variables[0], name: 'upper' }] }))
      .toMatchObject({ ok: false, error: { code: 'INVALID_VARIABLE', position: 0 } })
    expect(validateNoteTemplateInput({ ...input, unexpected: true }))
      .toMatchObject({ ok: false, error: { code: 'UNKNOWN_INPUT' } })
    expect(validateNoteTemplateInput({
      ...input,
      variables: [{ ...input.variables[0], unexpected: true }],
    })).toMatchObject({ ok: false, error: { code: 'UNKNOWN_INPUT', position: 0 } })
  })

  it('enforces deterministic validation limits and variable result types', () => {
    expect(evaluateNoteTemplateExpression('1'.repeat(NOTE_TEMPLATE_LIMITS.expressionLength + 1), {})).toMatchObject({
      ok: false,
      error: { code: 'EXPRESSION_TOO_LONG', position: NOTE_TEMPLATE_LIMITS.expressionLength },
    })
    expect(evaluateNoteTemplateExpression('9007199254740991 + 1', {})).toMatchObject({
      ok: false,
      error: { code: 'TYPE_ERROR' },
    })
    expect(evaluateNoteTemplateExpression('pad("x", 3, "ab")', {})).toMatchObject({
      ok: false,
      error: { code: 'INVALID_ARGUMENT' },
    })
    expect(evaluateNoteTemplateExpression(Array(140).fill('1').join('+'), {})).toMatchObject({
      ok: false,
      error: { code: 'EVALUATION_LIMIT' },
    })
    expect(renderNoteTemplate(
      Array(106).fill('{{ pad("x", 10000, "0") }}').join(''),
      {},
      new Date(0),
    )).toMatchObject({ ok: false, error: { code: 'RENDER_TOO_LONG' } })
    expect(renderNoteTemplate(
      `{{ value }}${'x'.repeat(NOTE_TEMPLATE_LIMITS.renderLength - 50)}`,
      { value: 'y'.repeat(100) },
      new Date(0),
    )).toMatchObject({ ok: false, error: { code: 'RENDER_TOO_LONG' } })
    expect(applyNoteTemplateAfterUse(
      [{ id: 'count', name: 'count', type: 'number', value: 0, afterUseExpression: '"wrong"' }],
      new Date(0),
    )).toMatchObject({ ok: false, error: { code: 'VARIABLE_TYPE_MISMATCH', position: 0 } })
    expect(validateNoteTemplate({
      id: 'x',
      name: 'x',
      fileNameTemplate: 'x',
      contentTemplate: 'x'.repeat(NOTE_TEMPLATE_LIMITS.templateLength + 1),
      variables: [],
      createdAt: 1,
      updatedAt: 1,
    })).toMatchObject({ ok: false, error: { code: 'TEMPLATE_TOO_LONG' } })
  })
})
