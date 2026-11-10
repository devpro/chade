// Where a commit and the lines around it are drawn, in a history listed from the newest commit.
// A lane is a column a line of history runs down, from a commit to its parent.
export interface GraphRow {
  // Lane of the commit.
  column: number
  // Lanes that run from the top of the row into the commit, one for each child listed above.
  into: number[]
  // Lanes that run from the commit to the bottom of the row, one for each parent.
  out: number[]
  // Lanes that pass the row on their way to a commit further down.
  through: number[]
  // Lanes that pass the row and change column on the way, from one to another.
  moved: [number, number][]
  // Number of lanes the row uses.
  width: number
}

export function layout(commits: { hash: string; parents: string[] }[]): GraphRow[] {
  // Each lane holds the hash of the commit its line is running to.
  const lanes: (string | null)[] = []
  const free = (): number => {
    const index = lanes.indexOf(null)
    return index < 0 ? lanes.push(null) - 1 : index
  }
  return commits.map((commit) => {
    const before = lanes.slice()
    const into = before.flatMap((hash, index) => (hash === commit.hash ? [index] : []))
    // A commit no line runs to is the tip of a branch, and opens a lane.
    const column = into.length > 0 ? into[0] : free()
    for (const index of into) lanes[index] = null
    const moved: [number, number][] = []
    const out = commit.parents.map((parent, position) => {
      let index = lanes.indexOf(parent)
      if (index < 0) {
        // The first parent keeps the lane of the commit, so a branch reads as one straight line.
        index = position === 0 ? column : free()
        lanes[index] = parent
      } else if (position === 0 && index > column) {
        // Another line already runs to the first parent, further right: it comes over, rather than the branch drifting right at each merge.
        lanes[index] = null
        lanes[column] = parent
        moved.push([index, column])
        index = column
      }
      return index
    })
    const through = before.flatMap((hash, index) => (hash !== null && hash !== commit.hash && !moved.some(([from]) => from === index) ? [index] : []))
    const width = Math.max(before.length, lanes.length, column + 1)
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop()
    return { column, into, out, through, moved, width }
  })
}
