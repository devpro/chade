// What chade report measures, as the command gives it with --json and the interface shows it.
export interface Measure {
  label: string
  bytes?: number
  detail?: string
}

export interface Section {
  title: string
  measures: Measure[]
  // What to do about a measure, each the command or setting the machine documentation gives.
  hints: string[]
  // Section of docs/cleanup.md that explains the hints.
  guide?: string
}

export interface Report {
  machine: string
  date: string
  sections: Section[]
}
