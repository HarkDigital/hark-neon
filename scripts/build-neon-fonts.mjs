// Convert single-stroke SVG fonts (EMS / Hershey, from the hersheytext
// package) into compact JSON for src/kit/type.ts — the centerlines neon tubes
// are bent along. Run once: node scripts/build-neon-fonts.mjs
//
// Output per font: { name, license, cap, glyphs: { ch: [advance, [x0,y0,x1,y1,…], …] } }
// Units: 1 = the font's measured cap height ('H'), y up, baseline 0.
import { readFileSync, writeFileSync } from 'node:fs'

const SRC = 'node_modules/hersheytext/svg_fonts'
const FONTS = {
  script: 'EMSAllure',
  sans: 'EMSReadability',
  display: 'EMSOsmotron',
}

const decode = s =>
  s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&apos;/g, "'")

for (const [key, file] of Object.entries(FONTS)) {
  const svg = readFileSync(`${SRC}/${file}.svg`, 'utf8')
  const name = svg.match(/font-family="([^"]+)"/)[1]
  const license = (svg.match(/License:\s*([^\n]+)/) || [, 'see hersheytext'])[1].trim()
  const defAdv = Number(svg.match(/<font [^>]*horiz-adv-x="([\d.]+)"/)[1])
  const glyphs = {}
  for (const m of svg.matchAll(/<glyph ([^>]*?)\/?>/g)) {
    const attrs = m[1]
    const uni = attrs.match(/unicode="([^"]*)"/)
    if (!uni) continue
    const ch = decode(uni[1])
    if (ch.length !== 1) continue
    const code = ch.codePointAt(0)
    // ASCII + the curly quotes / dashes / bullets the copy uses
    if (!(code >= 32 && code < 127) && !'‘’“”–—·•→↗'.includes(ch)) continue
    const adv = Number((attrs.match(/horiz-adv-x="([\d.]+)"/) || [, defAdv])[1])
    const d = (attrs.match(/ d="([^"]*)"/) || [, ''])[1]
    const strokes = []
    let cur = null
    const tok = d.trim().split(/\s+/)
    for (let i = 0; i < tok.length; ) {
      const t = tok[i]
      if (t === 'M') {
        cur = [Number(tok[i + 1]), Number(tok[i + 2])]
        strokes.push(cur)
        i += 3
      } else if (t === 'L') {
        cur.push(Number(tok[i + 1]), Number(tok[i + 2]))
        i += 3
      } else i++
    }
    glyphs[ch] = [adv, strokes.filter(s => s.length >= 4)]
  }
  // normalise to the measured cap height of 'H'
  const H = glyphs.H[1].flat()
  let top = -Infinity
  for (let i = 1; i < H.length; i += 2) top = Math.max(top, H[i])
  const cap = top
  const r = v => Math.round((v / cap) * 1000) / 1000
  const out = {}
  for (const [ch, [adv, strokes]] of Object.entries(glyphs)) out[ch] = [r(adv), strokes.map(s => s.map(r))]
  writeFileSync(`src/kit/fonts/${key}.json`, JSON.stringify({ name, license, glyphs: out }))
  console.log(key, name, Object.keys(out).length, 'glyphs, cap', cap)
}
