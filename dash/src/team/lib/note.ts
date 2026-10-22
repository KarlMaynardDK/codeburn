// The admin's registration note is plain text: blank lines split paragraphs and
// http(s) URLs become links. It is rendered as React text nodes, never as HTML.

export type NotePart = { text: string } | { href: string }

const URL_RE = /https?:\/\/[^\s<>"']+/g

/** Splits the note into paragraphs of text and link parts. Trailing punctuation stays out of links. */
export function noteToParagraphs(note: string): NotePart[][] {
  return note
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const parts: NotePart[] = []
      let last = 0
      for (const m of p.matchAll(URL_RE)) {
        const href = m[0].replace(/[.,;:!?)\]]+$/, '')
        const start = m.index!
        if (start > last) parts.push({ text: p.slice(last, start) })
        parts.push({ href })
        last = start + href.length
      }
      if (last < p.length) parts.push({ text: p.slice(last) })
      return parts
    })
}
