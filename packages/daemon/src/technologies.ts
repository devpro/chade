// The technologies of a repository, read from the names of the files that git tracks.
// Only the names are read: no file is opened, and nothing of the repository runs.

export interface Technology {
  id: string
  name: string
}

interface Rule extends Technology {
  matches: (name: string, path: string) => boolean
}

const ends = (...endings: string[]) => (name: string): boolean => endings.some((ending) => name.endsWith(ending))
const named = (...names: string[]) => (name: string): boolean => names.includes(name)

// The names and the paths are in lower case.
const RULES: Rule[] = [
  { id: 'dotnet', name: '.NET', matches: ends('.csproj', '.fsproj', '.vbproj', '.sln', '.slnx') },
  { id: 'nodejs', name: 'Node.js', matches: named('package.json') },
  { id: 'go', name: 'Go', matches: named('go.mod') },
  { id: 'python', name: 'Python', matches: named('pyproject.toml', 'requirements.txt', 'setup.py', 'pipfile') },
  { id: 'java', name: 'Java', matches: named('pom.xml', 'build.gradle', 'build.gradle.kts') },
  { id: 'rust', name: 'Rust', matches: named('cargo.toml') },
  { id: 'php', name: 'PHP', matches: named('composer.json') },
  { id: 'ruby', name: 'Ruby', matches: named('gemfile') },
  { id: 'terraform', name: 'Terraform', matches: ends('.tf') },
  { id: 'helm', name: 'Helm', matches: named('chart.yaml') },
  { id: 'docker', name: 'Docker', matches: (name) => isDockerfile(name) || isCompose(name) },
  { id: 'puppet', name: 'Puppet', matches: ends('.pp') },
  { id: 'github-actions', name: 'GitHub Actions', matches: (name, path) => path.startsWith('.github/workflows/') && /\.ya?ml$/.test(name) },
  { id: 'gitlab-ci', name: 'GitLab CI', matches: (_, path) => path === '.gitlab-ci.yml' },
  { id: 'azure-pipelines', name: 'Azure Pipelines', matches: (name) => /^azure-pipelines.*\.ya?ml$/.test(name) },
]

export function isDockerfile(name: string): boolean {
  return /^(?:dockerfile|containerfile)(?:\.|$)/i.test(name) || /\.dockerfile$/i.test(name)
}

export function isCompose(name: string): boolean {
  return /^(?:docker-)?compose(?:\.[\w-]+)?\.ya?ml$/i.test(name)
}

export const TECHNOLOGIES: Technology[] = RULES.map(({ id, name }) => ({ id, name }))

// The identifiers of the technologies, always in the same order.
export function technologiesOf(files: string[]): string[] {
  const paths = files.map((file) => file.toLowerCase())
  const names = paths.map((path) => path.slice(path.lastIndexOf('/') + 1))
  return RULES.filter((rule) => names.some((name, index) => rule.matches(name, paths[index]))).map((rule) => rule.id)
}
