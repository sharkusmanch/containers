/** Small, explicit subset of RGBDS syntax used by the pinned factual inputs. */
export function parseIntegerExpression(source: string): number {
  const tokens: string[] = []; let offset = 0
  while (offset < source.length) {
    if (!source.slice(offset).trim()) break
    const match = source.slice(offset).match(/^\s*(\$[0-9a-fA-F]+|\d+|[()+-])/)
    if (!match) throw new Error(`Unsupported integer expression: ${source}`)
    tokens.push(match[1]!); offset += match[0].length
  }
  let position = 0
  const fail = (): never => { throw new Error(`Malformed integer expression: ${source}`) }
  function primary(): number {
    const token = tokens[position++]
    if (token === '+') return primary()
    if (token === '-') return -primary()
    if (token === '(') { const value = expression(); if (tokens[position++] !== ')') fail(); return value }
    if (!token || !/^(?:\$[0-9a-fA-F]+|\d+)$/.test(token)) return fail()
    return token.startsWith('$') ? parseInt(token.slice(1), 16) : Number(token)
  }
  function expression(): number {
    let value = primary()
    while (tokens[position] === '+' || tokens[position] === '-') {
      const op = tokens[position++]; const right = primary(); value = op === '+' ? value + right : value - right
    }
    return value
  }
  const value = expression()
  if (position !== tokens.length || !Number.isSafeInteger(value)) fail()
  return value
}
export function parseConstants(text: string): Record<string, number> {
  const values: Record<string, number> = {}; let index = 0; let increment = 1; let macro = false
  for (const raw of text.split('\n')) {
    const line = raw.split(';')[0]!.trim()
    if (/^MACRO\??(?:\s|$)/i.test(line)) { macro = true; continue }
    if (/^ENDM$/i.test(line)) { macro = false; continue }
    if (macro || !line) continue
    const match = line.match(/^(\w+)(?:\s+(.*))?$/)
    if (!match) continue
    const op = match[1]!; const args = match[2]?.trim() ?? ''
    if (op === 'const_def') {
      const parts = args ? args.split(',').map(s => s.trim()) : []
      if (parts.length > 2 || parts.some(s => !s)) throw new Error(`Malformed const_def expression: ${args}`)
      index = parts[0] ? parseIntegerExpression(parts[0]) : 0
      increment = parts[1] ? parseIntegerExpression(parts[1]) : 1
    } else if (op === 'const_next') {
      const next = parseIntegerExpression(args)
      if ((index > 0 && next < index) || (index < 0 && next > index)) throw new Error(`const_next cannot go backwards from ${index} to ${next}`)
      index = next
    } else if (op === 'const_skip') index += increment * (args ? parseIntegerExpression(args) : 1)
    else if (op === 'const' || op === 'const_export') {
      if (!/^\w+$/.test(args)) throw new Error(`Unsupported constant symbol: ${args}`)
      if (values[args] !== undefined) throw new Error(`Duplicate constant symbol: ${args}`)
      values[args] = index; index += increment
    }
    if (!Number.isSafeInteger(index)) throw new Error('Constant expression exceeds safe integer range')
  }
  return values
}
export interface ToggleState { map: string; object: string; state: 'ON' | 'OFF' }
export function parseToggleStates(text: string): ToggleState[] {
  let map = ''; const records: ToggleState[] = []
  const operand = (value: string) => /^(?:[A-Za-z_]\w*|\$[0-9a-fA-F]+|\d+)$/.test(value)
  for (const raw of text.split('\n')) {
    const line = raw.split(';')[0]!.trim()
    if (line.startsWith('toggleable_objects_for ')) {
      map = line.slice('toggleable_objects_for '.length).trim()
      if (!operand(map)) throw new Error(`Unsupported toggle map operand: ${map}`)
    } else if (/^toggle_object_state(?:\s|$)/.test(line)) {
      const parts = line.slice('toggle_object_state'.length).trim().split(',').map(s => s.trim())
      const object = parts[0] ?? ''; const state = parts[1]
      if (!map || parts.length !== 2 || !operand(object) || (state !== 'ON' && state !== 'OFF')) throw new Error(`Unsupported toggle state row: ${line}`)
      records.push({ map, object, state })
    }
  }
  return records
}
