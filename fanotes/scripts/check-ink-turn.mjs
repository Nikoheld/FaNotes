import assert from 'node:assert/strict'

const { inkQuickTurnKeep } = await import('../src/lib/inkTurn.ts')

const keep = (coords, nib = 6) => inkQuickTurnKeep(coords.map(([x, y]) => ({ x, y })), 1, 1, nib)

const hook = [
  [0, 0],
  [30, 0],
  [60, 0],
  [62, 2],
  [62, 4],
  [60, 5],
  [58, 4],
  [58, 2],
]
assert.equal(keep(hook), 2, 'a lift hook inside the nib is left out')
assert.equal(keep(hook.slice(0, 3)), 2, 'trimming again does not eat the stroke')

assert.equal(keep([[0, 0], [120, 0], [120, 80]]), 2, 'a long corner stays')
assert.equal(keep([[0, 0], [20, 0], [22, 0], [24, 0], [26, 0]]), 4, 'a slow finish in the same direction stays')
assert.equal(keep([[1, 1]]), 0, 'a tap stays a dot')
assert.equal(keep([[0, 0], [10, 0]]), 1, 'a short dash stays')
assert.equal(keep([[0, 0], [30, 0], [30, 0]]), 1, 'a coincident lift sample is left out')

const turn = [[0, 0], [30, 0]]
for (let step = 1; step <= 8; step += 1) {
  const angle = (step / 8) * (Math.PI / 2)
  turn.push([30 + Math.sin(angle) * 16, (1 - Math.cos(angle)) * 16])
}
assert.equal(keep(turn), turn.length - 1, 'a quick turn that leaves the nib stays')

console.log('ink turn ok')
