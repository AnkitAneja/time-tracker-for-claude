import http from 'node:http'
import { gunzipSync } from 'node:zlib'
import type { Tracker } from '../tracker'
import { parseHookEvent } from './hooks'
import { ActiveTimeExtractor } from './otlp'

const MAX_BODY_BYTES = 2 * 1024 * 1024

class HttpError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message)
  }
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'Body too large'))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  let buf = await readBody(req)
  if (req.headers['content-encoding'] === 'gzip') buf = gunzipSync(buf)
  try {
    return JSON.parse(buf.toString('utf8'))
  } catch {
    throw new HttpError(400, 'Invalid JSON')
  }
}

/**
 * Local server Claude Code talks to. Binds 127.0.0.1 only.
 *   POST /hooks       hook events (HTTP hooks, plus the curl SessionStart hook)
 *   POST /v1/metrics  OTLP/HTTP JSON metrics
 *   GET  /health      liveness check
 *
 * Replies must be fast and quiet: Claude Code waits on UserPromptSubmit/Stop hooks,
 * and a 2xx with a plain-text body counts as a hook error. So hooks get 200 + empty
 * body, metrics get 200 + "{}".
 */
export function createServer(tracker: Tracker): http.Server {
  const extractor = new ActiveTimeExtractor()

  return http.createServer(async (req, res) => {
    try {
      // Browsers always send Origin on cross-site requests; Claude Code doesn't.
      // Rejecting it stops web pages from posting fake data to localhost.
      if (req.headers.origin) throw new HttpError(403, 'Forbidden')

      const path = (req.url ?? '').split('?')[0]

      if (req.method === 'GET' && path === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}')
        return
      }
      if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed')

      if (path === '/hooks') {
        const evt = parseHookEvent(await readJson(req))
        if (evt) tracker.handleHook(evt)
        res.writeHead(200).end()
        return
      }

      if (path === '/v1/metrics') {
        const type = req.headers['content-type'] ?? ''
        if (!type.includes('json')) {
          tracker.setProblem('Claude Code is sending protobuf; re-run setup to switch to http/json')
          throw new HttpError(415, 'Only application/json is supported')
        }
        tracker.handleActiveTime(extractor.extract(await readJson(req), Date.now()))
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}')
        return
      }

      throw new HttpError(404, 'Not found')
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500
      if (status === 500) console.error('[server]', err)
      if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'text/plain' })
      res.end(err instanceof Error ? err.message : 'Error')
    }
  })
}

export function listen(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
}
