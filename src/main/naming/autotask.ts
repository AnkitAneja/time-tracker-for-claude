// Works out which task each Claude Code session is about, from the conversation itself.
// Conversation text is kept in memory only (a few recent messages per session) and is
// never written to the database.

export interface NameRequest {
  /** Recent conversation, formatted as "USER: ..." / "CLAUDE: ..." lines. */
  conversation: string
  /** Folder name of the session, e.g. "shop". */
  project: string | null
  /** The session's task so far, or null on the first check. */
  currentTask: { id: number; name: string } | null
  /** Existing tasks the model may reuse. */
  tasks: { id: number; name: string; project: string | null }[]
}

export interface NameResult {
  /** An existing task id to use, or null to create a task called `name`. */
  existingTaskId: number | null
  /** Short task name. Empty means "not clear yet, ask again later". */
  name: string
}

/** Asks a model to name the task. Throws on failure. */
export type Namer = (req: NameRequest) => Promise<NameResult>

interface Turn {
  role: 'USER' | 'CLAUDE'
  text: string
}

interface SessionChat {
  first: Turn | null
  recent: Turn[]
  stopsSinceCheck: number
  named: boolean
}

export interface AutoTaskerOptions {
  /** After the first name, re-check the topic every N Claude replies. */
  recheckEvery?: number
  /** Recent messages kept per session, besides the first prompt. */
  keepRecent?: number
  /** Characters kept per message. */
  maxChars?: number
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max) + ' …' : t
}

/**
 * Collects each session's conversation and decides when to ask for a task name:
 * after the first Claude reply, then every few replies to catch a change of topic.
 * Calls run one at a time so a burst of sessions doesn't start many CLI processes.
 */
export class AutoTasker {
  private chats = new Map<string, SessionChat>()
  private queue: Promise<void> = Promise.resolve()
  private inFlight = new Set<string>()
  private recheckEvery: number
  private keepRecent: number
  private maxChars: number

  constructor(
    private namer: Namer,
    /** Builds the request context (current task, task list) at the moment the call runs. */
    private context: (sessionId: string) => Omit<NameRequest, 'conversation'>,
    private onResult: (sessionId: string, result: NameResult) => void,
    private onError: (sessionId: string, err: Error) => void,
    opts: AutoTaskerOptions = {}
  ) {
    this.recheckEvery = opts.recheckEvery ?? 3
    this.keepRecent = opts.keepRecent ?? 6
    this.maxChars = opts.maxChars ?? 1200
  }

  private chat(sessionId: string): SessionChat {
    let c = this.chats.get(sessionId)
    if (!c) {
      c = { first: null, recent: [], stopsSinceCheck: 0, named: false }
      this.chats.set(sessionId, c)
    }
    return c
  }

  private add(c: SessionChat, turn: Turn): void {
    if (!c.first && turn.role === 'USER') {
      c.first = turn
      return
    }
    c.recent.push(turn)
    if (c.recent.length > this.keepRecent) c.recent.shift()
  }

  prompt(sessionId: string, text: string): void {
    this.add(this.chat(sessionId), { role: 'USER', text: clip(text, this.maxChars) })
  }

  /** Records Claude's reply and starts a naming call when one is due. */
  reply(sessionId: string, text: string | null, enabled: boolean): void {
    const c = this.chat(sessionId)
    if (text) this.add(c, { role: 'CLAUDE', text: clip(text, this.maxChars) })
    c.stopsSinceCheck++
    if (!enabled || !c.first || this.inFlight.has(sessionId)) return
    if (c.named && c.stopsSinceCheck < this.recheckEvery) return
    c.stopsSinceCheck = 0
    this.inFlight.add(sessionId)
    this.queue = this.queue.then(() => this.run(sessionId))
  }

  /** Forgets a session's conversation. */
  end(sessionId: string): void {
    this.chats.delete(sessionId)
  }

  /** Resolves when all queued naming calls are done (used by tests). */
  idle(): Promise<void> {
    return this.queue
  }

  private conversation(c: SessionChat): string {
    const lines: string[] = []
    if (c.first) lines.push(`${c.first.role}: ${c.first.text}`)
    if (c.recent.length > 0 && c.first) lines.push('…')
    for (const t of c.recent) lines.push(`${t.role}: ${t.text}`)
    return lines.join('\n')
  }

  private async run(sessionId: string): Promise<void> {
    try {
      const c = this.chats.get(sessionId)
      if (!c) return
      const result = await this.namer({ ...this.context(sessionId), conversation: this.conversation(c) })
      if (result.existingTaskId !== null || result.name.trim()) {
        c.named = true
        this.onResult(sessionId, result)
      }
    } catch (err) {
      this.onError(sessionId, err as Error)
    } finally {
      this.inFlight.delete(sessionId)
    }
  }
}
