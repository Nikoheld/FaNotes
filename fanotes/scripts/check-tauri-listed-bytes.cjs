'use strict'

const assert = require('node:assert/strict')
const { listedBytes } = require('../src-tauri/src/fanotes-api.js')

assert.deepEqual([...listedBytes(new Uint8Array([4, 5]), 'x')], [4, 5])
assert.deepEqual(
  [...listedBytes([137.0, 1.5, 256, -1, '1e1', true, null], 'x')],
  [137, 1, 0, 255, 10, 1, 0],
)
assert.deepEqual([...listedBytes(Uint8Array.from([1, 2]).buffer, 'x')], [1, 2])
assert.deepEqual([...listedBytes([], 'x')], [])
assert.throws(() => listedBytes(9, 'Das Bild ist leer oder zu groß.'), /zu groß/u)
assert.throws(() => listedBytes({ length: 100_000_000 }, 'Das Bild ist leer oder zu groß.'), /zu groß/u)
assert.throws(() => listedBytes(9, 'Der Sync-Inhalt muss binär sein.'), /binär/u)
assert.throws(() => listedBytes(undefined, 'Das Bild ist leer oder zu groß.'), /zu groß/u)
console.log('listed-bytes: a number and a length object are refused')
