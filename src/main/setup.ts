// Reads and writes the Claude Code user settings file (~/.claude/settings.json).
// The pure functions (planSetup, applySetup, removeSetup) do the JSON work; the
// file functions add backup and atomic write around them.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SetupPreview, SetupResult, SetupStatus } from '../shared/types'

type Json = Record<string, unknown>
interface HookHandler {
  type?: string
  url?: string
  command?: string
  [k: string]: unknown
}
interface MatcherGroup {
  matcher?: string
  hooks?: HookHandler[]
  [k: string]: unknown
}

export const HTTP_HOOK_EVENTS = ['UserPromptSubmit', 'Stop', 'SessionEnd'] as const
// SessionStart only supports command and mcp_tool hooks, so it gets a curl command.
export const COMMAND_HOOK_EVENT = 'SessionStart'
const ALL_EVENTS = [...HTTP_HOOK_EVENTS, COMMAND_HOOK_EVENT]

export function defaultSettingsPath(): string {
  return path.join(os.homedir(), '.claude', 'settings.json')
}

export function hookUrl(port: number): string {
  return `http://127.0.0.1:${port}/hooks`
}

export function desiredEnv(port: number): Record<string, string> {
  // Metrics-specific variables so the user's other telemetry (logs, traces) is untouched.
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_METRICS_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `http://127.0.0.1:${port}/v1/metrics`,
    OTEL_METRIC_EXPORT_INTERVAL: '10000',
    OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: 'delta'
  }
}

function desiredHook(event: string, port: number): HookHandler {
  const url = hookUrl(port)
  if (event === COMMAND_HOOK_EVENT) {
    // -o /dev/null: SessionStart stdout is added to Claude's context, so print nothing.
    // || true: a stopped app must not show up as a hook error.
    return {
      type: 'command',
      command: `curl -s -o /dev/null --max-time 2 -H 'Content-Type: application/json' --data-binary @- ${url} || true`,
      timeout: 5
    }
  }
  return { type: 'http', url, timeout: 2 }
}

function isOurHook(h: HookHandler, port: number): boolean {
  const url = hookUrl(port)
  return h.url === url || (typeof h.command === 'string' && h.command.includes(url))
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v ?? {})) as T
}

function hooksOf(settings: Json): Record<string, MatcherGroup[]> {
  const h = settings.hooks
  return h && typeof h === 'object' ? (h as Record<string, MatcherGroup[]>) : {}
}

function hasOurHook(settings: Json, event: string, port: number): boolean {
  const groups = hooksOf(settings)[event]
  return Array.isArray(groups) && groups.some((g) => g.hooks?.some((h) => isOurHook(h, port)))
}

/** Removes only our hooks and our env values; everything else is left alone. */
export function removeSetup(settings: Json, port: number): Json {
  const next = clone(settings)

  const hooks = hooksOf(next)
  for (const event of Object.keys(hooks)) {
    const groups = hooks[event]
    if (!Array.isArray(groups)) continue
    const kept = groups
      .map((g) => (Array.isArray(g.hooks) ? { ...g, hooks: g.hooks.filter((h) => !isOurHook(h, port)) } : g))
      .filter((g) => !Array.isArray(g.hooks) || g.hooks.length > 0)
    if (kept.length > 0) hooks[event] = kept
    else delete hooks[event]
  }
  if (next.hooks && Object.keys(hooks).length === 0) delete next.hooks

  const env = next.env as Record<string, string> | undefined
  if (env && typeof env === 'object') {
    for (const [k, v] of Object.entries(desiredEnv(port))) if (env[k] === v) delete env[k]
    if (Object.keys(env).length === 0) delete next.env
  }
  return next
}

/** Adds our env values and hooks. Safe to run again: our old entries are replaced, not duplicated. */
export function applySetup(settings: Json, port: number): Json {
  const next = removeSetup(settings, port)
  next.env = { ...((next.env as Json) ?? {}), ...desiredEnv(port) }

  const hooks = { ...hooksOf(next) }
  for (const event of ALL_EVENTS) {
    const groups = Array.isArray(hooks[event]) ? hooks[event] : []
    hooks[event] = [...groups, { hooks: [desiredHook(event, port)] }]
  }
  next.hooks = hooks
  return next
}

