// The scan, the inventory and the report run once a day while the server of the web interface runs, each when its last run is a day old.
// The server is what stays up in the background, so nothing is installed in the system to schedule them,
// and a day the server was stopped is caught up at its next start.

export const DAY_MS = 24 * 3600 * 1000
const HOUR_MS = 3600 * 1000
// The server answers the page first, and the work of the day comes a minute later.
const FIRST_MS = 60_000

export interface DailyJob {
  name: string
  // The date of the last run, saved by the job itself, absent before the first.
  last: () => Promise<string | undefined>
  run: () => Promise<unknown>
}

// Runs each job whose last run is a day old or more, one after the other, as the scan and the report each take the machine for a while.
export async function runDue(jobs: DailyJob[], log: (line: string) => void, now = Date.now()): Promise<string[]> {
  const ran: string[] = []
  for (const job of jobs) {
    const last = await job.last()
    if (last !== undefined && now - Date.parse(last) < DAY_MS) continue
    log(`daily ${job.name}: starting`)
    try {
      await job.run()
      ran.push(job.name)
      log(`daily ${job.name}: done`)
    } catch (error) {
      log(`daily ${job.name}: failed, ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return ran
}

// Looks every hour, a day being caught up within the hour it falls due, and stops with the function it returns.
export function startDaily(jobs: DailyJob[], log: (line: string) => void): () => void {
  let running = false
  const look = (): void => {
    if (running) return
    running = true
    void runDue(jobs, log).finally(() => {
      running = false
    })
  }
  const first = setTimeout(look, FIRST_MS)
  const every = setInterval(look, HOUR_MS)
  first.unref()
  every.unref()
  return () => {
    clearTimeout(first)
    clearInterval(every)
  }
}

// One run at a time of the work it wraps: a call while it runs gets that run, as the page and the day may ask at once.
export function single<T>(work: () => Promise<T>): () => Promise<T> {
  let going: Promise<T> | undefined
  return () => {
    going ??= work().finally(() => {
      going = undefined
    })
    return going
  }
}
