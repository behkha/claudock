import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildFixture } from './fixture.ts'

/** Every string value in a JSON file that is an absolute path. */
function absolutePaths(file: string): string[] {
  const out: string[] = []
  const walk = (v: unknown): void => {
    if (typeof v === 'string' && path.isAbsolute(v)) out.push(v)
    else if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object') Object.values(v).forEach(walk)
  }
  walk(JSON.parse(fs.readFileSync(file, 'utf8')))
  return out
}

test('the fixture points at the folder it is built in, wherever that is (--demo)', () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claudock-demo-')), 'claude')
  try {
    buildFixture(dir)
    const files = ['settings.json', 'plugins/installed_plugins.json', 'plugins/known_marketplaces.json'].map((f) => path.join(dir, f))
    const paths = files.flatMap(absolutePaths)
    assert.ok(paths.length >= 7, 'plugin and mod paths are absolute')
    for (const p of paths) {
      assert.ok(p.startsWith(dir + path.sep), `${p} is inside ${dir}`)
      assert.ok(fs.existsSync(p), `${p} exists`)
    }
    assert.equal(fs.readFileSync(path.join(dir, '.credentials.json'), 'utf8'), 'FAKE-DO-NOT-READ')
  } finally {
    fs.rmSync(path.dirname(dir), { recursive: true, force: true })
  }
})

test('the fixture refuses a folder that already has files in it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudock-demo-'))
  try {
    fs.writeFileSync(path.join(dir, 'keep.txt'), 'mine')
    assert.throws(() => buildFixture(dir), /not empty/)
    assert.deepEqual(fs.readdirSync(dir), ['keep.txt'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
