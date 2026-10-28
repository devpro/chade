// Key names whose value is a secret in the files chade usually meets: YAML, JSON, INI, .npmrc, docker config.json, kubeconfig.
export const DEFAULT_KEYS = ['token', 'password', 'passwd', 'secret', 'api[_-]?key', 'credential', 'private[_-]?key', '^auth$', 'key-data']

export const MASK = '***'

const KEY = /([\w.-]+)(["']?\s*[:=]\s*)/g
const URL_CREDENTIALS = /([a-z][\w+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/gi
// A boolean, a number or an empty value says whether a secret is set, never what it is, and it is worth keeping in the snapshot.
const HARMLESS = /^(true|false|null|yes|no|~|-?\d+)?$/i

export function redact(text: string, extraKeys: string[] = []): { text: string; count: number } {
  const keys = new RegExp([...DEFAULT_KEYS, ...extraKeys].join('|'), 'i')
  let count = 0
  const lines = text.split('\n').map((line) => {
    const redacted = redactLine(line.replace(URL_CREDENTIALS, `$1$2:${MASK}@`), keys)
    if (redacted !== line) count++
    return redacted
  })
  return { text: lines.join('\n'), count }
}

export function redactUrl(url: string): string {
  return url.replace(URL_CREDENTIALS, `$1$2:${MASK}@`)
}

function redactLine(line: string, keys: RegExp): string {
  for (const match of line.matchAll(KEY)) {
    if (!keys.test(match[1])) continue
    const start = (match.index ?? 0) + match[0].length
    return line.slice(0, start) + redactValue(line.slice(start))
  }
  return line
}

function redactValue(value: string): string {
  // A nested block holds the secrets on its own lines, which their own key redacts.
  if (/^[{[|>&*]/.test(value)) return value
  const quote = value[0]
  if (quote === '"' || quote === "'") {
    const end = value.indexOf(quote, 1)
    if (end < 0) return value
    return HARMLESS.test(value.slice(1, end)) ? value : quote + MASK + value.slice(end)
  }
  const [, content, trailer] = /^(.*?)(,?\s*)$/.exec(value) ?? ['', value, '']
  return HARMLESS.test(content) ? value : MASK + trailer
}
