// Applies vault-tree results in the order the requests were issued.
//
// Several things ask the main process for the tree at the same time: our own
// refresh after a create/rename/move, the file watcher, the cached and fast tree
// at startup, the idle full scan. Their answers can arrive in any order. Without
// a guard a slow request that started BEFORE a new folder was created can
// resolve after the refresh that already shows it and put the old tree back.
//
// A result is applied only if no request issued later has already been applied.

export function createTreeSync(apply) {
  let issued = 0
  let applied = 0
  return {
    /** Take a ticket right before asking for a tree. */
    begin() {
      issued += 1
      return issued
    },
    /** True when this ticket's tree is still the newest one and was applied. */
    accept(ticket, tree) {
      if (ticket <= applied) return false
      applied = ticket
      apply(tree)
      return true
    },
    /** Ask for a tree via load(); apply it unless a later request already won. */
    async request(load) {
      const ticket = this.begin()
      const tree = await load()
      return { tree, applied: this.accept(ticket, tree) }
    },
  }
}
