export const DIFF_LIMIT = 10_000

export type Shaped = { source: string; omitted: number }

type Hunk = { head: string; start: [string, string]; section: string; body: string[] }

const HEAD = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/

function counts(body: string[]): [number, number] {
  let old = 0
  let next = 0
  for (const line of body) {
    if (line.startsWith('+')) next += 1
    else if (line.startsWith('-')) old += 1
    else if (!line.startsWith('\\')) {
      old += 1
      next += 1
    }
  }
  return [old, next]
}

function lines(body: string[]): string {
  return body.map(l => `${l}\n`).join('')
}

function rewritten(h: Hunk, body: string[]): string {
  const [old, next] = counts(body)
  return `@@ -${h.start[0]},${old} +${h.start[1]},${next} @@${h.section}\n${lines(body)}`
}

function parse(raw: string): Hunk[] {
  const all = raw.replace(/\n$/, '').split('\n')
  const at = all.findIndex(l => l.startsWith('@@'))
  if (at < 0) return []
  const hunks: Hunk[] = []
  for (const line of all.slice(at)) {
    const head = HEAD.exec(line)
    if (head) hunks.push({ head: line, start: [head[1] ?? '0', head[2] ?? '0'], section: head[3] ?? '', body: [] })
    else if (hunks.length && (line === '' || ' +-\\'.includes(line[0] ?? ''))) hunks[hunks.length - 1]?.body.push(line === '' ? ' ' : line)
  }
  return hunks.filter(h => h.body.length)
}

export function shapeDiff(raw: string, limit = DIFF_LIMIT): Shaped | null {
  const clean = raw.replace(/\r/g, '').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
  const hunks = parse(clean)
  if (hunks.length === 0) return null
  const total = hunks.reduce((n, h) => n + h.body.length, 0)
  let source = ''
  let shown = 0
  for (const h of hunks) {
    const whole = `${h.head}\n${lines(h.body)}`
    if (source.length + whole.length <= limit) {
      source += whole
      shown += h.body.length
      continue
    }
    let keep = 0
    let used = source.length + rewritten(h, []).length
    while (keep < h.body.length && used + (h.body[keep]?.length ?? 0) + 1 <= limit) used += (h.body[keep++]?.length ?? 0) + 1
    while (keep > 0 && source.length + rewritten(h, h.body.slice(0, keep)).length > limit) keep -= 1
    if (keep > 0) {
      source += rewritten(h, h.body.slice(0, keep))
      shown += keep
    }
    break
  }
  return source ? { source, omitted: total - shown } : null
}
