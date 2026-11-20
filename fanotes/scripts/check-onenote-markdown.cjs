'use strict'

// OneNote page HTML (one2html style) -> clean Markdown: headings, lists, checkboxes, tables, links, math.

const assert = require('node:assert/strict')
const { convertOneNotePage } = require('../electron/onenote-convert.cjs')
const { page, paragraph } = require('./fixtures/onenote/synthetic.cjs')

const convert = (body, title = 'Seite') => convertOneNotePage(page({ title, body }))

const box = (checked) => `<span aria-checked="${checked}" class="note-tag-icon icon-0 -checkbox -large" role="checkbox"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="none" d="M0 0h24v24H0z"/><path d="M4 3h16v18H4z"/></svg></span>`
const body = [
  `<div class="outline-element" style="margin-left: 0px;"><h1 style="font-size: 16pt;">Überschrift</h1></div>`,
  `<div class="outline-element" style="margin-left: 0px;"><h2 style="font-size: 14pt;">Unterpunkt</h2></div>`,
  paragraph('<strong>fett</strong> <em>kursiv</em> <span style="text-decoration: line-through;">weg</span> <a href="https://example.com/x">Link</a> <a href="javascript:alert(1)">böse</a>'),
  paragraph('snake_case_name und 2 * 3 * 4 und $5 und $6 und [eckig](x)'),
  paragraph('# kein Titel'),
  `<ul class="tagged-list"><li class="outline-element" style="margin-left: 36px;"><span>${box(false)}offen</span></li><li class="outline-element" style="margin-left: 36px;"><span>${box(true)}erledigt</span></li></ul>`,
  `<ul class="list-0"><li class="outline-element"><span>eins</span><ul class="list-1"><li class="outline-element"><span>zwei</span></li></ul></li></ul>`,
  `<ol class="list-3"><li class="outline-element"><span>a</span><ol class="list-4"><li class="outline-element"><span>b</span></li></ol></li><li class="outline-element"><span>c</span></li></ol>`,
  `<div class="outline-element"><table><tr><td><div class="outline-element"><p>H1</p></div></td><td><div class="outline-element"><p>H|2</p></div></td></tr><tr><td><div class="outline-element"><p>x</p></div></td><td><div class="outline-element"><p>y</p></div></td></tr></table></div>`,
  paragraph('<math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><mfrac><mi>𝑎</mi><mn>2</mn></mfrac><mo>=</mo><msup><mi>𝑏</mi><mn>2</mn></msup></math>'),
  paragraph('<span style="font-family: Consolas;">code()</span>'),
  paragraph('Zeile<br>zwei'),
].join('')

const result = convert(body, 'Titel_mit_Unterstrich')
const md = result.markdown

assert.match(md, /^# Titel\\_mit\\_Unterstrich\n/u, 'the title becomes the only H1')
assert.match(md, /^## Überschrift$/mu, 'OneNote heading 1 is an H2 below the page title')
assert.match(md, /^### Unterpunkt$/mu)
assert.match(md, /\*\*fett\*\* \*kursiv\* ~~weg~~ \[Link\]\(https:\/\/example\.com\/x\)/u)
assert.doesNotMatch(md, /javascript:/u, 'unsafe link targets are dropped')
assert.match(md, /böse/u)
assert.match(md, /snake\\_case\\_name/u, 'paired underscores are escaped so they cannot turn into emphasis')
assert.match(md, /2 \\\* 3 \\\* 4/u)
assert.match(md, /\\\$5 und \\\$6/u)
assert.match(md, /\\\[eckig\\\]\(x\)/u)
assert.match(md, /^\\# kein Titel$/mu, 'a line that would become a heading is escaped')
assert.match(md, /^- \[ \] offen$/mu)
assert.match(md, /^- \[x\] erledigt$/mu)
assert.match(md, /^- eins\n {2}- zwei$/mu, 'nested bullet lists indent by two spaces')
assert.match(md, /^1\. a\n {3}1\. b\n2\. c$/mu, 'nested numbered lists indent by three spaces')
assert.match(md, /^\| H1 \| H\\\|2 \|\n\| --- \| --- \|\n\| x \| y \|$/mu, 'tables use a header row and escape pipes')
assert.match(md, /^\$\$\\frac\{a\}\{2\}=\{b\}\^\{2\}\$\$$/mu, 'MathML becomes LaTeX without math-italic letters')
assert.match(md, /^```\ncode\(\)\n```$/mu, 'a monospace-only paragraph becomes a code block')
assert.match(md, /Zeile {2}\nzwei/u)
assert.doesNotMatch(md, /<!--|fanotes-|<div|<span|<svg|<p[ >]/u, 'no markers or leftover markup')
assert.equal(result.stats.tables, 1)
assert.equal(result.stats.checkboxes, 2)
assert.equal(result.pageId, null)
assert.equal(result.createdAt, new Date(1603795643 * 1000).toISOString())

// Two containers are read top to bottom regardless of their order in the file.
const ordered = convertOneNotePage(page({ title: 'Reihenfolge', body: '' }).replace('</body>', `<div class="container-outline" style="left: 48px; position: absolute; top: 700px;">${paragraph('unten')}</div><div class="container-outline" style="left: 48px; position: absolute; top: 300px;">${paragraph('oben')}</div></body>`))
assert.ok(ordered.markdown.indexOf('oben') < ordered.markdown.indexOf('unten'))

// An empty page still yields its title and never throws.
assert.equal(convert('', 'Leer').markdown.trim().startsWith('# Leer'), true)
console.log('OneNote-Markdown geprüft: Überschriften, Listen, Aufgaben, Tabellen, Links, Formeln, Escapes und Reihenfolge.')
