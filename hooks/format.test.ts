import { test, expect, describe } from 'claude-code/testing'
import { GLYPHS, STATUS_WORD, STATUS_COLOR, fmtElapsed, fmtTokens, fit, padLeft } from './format'

describe('glyphs', () => {
  test('ascii set has no character above U+007F', async () => {
    const g = GLYPHS.ascii
    const all = [...Object.values(g.status), g.tee, g.elbow, g.pipe, g.blank, g.arrow, g.chip, g.group].join('')
    expect([...all].every(c => c.charCodeAt(0) < 0x80)).toBe(true)
  })
  test('unicode set uses box drawing for connectors', async () => {
    expect(GLYPHS.unicode.tee).toBe('├─')
    expect(GLYPHS.unicode.elbow).toBe('└─')
    expect(GLYPHS.unicode.pipe).toBe('│ ')
    expect(GLYPHS.unicode.blank).toBe('  ')
    expect(GLYPHS.unicode.arrow).toBe('→')
  })
  test('every status has a glyph, a word and a color in both sets', async () => {
    for (const st of ['pending', 'running', 'waiting', 'idle', 'completed', 'failed', 'killed'] as const) {
      expect(GLYPHS.unicode.status[st]).toHaveLength(1)
      expect(GLYPHS.ascii.status[st]).toHaveLength(1)
      expect(typeof STATUS_WORD[st]).toBe('string')
      expect(typeof STATUS_COLOR[st].color).toBe('string')
    }
    expect(STATUS_WORD.completed).toBe('done')
    expect(STATUS_COLOR.failed.color).toBe('error')
    expect(STATUS_COLOR.running.color).toBe('claude')
  })
})

describe('formatting', () => {
  test('fmtElapsed', async () => {
    expect(fmtElapsed(0)).toBe('0s')
    expect(fmtElapsed(12_400)).toBe('12s')
    expect(fmtElapsed(62_000)).toBe('1m02s')
    expect(fmtElapsed(3_780_000)).toBe('1h03m')
    expect(fmtElapsed(-5)).toBe('0s')
  })
  test('fmtTokens', async () => {
    expect(fmtTokens(0)).toBe('0')
    expect(fmtTokens(999)).toBe('999')
    expect(fmtTokens(4_120)).toBe('4.1k')
    expect(fmtTokens(12_400)).toBe('12.4k')
    expect(fmtTokens(1_250_000)).toBe('1.3M')
  })
  test('fit pads and truncates', async () => {
    expect(fit('ab', 4)).toBe('ab  ')
    expect(fit('abcdef', 4)).toBe('abc…')
    expect(fit('abcdef', 4, '~')).toBe('abc~')
    expect(fit('abcd', 4)).toBe('abcd')
    expect(fit('abc', 0)).toBe('')
  })
  test('padLeft', async () => {
    expect(padLeft('7', 3)).toBe('  7')
    expect(padLeft('1234', 3)).toBe('1234')
  })
})
