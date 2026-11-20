export type TreeSync<T> = {
  begin(): number
  accept(ticket: number, tree: T): boolean
  request(load: () => Promise<T>): Promise<{ tree: T; applied: boolean }>
}

export function createTreeSync<T>(apply: (tree: T) => void): TreeSync<T>
