// A loop rather than a pattern ending in +$, which backtracks over a long run of separators, once for each of them.
export function trimTrailing(text: string, characters: string): string {
  let end = text.length
  while (end > 0 && characters.includes(text[end - 1])) end--
  return text.slice(0, end)
}