export function setupStatus(settings: Json, port: number): SetupStatus {
  const env = (settings.env ?? {}) as Record<string, string>
  const envMatches = Object.entries(desiredEnv(port)).filter(([k, v]) => env[k] === v).length
  const hookMatches = ALL_EVENTS.filter((e) => hasOurHook(settings, e, port)).length
  const total = Object.keys(desiredEnv(port)).length + ALL_EVENTS.length
  if (envMatches + hookMatches === total) return 'installed'
  // CLAUDE_CODE_ENABLE_TELEMETRY=1 alone is common, so don't count it as our install.
  if (hookMatches === 0 && !Object.keys(env).some((k) => k.startsWith('OTEL_') && env[k] === desiredEnv(port)[k]))
    return 'not-installed'
  return 'partial'
}

function globMatches(pattern: string, value: string): boolean {
  const re = new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$')
  return re.test(value)
}

/** Describes what applySetup will change and anything that might surprise the user. */
export function planSetup(settings: Json, port: number): { changes: string[]; warnings: string[] } {
  const changes: string[] = []
  const warnings: string[] = []
  const env = (settings.env ?? {}) as Record<string, unknown>

  for (const [k, v] of Object.entries(desiredEnv(port))) {
    if (env[k] === v) continue
    if (env[k] === undefined) changes.push(`Set env ${k}=${v}`)
    else {
      changes.push(`Change env ${k} from "${String(env[k])}" to "${v}"`)
      if (k === 'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT' || k === 'OTEL_METRICS_EXPORTER')
        warnings.push(`Your metrics currently go to "${String(env[k])}". After setup they go only to this app.`)
    }
  }
  for (const e of ALL_EVENTS) {
    if (!hasOurHook(settings, e, port))
      changes.push(e === COMMAND_HOOK_EVENT ? `Add ${e} hook (curl to ${hookUrl(port)})` : `Add ${e} HTTP hook (${hookUrl(port)})`)
  }

  if (typeof env.OTEL_EXPORTER_OTLP_ENDPOINT === 'string' && !env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT)
    warnings.push(
      `OTEL_EXPORTER_OTLP_ENDPOINT is set to "${env.OTEL_EXPORTER_OTLP_ENDPOINT}". Metrics will now go to this app; logs and traces still go there.`
    )
  if (env.OTEL_METRICS_INCLUDE_SESSION_ID === 'false')
    warnings.push('OTEL_METRICS_INCLUDE_SESSION_ID is false, so time cannot be linked to sessions or folders.')
  if (settings.disableAllHooks === true)
    warnings.push('disableAllHooks is true in your settings, so hook events will not arrive.')
  const allow = settings.allowedHttpHookUrls
  if (Array.isArray(allow) && !allow.some((p) => typeof p === 'string' && globMatches(p, hookUrl(port))))
    warnings.push(`allowedHttpHookUrls does not include ${hookUrl(port)}. Add "http://127.0.0.1:${port}/*" or hooks will be skipped.`)

  if (changes.length > 0) warnings.push('Restart open Claude Code sessions afterwards so they pick up the new settings.')
  return { changes, warnings }
}

// --- file side ---

function readSettings(file: string): Json {
  if (!fs.existsSync(file)) return {}
  const text = fs.readFileSync(file, 'utf8')
  if (text.trim() === '') return {}
  const parsed = JSON.parse(text)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('settings.json is not a JSON object')
  return parsed as Json
}

function writeSettings(file: string, settings: Json, now: Date): string | undefined {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  let backupPath: string | undefined
  if (fs.existsSync(file)) {
    const stamp = now.toISOString().replace(/[:.]/g, '-')
    backupPath = `${file}.backup-${stamp}`
    fs.copyFileSync(file, backupPath)
  }
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n')
  fs.renameSync(tmp, file)
  return backupPath
}

export function previewFile(file: string, port: number): SetupPreview {
  try {
    const settings = readSettings(file)
    return { settingsPath: file, status: setupStatus(settings, port), ...planSetup(settings, port), error: null }
  } catch (err) {
    return {
      settingsPath: file,
      status: 'not-installed',
      changes: [],
      warnings: [],
      error: `Can't read ${file}: ${(err as Error).message}. Fix the file by hand, then try again.`
    }
  }
}

export function applyFile(file: string, port: number, now = new Date()): SetupResult {
  try {
    const settings = readSettings(file)
    const backupPath = writeSettings(file, applySetup(settings, port), now)
    return { ok: true, message: 'Claude Code is set up. Restart open sessions to start tracking.', backupPath }
  } catch (err) {
    return { ok: false, message: (err as Error).message }
  }
}

export function undoFile(file: string, port: number, now = new Date()): SetupResult {
  try {
    const settings = readSettings(file)
    const backupPath = writeSettings(file, removeSetup(settings, port), now)
    return { ok: true, message: 'Removed tracker settings from Claude Code.', backupPath }
  } catch (err) {
    return { ok: false, message: (err as Error).message }
  }
}
