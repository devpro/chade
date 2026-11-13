import assert from 'node:assert/strict'
import { test } from 'node:test'
import { redact, redactUrl } from '../src/redact.js'

test('a YAML secret is masked and its key kept', () => {
  const { text, count } = redact('github:\n  token: ghp_abc123\n  user: me\n')
  assert.equal(text, 'github:\n  token: xxx\n  user: me\n')
  assert.equal(count, 1)
})

test('a JSON secret keeps its quotes and trailing comma', () => {
  const { text } = redact('{\n  "auths": {\n    "ghcr.io": {\n      "auth": "dXNlcjpwYXNz",\n      "email": "a@b.c"\n    }\n  }\n}')
  assert.match(text, /"auth": "xxx",/)
  assert.match(text, /"auths": \{/)
  assert.match(text, /"email": "a@b.c"/)
})

test('an .npmrc token is masked behind its registry prefix', () => {
  assert.equal(redact('//registry.npmjs.org/:_authToken=npm_secret').text, '//registry.npmjs.org/:_authToken=xxx')
})

test('an INI password with spaces around the equal sign is masked', () => {
  assert.equal(redact('password = hunter2').text, 'password = xxx')
})

test('a boolean, a number or an empty value is kept', () => {
  const input = 'requirePassword: true\ntokenTtl: 3600\ntoken:\n"secret": ""'
  assert.deepEqual(redact(input), { text: input, count: 0 })
})

test('a key that only looks like auth is kept', () => {
  assert.equal(redact('author: me').text, 'author: me')
})

test('credentials in a URL are masked, the user kept', () => {
  assert.equal(redactUrl('https://me:s3cret@gitlab.com/group/repo.git'), 'https://me:xxx@gitlab.com/group/repo.git')
  assert.equal(redactUrl('git@github.com:devpro/chade.git'), 'git@github.com:devpro/chade.git')
})

test('a key from the configuration is masked as well', () => {
  assert.equal(redact('license: ABCD-1234', ['^license$']).text, 'license: xxx')
})
