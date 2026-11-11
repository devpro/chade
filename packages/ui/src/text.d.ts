// A Markdown file is bundled as its text.
declare module '*.md' {
  const text: string
  export default text
}
