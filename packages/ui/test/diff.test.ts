import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseDiff } from '../src/diff.js'

const patch = `diff --git a/src/a.txt b/src/a.txt
index 1111111..2222222 100644
--- a/src/a.txt
+++ b/src/a.txt
@@ -1,3 +1,4 @@ function a
 one
-two
+2
+--- not a header
 three
\\ No newline at end of file
@@ -10 +11 @@
-ten
+10
diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/new.txt
@@ -0,0 +1 @@
+hello
diff --git a/gone.txt b/gone.txt
deleted file mode 100644
index 4444444..0000000
--- a/gone.txt
+++ /dev/null
@@ -1 +0,0 @@
-bye
diff --git a/old name.txt b/new name.txt
similarity index 100%
rename from old name.txt
rename to new name.txt
diff --git a/logo.png b/logo.png
index 5555555..6666666 100644
Binary files a/logo.png and b/logo.png differ
`

test('a patch reads into its files, each with its status and what it adds and removes', () => {
  const files = parseDiff(patch)
  assert.deepEqual(
    files.map((file) => [file.path, file.status, file.additions, file.deletions, file.binary]),
    [
      ['src/a.txt', 'modified', 3, 2, false],
      ['new.txt', 'added', 1, 0, false],
      ['gone.txt', 'deleted', 0, 1, false],
      ['new name.txt', 'renamed', 0, 0, false],
      ['logo.png', 'modified', 0, 0, true],
    ],
  )
  assert.equal(files[3].from, 'old name.txt')
  assert.deepEqual(files[3].lines, [])
})

test('each line has its number before and after, and a line of content that looks like a header stays content', () => {
  const [file] = parseDiff(patch)
  assert.deepEqual(file.lines, [
    { kind: 'hunk', text: '@@ -1,3 +1,4 @@ function a' },
    { kind: 'context', text: 'one', before: 1, after: 1 },
    { kind: 'del', text: 'two', before: 2 },
    { kind: 'add', text: '2', after: 2 },
    { kind: 'add', text: '--- not a header', after: 3 },
    { kind: 'context', text: 'three', before: 3, after: 4 },
    { kind: 'note', text: 'No newline at end of file' },
    { kind: 'hunk', text: '@@ -10 +11 @@' },
    { kind: 'del', text: 'ten', before: 10 },
    { kind: 'add', text: '10', after: 11 },
  ])
})

test('no patch is no file', () => {
  assert.deepEqual(parseDiff(''), [])
})
