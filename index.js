/**
 * dsh-event-chime — Host half.
 *
 * 只做一件事：把包里的 audio/ 目录通过 webServer 暴露成只读静态路由，
 * 让浏览器端能播放随插件一起分发的内置音频包。
 *
 *   GET /dsh-event-chime/audio.json           → { events: { completed: ["01.wav"], ... } }
 *   GET /dsh-event-chime/audio/<event>/<file> → 音频字节
 *
 * 没放任何音频时 audio.json 返回空对象，客户端自动退回内置合成音。
 */
import { readFile, readdir } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-event-chime'

export const inject = ['webServer', 'connection']

const ROUTE = '/dsh-event-chime'
const AUDIO_DIR = fileURLToPath(new URL('./audio/', import.meta.url))
const EVENTS = ['completed', 'completed-bg', 'approval', 'question', 'plan-review', 'stalled']
const MIME = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.m4a': 'audio/mp4',
}

export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE,
    handler: (req, res) => serve(ctx, req, res),
  }), 'dsh-event-chime: audio route')
}

async function serve(ctx, req, res) {
  const reject = ctx.connection?.requestRejection
  if (typeof reject === 'function') {
    const rejection = reject.call(ctx.connection, { headers: req.headers })
    if (rejection !== undefined) {
      res.writeHead(rejection)
      res.end('no')
      return
    }
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'GET only' })

  const path = (req.url ?? '').split('?', 1)[0]
  if (path === ROUTE + '/audio.json') return manifest(res)
  if (!path.startsWith(ROUTE + '/audio/')) return json(res, 404, { error: 'not found' })

  const segments = path.slice((ROUTE + '/audio/').length).split('/')
  if (segments.length !== 2) return json(res, 404, { error: 'not found' })
  let event, file
  try {
    event = decodeURIComponent(segments[0])
    file = decodeURIComponent(segments[1])
  } catch {
    return json(res, 400, { error: 'bad path' })
  }
  if (!EVENTS.includes(event)) return json(res, 404, { error: 'unknown event' })
  if (file.includes('/') || file.includes('..') || file.indexOf(String.fromCharCode(92)) >= 0) return json(res, 404, { error: 'bad file' })
  const ext = extOf(file)
  if (!MIME[ext]) return json(res, 404, { error: 'unsupported type' })

  const target = resolve(join(AUDIO_DIR, event, file))
  if (!target.startsWith(resolve(AUDIO_DIR) + sep)) return json(res, 403, { error: 'forbidden' })

  let buf
  try {
    buf = await readFile(target)
  } catch {
    return json(res, 404, { error: 'missing' })
  }
  res.writeHead(200, {
    'content-type': MIME[ext],
    'content-length': buf.byteLength,
    'cache-control': 'public, max-age=3600',
  })
  res.end(req.method === 'HEAD' ? undefined : buf)
}

/** 扫一遍 audio/ 下每个事件目录，返回这个包实际带了哪些音频。 */
async function manifest(res) {
  const events = {}
  for (const event of EVENTS) {
    let names = []
    try {
      names = await readdir(join(AUDIO_DIR, event))
    } catch {
      names = []
    }
    events[event] = names.filter((name) => MIME[extOf(name)]).sort()
  }
  return json(res, 200, { events })
}

function extOf(name) {
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot).toLowerCase()
}

function json(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}
