import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyFile, applySetup, planSetup, previewFile, removeSetup, setupStatus, undoFile } from '../src/main/setup'

const PORT = 47821
const userHooks = {
  PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }],
  Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }]
}

describe('applySetup / removeSetup', () => {
  it('adds env and all four hooks, keeping user hooks and other settings', () => {
    const before = { model: 'opus', env: { FOO: 'bar' }, hooks: userHooks }
    const after = applySetup(before, PORT) as any

    expect(after.model).toBe('opus')
    expect(after.env).toMatchObject({
      FOO: 'bar',
      CLAUDE_CODE_ENABLE_TELEMETRY: '1',
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'http://127.0.0.1:47821/v1/metrics',
      OTEL_METRIC_EXPORT_INTERVAL: '10000',
      OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: 'delta'
    })
    expect(after.hooks.PreToolUse).toEqual(userHooks.PreToolUse)
    expect(after.hooks.Stop).toEqual([
      userHooks.Stop[0],
      { hooks: [{ type: 'http', url: 'http://127.0.0.1:47821/hooks', timeout: 2 }] }
    ])
    expect(after.hooks.SessionStart[0].hooks[0].type).toBe('command')
    expect(after.hooks.SessionStart[0].hooks[0].command).toContain('-o /dev/null')
    expect(after.hooks.UserPromptSubmit).toHaveLength(1)
    expect(after.hooks.SessionEnd).toHaveLength(1)
    expect(setupStatus(after, PORT)).toBe('installed')
    expect(before.env).toEqual({ FOO: 'bar' }) // input not mutated
  })

  it('is idempotent', () => {
    const once = applySetup({ hooks: userHooks }, PORT)
    expect(applySetup(once, PORT)).toEqual(once)
    expect(planSetup(once, PORT).changes).toEqual([])
  })

  it('removes only what it added', () => {
    const before = { env: { FOO: 'bar' }, hooks: userHooks }
    expect(removeSetup(applySetup(before, PORT), PORT)).toEqual(before)
    expect(removeSetup(applySetup({}, PORT), PORT)).toEqual({})
  })

  it('reports status', () => {
    expect(setupStatus({}, PORT)).toBe('not-installed')
    expect(setupStatus({ env: { CLAUDE_CODE_ENABLE_TELEMETRY: '1' } }, PORT)).toBe('not-installed')
    const full = applySetup({}, PORT) as any
    delete full.hooks.Stop
    expect(setupStatus(full, PORT)).toBe('partial')
  })
})

describe('planSetup warnings', () => {
  it('warns when replacing an existing metrics endpoint', () => {
    const { changes, warnings } = planSetup({ env: { OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'http://corp:4318' } }, PORT)
    expect(changes.some((c) => c.startsWith('Change env OTEL_EXPORTER_OTLP_METRICS_ENDPOINT'))).toBe(true)
    expect(warnings.join()).toContain('http://corp:4318')
  })

  it('warns about allowedHttpHookUrls, disableAllHooks and missing session ids', () => {
    const w = planSetup(
      { allowedHttpHookUrls: ['https://example.com/*'], disableAllHooks: true, env: { OTEL_METRICS_INCLUDE_SESSION_ID: 'false' } },
      PORT
    ).warnings.join('\n')
    expect(w).toContain('allowedHttpHookUrls')
    expect(w).toContain('disableAllHooks')
    expect(w).toContain('OTEL_METRICS_INCLUDE_SESSION_ID')
    expect(planSetup({ allowedHttpHookUrls: ['http://127.0.0.1:47821/*'] }, PORT).warnings.join()).not.toContain('allowedHttpHookUrls')
  })
})

describe('file operations', () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ctt-'))

  it('creates the file when missing, without a backup', () => {
    const file = path.join(tmp(), '.claude', 'settings.json')
    const r = applyFile(file, PORT)
    expect(r.ok).toBe(true)
    expect(r.backupPath).toBeUndefined()
    expect(previewFile(file, PORT).status).toBe('installed')
  })

  it('backs up the original before writing and undo restores the content', () => {
    const file = path.join(tmp(), 'settings.json')
    const original = { env: { FOO: 'bar' }, hooks: userHooks }
    fs.writeFileSync(file, JSON.stringify(original))
    const r = applyFile(file, PORT, new Date('2026-11-10T10:00:00Z'))
    expect(JSON.parse(fs.readFileSync(r.backupPath!, 'utf8'))).toEqual(original)
    undoFile(file, PORT, new Date('2026-11-10T10:00:01Z'))
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(original)
  })

  it('refuses to touch a file it cannot parse', () => {
    const file = path.join(tmp(), 'settings.json')
    fs.writeFileSync(file, '{ broken')
    expect(previewFile(file, PORT).error).toContain("Can't read")
    expect(applyFile(file, PORT).ok).toBe(false)
    expect(fs.readFileSync(file, 'utf8')).toBe('{ broken')
  })
})
