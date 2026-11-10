import type { AddressInfo } from 'node:net'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../src/main/db'
import { Repo } from '../src/main/db/repo'
import { createServer, listen } from '../src/main/server'
import { Tracker } from '../src/main/tracker'
import otlp from './fixtures/otlp-delta.json'
import prompt from './fixtures/hook-user-prompt-submit.json'

let close: () => void = () => {}
afterEach(() => close())

async function start() {
  const db = openDatabase(':memory:')
  const tracker = new Tracker(new Repo(db))
  const server = createServer(tracker)
  await listen(server, 0)
  close = () => server.close()
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { db, tracker, base }
}

const json = { 'Content-Type': 'application/json' }

describe('server', () => {
  it('accepts hooks with 200 and an empty body', async () => {
    const { base, db } = await start()
    const res = await fetch(`${base}/hooks`, { method: 'POST', headers: json, body: JSON.stringify(prompt) })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('')
    expect(db.prepare('SELECT COUNT(*) n FROM events').get()).toEqual({ n: 1 })
  })

  it('accepts OTLP JSON, plain and gzipped, and replies {}', async () => {
    const { base, tracker } = await start()
    let res = await fetch(`${base}/v1/metrics`, { method: 'POST', headers: json, body: JSON.stringify(otlp) })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('{}')
    res = await fetch(`${base}/v1/metrics`, {
      method: 'POST',
      headers: { ...json, 'Content-Encoding': 'gzip' },
      body: gzipSync(JSON.stringify(otlp))
    })
    expect(res.status).toBe(200)
    // timestamps in the fixture are from 2025, so check totals across all time
    expect((tracker as any).repo.totalsSince(0)).toEqual([{ taskId: null, seconds: 19.5 }])
    expect(tracker.state().lastDataAt).not.toBeNull()
  })

  it('rejects protobuf, browser origins, bad JSON and unknown paths', async () => {
    const { base, tracker } = await start()
    let res = await fetch(`${base}/v1/metrics`, { method: 'POST', headers: { 'Content-Type': 'application/x-protobuf' }, body: 'x' })
    expect(res.status).toBe(415)
    expect(tracker.state().problem).toContain('protobuf')
    res = await fetch(`${base}/hooks`, { method: 'POST', headers: { ...json, Origin: 'https://evil.example' }, body: '{}' })
    expect(res.status).toBe(403)
    res = await fetch(`${base}/hooks`, { method: 'POST', headers: json, body: '{nope' })
    expect(res.status).toBe(400)
    res = await fetch(`${base}/nope`, { method: 'POST', body: '{}' })
    expect(res.status).toBe(404)
    res = await fetch(`${base}/health`)
    expect(await res.json()).toEqual({ ok: true })
  })
})
