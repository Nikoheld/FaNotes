declare module 'nerdamer/all.min' {
  import nerdamer = require('nerdamer')
  const nerdamerAll: typeof nerdamer & {
    solveEquations(equation: string | string[], variable?: string): nerdamer.Expression[]
  }
  export = nerdamerAll
}
