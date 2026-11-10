// Parses Claude Code hook payloads. Only a whitelist of fields is kept.
// Prompt text (UserPromptSubmit) and last_assistant_message (Stop) are passed on as
// `text` for auto task naming, which keeps them in memory only. They never reach the database.

export const TRACKED_EVENTS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'Stop'] as const
export type TrackedEvent = (typeof TRACKED_EVENTS)[number]

export interface HookEvent {
  type: TrackedEvent
  sessionId: string
  cwd: string | null
  /** SessionStart `source` or SessionEnd `reason`. */
  detail: string | null
  /** Prompt (UserPromptSubmit) or Claude's reply (Stop). Memory only, never saved. */
  text: string | null
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

/** Returns null for events we don't track or payloads missing a session id. */
export function parseHookEvent(body: unknown): HookEvent | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>

  const type = str(b.hook_event_name)
  if (!type || !(TRACKED_EVENTS as readonly string[]).includes(type)) return null

  const sessionId = str(b.session_id)
  if (!sessionId) return null

  let detail: string | null = null
  if (type === 'SessionStart') detail = str(b.source)
  if (type === 'SessionEnd') detail = str(b.reason)

  let text: string | null = null
  if (type === 'UserPromptSubmit') text = str(b.prompt)
  if (type === 'Stop') text = str(b.last_assistant_message)

  return { type: type as TrackedEvent, sessionId, cwd: str(b.cwd), detail, text }
}
