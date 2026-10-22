import { describe, expect, it } from 'vitest'
import { computeRange, dayCount, pctChange, previousRange } from './period'
import { csvField, toCsv } from './csv'
import { noteToParagraphs } from './note'

describe('csv', () => {
  it('quotes commas, quotes and newlines', () => {
    expect(csvField('a,b')).toBe('"a,b"')
    expect(csvField('say "hi"')).toBe('"say ""hi"""')
    expect(csvField('l1\nl2')).toBe('"l1\nl2"')
    expect(csvField(null)).toBe('')
    expect(csvField(1.5)).toBe('1.5')
  })
  it('neutralises formulas', () => {
    expect(csvField('=SUM(A1)')).toBe("'=SUM(A1)")
  })
  it('builds rows with CRLF', () => {
    expect(toCsv(['a', 'b'], [[1, 'x,y']])).toBe('a,b\r\n1,"x,y"\r\n')
  })
})

describe('period', () => {
  const now = new Date('2026-03-15T10:00:00Z')
  it('computes presets', () => {
    expect(computeRange('7d', now)).toEqual({ from: '2026-03-09', to: '2026-03-15' })
    expect(computeRange('30d', now)).toEqual({ from: '2026-02-14', to: '2026-03-15' })
    expect(computeRange('this-month', now)).toEqual({ from: '2026-03-01', to: '2026-03-15' })
    expect(computeRange('last-month', now)).toEqual({ from: '2026-02-01', to: '2026-02-28' })
  })
  it('handles January for last-month', () => {
    expect(computeRange('last-month', new Date('2026-01-10T00:00:00Z'))).toEqual({ from: '2025-12-01', to: '2025-12-31' })
  })
  it('normalises custom ranges', () => {
    expect(computeRange('custom', now, { from: '2026-03-05', to: '2026-03-01' })).toEqual({ from: '2026-03-01', to: '2026-03-05' })
  })
  it('computes the previous period of equal length', () => {
    const r = { from: '2026-03-09', to: '2026-03-15' }
    expect(dayCount(r)).toBe(7)
    expect(previousRange(r)).toEqual({ from: '2026-03-02', to: '2026-03-08' })
  })
  it('pctChange', () => {
    expect(pctChange(150, 100)).toBe(50)
    expect(pctChange(1, 0)).toBeNull()
  })
})

describe('noteToParagraphs', () => {
  it('splits on blank lines and links URLs without trailing punctuation', () => {
    expect(noteToParagraphs('Questions? Ask in #codeburn.\r\n\r\nDocs: https://wiki.example.com/cb. Thanks')).toEqual([
      [{ text: 'Questions? Ask in #codeburn.' }],
      [{ text: 'Docs: ' }, { href: 'https://wiki.example.com/cb' }, { text: '. Thanks' }],
    ])
  })

  it('keeps markup as plain text and ignores non-http schemes', () => {
    expect(noteToParagraphs('<b>hi</b> javascript:alert(1)')).toEqual([[{ text: '<b>hi</b> javascript:alert(1)' }]])
    expect(noteToParagraphs('  \n\n ')).toEqual([])
  })
})
