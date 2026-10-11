import { describe, expect, it } from 'vitest'
import { parseConstants, parseIntegerExpression, parseToggleStates } from '../scripts/pokered-parse'

describe('pokered source constant semantics', () => {
  it.each([
    ['$F0 - 2', 238], ['($F0 - 2) + 3', 241], ['16 + (3 - 2)', 17], ['-2 + 5', 3],
  ])('evaluates the complete supported integer expression %s', (source, expected) => expect(parseIntegerExpression(source)).toBe(expected))
  it('honors arithmetic next/skip and explicit const increments', () => {
    expect(parseConstants('const_def $10, 2\nconst FIRST\nconst_skip (2 + 1)\nconst SECOND\nconst_next $20 - 2\nconst THIRD\n')).toEqual({ FIRST: 16, SECOND: 24, THIRD: 30 })
  })
  it.each(['$F0 * 2', '$F0 / 2', '$F0 - SYMBOL', '$F0 -', '12 garbage', '(12 + 2'])('fails unsupported or malformed meaningful expression %s', source => {
    expect(() => parseConstants(`const_next ${source}\nconst RESULT`)).toThrow(/expression/i)
  })
  it('skips macro definitions rather than interpreting parameter templates', () => {
    expect(parseConstants('MACRO const_example\nconst_def \\1\nconst \\2\nENDM\nconst_def 1\nconst FIRST')).toEqual({ FIRST: 1 })
  })
})
describe('toggle source ordinals', () => {
  it('keeps hexadecimal and decimal literal object rows plus raw map operands', () => {
    expect(parseToggleStates('toggleable_objects_for UNUSED_MAP_F4\ntoggle_object_state $02, ON\ntoggleable_objects_for $F5\ntoggle_object_state 3, OFF\ntoggleable_objects_for CAVE\ntoggle_object_state CAVE_ITEM, ON')).toEqual([
      { map: 'UNUSED_MAP_F4', object: '$02', state: 'ON' },
      { map: '$F5', object: '3', state: 'OFF' },
      { map: 'CAVE', object: 'CAVE_ITEM', state: 'ON' },
    ])
  })
  it('rejects a malformed object operand rather than dropping an ordinal', () => {
    expect(() => parseToggleStates('toggleable_objects_for CAVE\ntoggle_object_state $02 garbage, ON')).toThrow(/toggle/i)
  })
})
