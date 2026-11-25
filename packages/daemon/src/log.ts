// The log of the jobs of chade, one line for each step.
export interface LogLine {
  date: string
  job: string
  text: string
}

export function parseLog(text: string): LogLine[] {
  return text.split('\n').flatMap((line) => {
    const match = /^(\d{4}-\S+Z) (\S+) (.*)$/.exec(line)
    return match ? [{ date: match[1], job: match[2], text: match[3] }] : []
  })
}
