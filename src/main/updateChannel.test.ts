import test from 'node:test'
import assert from 'node:assert/strict'
import { compareVersions, isPrerelease, pickUpdate } from './updateChannel.ts'

test('compareVersions follows semver order', () => {
  const ascending = ['0.1.1', '0.2.0-alpha', '0.2.0-beta', '0.2.0-beta.1', '0.2.0-beta.2', '0.2.0-beta.10', '0.2.0-beta.x', '0.2.0-rc.1', '0.2.0', '0.2.1', '0.10.0', '1.0.0']
  for (let i = 0; i < ascending.length; i++) {
    for (let j = 0; j < ascending.length; j++) {
      const sign = Math.sign(compareVersions(ascending[i], ascending[j]))
      assert.equal(sign, Math.sign(i - j), `${ascending[i]} vs ${ascending[j]}`)
    }
  }
})

test('compareVersions ignores a leading v and build metadata, and treats non-versions as equal', () => {
  assert.equal(compareVersions('v0.2.0', '0.2.0'), 0)
  assert.equal(compareVersions('0.2.0+build.5', '0.2.0'), 0)
  assert.equal(compareVersions('nonsense', '0.2.0'), 0)
  assert.equal(compareVersions('0.2.0', ''), 0)
})

test('isPrerelease', () => {
  assert.equal(isPrerelease('0.2.0-beta.1'), true)
  assert.equal(isPrerelease('v0.2.0-rc.1'), true)
  assert.equal(isPrerelease('0.2.0'), false)
  assert.equal(isPrerelease('0.2.0+build'), false)
  assert.equal(isPrerelease('nonsense'), false)
})

test('a stable build follows latest only', () => {
  assert.deepEqual(pickUpdate('0.1.1', { latest: 'v0.2.0' }), { version: '0.2.0', channel: 'latest' })
  assert.equal(pickUpdate('0.1.1', { latest: '0.1.1' }), null)
  assert.equal(pickUpdate('0.2.0', { latest: '0.1.1' }), null)
  assert.equal(pickUpdate('0.1.1', { latest: '0.1.1', beta: '0.2.0-beta.2' }), null)
  assert.equal(pickUpdate('0.1.1', {}), null)
})

test('a beta build moves to a newer beta', () => {
  assert.deepEqual(pickUpdate('0.2.0-beta.1', { latest: '0.1.1', beta: '0.2.0-beta.2' }), { version: '0.2.0-beta.2', channel: 'beta' })
  assert.deepEqual(pickUpdate('0.2.0-beta.9', { latest: '0.1.1', beta: '0.2.0-beta.10' }), { version: '0.2.0-beta.10', channel: 'beta' })
})

test('a beta build moves to a newer stable release', () => {
  assert.deepEqual(pickUpdate('0.2.0-beta.2', { latest: '0.2.0', beta: '0.2.0-beta.2' }), { version: '0.2.0', channel: 'latest' })
  // the beta tag stays behind on the last beta after the stable release
  assert.deepEqual(pickUpdate('0.2.0-beta.1', { latest: '0.2.0', beta: '0.2.0-beta.3' }), { version: '0.2.0', channel: 'latest' })
  // both tags on the same version: latest wins the tie
  assert.deepEqual(pickUpdate('0.2.0-beta.3', { latest: '0.2.0', beta: '0.2.0' }), { version: '0.2.0', channel: 'latest' })
})

test('a beta build ignores an older stable release', () => {
  assert.equal(pickUpdate('0.2.0-beta.1', { latest: '0.1.1', beta: '0.2.0-beta.1' }), null)
  assert.equal(pickUpdate('0.2.0-beta.1', { latest: '0.1.1' }), null)
  assert.equal(pickUpdate('0.2.0-beta.2', { latest: '0.1.1', beta: '0.2.0-beta.1' }), null)
})

test('a beta build takes the newer of the two when both are ahead', () => {
  assert.deepEqual(pickUpdate('0.2.0-beta.3', { latest: '0.2.0', beta: '0.3.0-beta.1' }), { version: '0.3.0-beta.1', channel: 'beta' })
  assert.deepEqual(pickUpdate('0.2.0-beta.3', { latest: '0.2.1', beta: '0.2.1-beta.1' }), { version: '0.2.1', channel: 'latest' })
})
