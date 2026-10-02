import { expect, mock, test } from 'claude-code/testing'

import { DIFF_LIMIT, shapeDiff } from '../hooks/diff'
import { ancestorsOf, cellWidth, clip, replaceChildren, toNodes } from '../hooks/tree'

type World = {
  os: 'darwin' | 'linux' | 'win32'
  env: Record<string, string>
  cwd: string
  top: string
  dirs: Record<string, [string, 'file' | 'dir'][]>
  status: string
  numstat: string
  exits?: Record<string, [number, string]>
  delays?: Record<string, number[]>
  denied?: string[]
  heads?: string[]
  tool?: (e: any) => unknown
  find?: string
  patch?: (argv: string[]) => { exitCode: number; stdout: string; stderr?: string } | undefined
}
type Ran = string[][]
const opens: unknown[] = []
const envs: Record<string, string>[] = []

function world(on: any, w: World, ran: Ran) {
  mock.env(on, w.env)
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  mock.store(on)
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: w.cwd }))
  on('session.id', () => ({ value: 'test-session' }))
  on('command.register', () => ({ value: undefined }))
  on('ui.open', (_$: any, e: any) => {
    opens.push(e)
    return { value: { isPlaced: true } }
  })
  on('ui.toast', (_$: any, e: any) => {
    ran.push(['toast', String(e.text ?? e.message ?? JSON.stringify(e))])
    return { value: undefined }
  })
  on('fs.read', () => {
    throw new Error('no theme file')
  })
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/^.*?(?=[A-Za-z]:\/)/, '')
  const dirOf = (p: string) => w.dirs[p] ?? w.dirs[p.replace(/^[A-Za-z]:/, '')]
  on('fs.list', async (_$: any, e: any) => {
    const path = norm(e.path)
    const bare = path.replace(/^[A-Za-z]:/, '')
    if (w.denied?.includes(bare)) return { deny: `EACCES: permission denied, scandir '${path}'` }
    const kids = dirOf(path)
    if (!kids) throw new Error(`ENOENT ${e.path}`)
    const value = kids.map(([name, kind]) => ({ name, kind, size: 1, mtimeMs: 1_700_000_000_000, isLink: false }))
    const delay = w.delays?.[bare]?.shift()
    if (delay) await clock.sleep(delay)
    return { value }
  })
  on('fs.stat', (_$: any, e: any) => {
    const p = norm(e.path)
    const parent = p.slice(0, p.lastIndexOf('/')) || '/'
    const name = p.slice(p.lastIndexOf('/') + 1)
    const hit = dirOf(p) ? 'dir' : dirOf(parent)?.find(([n]) => n === name)?.[1]
    if (!hit) throw new Error(`ENOENT ${e.path}`)
    return { value: { kind: hit, size: 1, mtimeMs: name === 'a.ts' ? 1_800_000_000_500 : 1_700_000_000_000, isLink: false } }
  })
  on('process.run', (_$: any, e: any) => {
    const argv: string[] = [...e.argv]
    ran.push(argv)
    if (e.init?.env) envs.push(e.init.env)
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    const exit = w.exits?.[argv[0] ?? '']
    if (exit) return { value: { exitCode: exit[0], stdout: '', stderr: exit[1], isStdoutTruncated: false, isStderrTruncated: false } }
    if (argv[0] === 'find' && w.find !== undefined) return ok(w.find)
    if (argv[0] === 'uname') return ok(w.os === 'darwin' ? 'Darwin\n' : 'Linux\n')
    if (argv[0] === 'sh') return ok('missing\n')
    if (argv[0] === 'git') {
      const verb = argv.slice(4).find(a => !a.startsWith('-'))
      if (verb === 'rev-parse' && argv.at(-1) === 'HEAD') return ok(`${(w.heads && w.heads.length > 1 ? w.heads.shift() : w.heads?.[0]) ?? ''}\n`)
      if (verb === 'rev-parse') return w.top ? ok(`\n${w.top}\n`) : { value: { exitCode: 128, stdout: '', stderr: 'not a git repository', isStdoutTruncated: false, isStderrTruncated: false } }
      if (verb === 'status') return ok(w.status)
      if (verb === 'diff' && argv.includes('--no-color')) {
        const out = w.patch?.(argv)
        return { value: { exitCode: out?.exitCode ?? 0, stdout: out?.stdout ?? '', stderr: out?.stderr ?? '', isStdoutTruncated: false, isStderrTruncated: false } }
      }
      if (verb === 'diff') return ok(w.numstat)
      if (verb === 'ls-files') {
        const files: string[] = []
        for (const [dir, kids] of Object.entries(w.dirs)) for (const [name, kind] of kids) if (kind === 'file' && dir.startsWith(w.top)) files.push(`${dir}/${name}`.slice(w.top.length + 1))
        return ok(files.join('\0'))
      }
      return ok('')
    }
    return ok('')
  })
  on('tool.call', (_$: any, e: any) => (w.tool?.(e) ?? { result: { stdout: '', stderr: '' } }) as any)
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text, context: e.context }))
  return clock
}

const paneProps = (bodyColumns: number) => ({ title: 'Files', isFocused: false, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} }) as any

async function texts(ui: any): Promise<string> {
  const rows = JSON.stringify(await ui.drawn({ in: 'rows' }))
  return JSON.stringify(await ui.drawn()) + rows
}

const NERD = /[\u{e000}-\u{f8ff}\u{f0000}-\u{fffff}]/u

test('macOS Claude Code app: desktop pane draws, selects, opens with open', { timeoutMs: 20_000 }, async ($, on) => {
  const ran: Ran = []
  const root = '/Users/k/proj'
  const clock = world(on, {
    os: 'darwin', env: { HOME: '/Users/k', TMPDIR: '/var/folders/x/T/' }, cwd: root, top: root,
    dirs: { [root]: [['src', 'dir'], ['README.md', 'file'], ['notes.md', 'file']], [`${root}/src`]: [['a.ts', 'file']] },
    status: '## main...origin/main\0 M src/a.ts\0?? notes.md\0', numstat: '3\t1\tsrc/a.ts\0',
  }, ran)
  await $.session.start({ cwd: root, surface: 'desktop', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'filetree', surface: 'desktop', component: 'Pane', requestId: 'filetree', props: paneProps(60) })
  await clock.settle()
  const shown = await texts(ui)
  for (const word of ['README.md', 'notes.md', 'src', 'main', 'origin/main']) expect(shown).toContain(word)
  expect(NERD.test(shown)).toBe(false)
  await ui.post({ press: `${root}/README.md` }, { in: 'rows' })
  await clock.settle()
  expect(await texts(ui)).toContain('"selected: ","README.md"')
  const sent = await $.prompt.submit({ text: 'what is this?', wait: false } as any)
  expect(JSON.stringify(sent)).toContain(`${root}/README.md`)
  await ui.post({ press: `${root}/README.md` }, { in: 'rows' })
  await clock.settle()
  expect(ran).toContainEqual(['open', `${root}/README.md`])
  expect(ran.some(a => a[0] === 'setsid' || a[0] === 'gio')).toBe(false)
  await $.tool.call({ tool: 'Bash', command: 'echo hi >> src/a.ts' } as any)
  await clock.settle()
  const finds = ran.filter(a => a[0] === 'find')
  expect(finds.length).toBeGreaterThan(0)
  expect(finds.every(f => f.includes('-newer') && !f.includes('-newermt'))).toBe(true)
  expect(ran.some(a => a[0] === 'touch' && a[1]?.startsWith('/var/folders/x/T/filetree-'))).toBe(true)
  expect(ran.some(a => a[0] === 'rm')).toBe(true)
  await ui.unmount()
})

test('macOS outside a repo: write scan uses find -newer marker, not GNU -newermt', { timeoutMs: 20_000 }, async ($, on) => {
  const ran: Ran = []
  const root = '/Users/k/scratch'
  const clock = world(on, { os: 'darwin', env: { HOME: '/Users/k' }, cwd: root, top: '', dirs: { [root]: [['a.ts', 'file']] }, status: '', numstat: '' }, ran)
  await $.session.start({ cwd: root, surface: 'terminal', isInteractive: true })
  await clock.settle()
  await $.tool.call({ tool: 'Bash', command: 'echo hi > a.ts' } as any)
  await clock.settle()
  const find = ran.find(a => a[0] === 'find')
  expect(find).toBeDefined()
  expect(find).toContain('-newer')
  expect(find).not.toContain('-newermt')
})

test('Windows: backslash paths shimmer, open hands the path to PowerShell as data, no find, sh or cmd', { timeoutMs: 20_000 }, async ($, on) => {
  const ran: Ran = []
  const root = 'C:/Users/k/proj'
  const clock = world(on, {
    os: 'win32', env: { OS: 'Windows_NT', USERPROFILE: 'C:\\Users\\k' }, cwd: 'C:\\Users\\k\\proj', top: root,
    dirs: { [root]: [['src', 'dir'], ['README.md', 'file'], ['a&calc&%USERNAME%.txt', 'file']], [`${root}/src`]: [['a.ts', 'file']] },
    status: '## main\0 M src/a.ts\0', numstat: '1\t0\tsrc/a.ts\0',
  }, ran)
  await $.session.start({ cwd: 'C:\\Users\\k\\proj', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'filetree', surface: 'terminal', component: 'Pane', requestId: 'filetree', props: paneProps(60) })
  await clock.settle()
  expect(await texts(ui)).toContain('README.md')
  await $.tool.call({ tool: 'Edit', file_path: 'C:\\Users\\k\\proj\\src\\a.ts', old_string: 'a', new_string: 'b' } as any)
  await clock.settle()
  const shown = await texts(ui)
  expect(shown).toContain('a.ts')
  expect(shown).toContain('+1')
  await $.tool.call({ tool: 'Bash', command: 'echo x >> src/a.ts' } as any)
  await clock.settle()
  await ui.post({ press: `${root}/a&calc&%USERNAME%.txt` }, { in: 'rows' })
  await ui.post({ press: `${root}/a&calc&%USERNAME%.txt` }, { in: 'rows' })
  await clock.settle()
  expect(ran).toContainEqual(['powershell', '-NoProfile', '-NonInteractive', '-Command', 'Invoke-Item -LiteralPath $env:FILETREE_OPEN'])
  expect(envs.at(-1)).toEqual({ FILETREE_OPEN: 'C:\\Users\\k\\proj\\a&calc&%USERNAME%.txt' })
  expect(ran.some(a => ['find', 'sh', 'uname', 'setsid', 'touch', 'cmd'].includes(a[0] ?? ''))).toBe(false)
  await ui.unmount()
})

test('Linux unchanged: GNU find -newermt outside a repo, xdg-open detached', { timeoutMs: 20_000 }, async ($, on) => {
  const ran: Ran = []
  const root = '/home/k/scratch'
  const clock = world(on, { os: 'linux', env: { HOME: '/home/k' }, cwd: root, top: '', dirs: { [root]: [['a\\b.txt', 'file'], ['c.txt', 'file']] }, status: '', numstat: '' }, ran)
  await $.session.start({ cwd: root, surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'filetree', surface: 'terminal', component: 'Pane', requestId: 'filetree', props: paneProps(60) })
  await clock.settle()
  expect(await texts(ui)).toContain('a\\\\b.txt')
  await $.tool.call({ tool: 'Bash', command: 'echo hi > c.txt' } as any)
  await clock.settle()
  const find = ran.find(a => a[0] === 'find')
  expect(find).toContain('-newermt')
  expect(ran.some(a => a[0] === 'touch')).toBe(false)
  await ui.post({ press: `${root}/c.txt` }, { in: 'rows' })
  await ui.post({ press: `${root}/c.txt` }, { in: 'rows' })
  await clock.settle()
  const opener = ran.find(a => a[0] === 'setsid')
  expect(opener?.slice(0, 3)).toEqual(['setsid', '-f', 'sh'])
  expect(opener?.at(-1)).toBe(`${root}/c.txt`)
  await ui.unmount()
})

test('macOS app: every header button and the search box work on the desktop surface', { timeoutMs: 20_000 }, async ($, on) => {
  const ran: Ran = []
  const root = '/Users/k/proj'
  const clock = world(on, {
    os: 'darwin', env: { HOME: '/Users/k' }, cwd: root, top: root,
    dirs: { [root]: [['src', 'dir'], ['.env', 'file'], ['README.md', 'file']], [`${root}/src`]: [['a.ts', 'file']], '/Users/k': [['proj', 'dir']] },
    status: '## main\0', numstat: '',
  }, ran)
  await $.session.start({ cwd: root, surface: 'desktop', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'filetree', surface: 'desktop', component: 'Pane', requestId: 'filetree', props: paneProps(60) })
  await clock.settle()
  expect(await texts(ui)).toContain('.env')
  await ui.press({ key: 'hidden' })
  await clock.settle()
  expect(await texts(ui)).not.toContain('.env')
  await ui.press({ key: 'hidden' })
  await ui.input({ key: 'q', text: 'a.ts' })
  await clock.settle()
  const jumped = await texts(ui)
  expect(jumped).toContain('a.ts')
  expect(jumped).toContain('"value":""')
  await ui.press({ key: 'collapse' })
  await clock.settle()
  expect(await texts(ui)).not.toContain(`"id":"${root}/src/a.ts"`)
  await ui.press({ key: 'up' })
  await clock.settle()
  expect(await texts(ui)).toContain('"proj"')
  await ui.press({ key: 'cwd' })
  await clock.settle()
  expect(await texts(ui)).toContain('README.md')
  await ui.unmount()
})

test('outside a repo only git rev-parse runs, never status, diff or ls-files', { timeoutMs: 20_000 }, async ($, on) => {
  const ran: Ran = []
  const root = '/home/k/scratch'
  const clock = world(on, { os: 'linux', env: { HOME: '/home/k' }, cwd: root, top: '', dirs: { [root]: [['c.txt', 'file']] }, status: '', numstat: '' }, ran)
  await $.session.start({ cwd: root, surface: 'terminal', isInteractive: true })
  await clock.settle()
  await $.tool.call({ tool: 'Bash', command: 'echo hi > c.txt' } as any)
  await $.tool.call({ tool: 'Edit', file_path: `${root}/c.txt`, old_string: 'a', new_string: 'b' } as any)
  await clock.settle()
  const gits = ran.filter(a => a[0] === 'git').map(a => a.slice(4).find(x => !x.startsWith('-')))
  expect(gits.length).toBeGreaterThan(0)
  expect(gits.every(v => v === 'rev-parse')).toBe(true)
})

test('NotebookEdit refreshes git and lists the notebook folder', { timeoutMs: 20_000 }, async ($, on) => {
  const ran: Ran = []
  const root = '/home/k/proj'
  const clock = world(on, { os: 'linux', env: { HOME: '/home/k' }, cwd: root, top: root, dirs: { [root]: [['nb', 'dir']], [`${root}/nb`]: [['a.ipynb', 'file']] }, status: '## main\0 M nb/a.ipynb\0', numstat: '4\t2\tnb/a.ipynb\0' }, ran)
  await $.session.start({ cwd: root, surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'filetree', surface: 'terminal', component: 'Pane', requestId: 'filetree', props: paneProps(60) })
  await clock.settle()
  const before = ran.filter(a => a[0] === 'git' && a.includes('status')).length
  await $.tool.call({ tool: 'NotebookEdit', notebook_path: `${root}/nb/a.ipynb`, new_source: 'x' } as any)
  await clock.settle()
  expect(ran.filter(a => a[0] === 'git' && a.includes('status')).length).toBeGreaterThan(before)
  const shown = await texts(ui)
  expect(shown).toContain('a.ipynb')
  expect(shown).toContain('+4')
  await ui.unmount()
})

test('long trees scroll: wheel, scrollbar drag, and a click does not jump the view', { timeoutMs: 20_000 }, async ($, on) => {
  const ran: Ran = []
  const root = '/home/k/big'
  const names = Array.from({ length: 60 }, (_, i) => [`f${String(i).padStart(2, '0')}.txt`, 'file'] as [string, 'file'])
  const clock = world(on, { os: 'linux', env: { HOME: '/home/k' }, cwd: root, top: '', dirs: { [root]: names }, status: '', numstat: '' }, ran)
  await $.session.start({ cwd: root, surface: 'terminal', isInteractive: true })
  await clock.settle()
  const props = { ...paneProps(60), scroll: { offset: 0, bodyRows: 20 } }
  const ui = await $.ui.mount({ plugin: 'filetree', surface: 'terminal', component: 'Pane', requestId: 'filetree', props })
  await clock.settle()
  const rowsOf = async () => ((await ui.drawn()) as any).children.find((c: any) => c.type === 'Client').props.props
  let p = await rowsOf()
  expect(p.bar).toBeDefined()
  expect(p.rows[0].id).toBe(`${root}/f00.txt`)
  expect(JSON.stringify(p.rows)).not.toContain('below')
  await $.ui.scroll({ component: 'Pane', requestId: 'filetree', by: 1 } as any)
  await clock.settle()
  p = await rowsOf()
  expect(p.rows[0].id).toBe(`${root}/f03.txt`)
  await ui.post({ scrollTo: 1 }, { in: 'rows' })
  await clock.settle()
  p = await rowsOf()
  expect(p.rows.at(-1).id).toBe(`${root}/f59.txt`)
  const first = p.rows[0].id
  await ui.post({ press: p.rows[5].id }, { in: 'rows' })
  await clock.settle()
  p = await rowsOf()
  expect(p.rows[0].id).toBe(first)
  expect(p.active).toBe(p.rows[5].id)
  await ui.unmount()
})

test('watches only git metadata, copies paths, clears search, Home and End', { timeoutMs: 20_000 }, async ($, on) => {
  const ran: Ran = []
  const root = '/home/k/proj'
  const clock = world(on, { os: 'linux', env: { HOME: '/home/k' }, cwd: root, top: root, dirs: { [root]: [['.git', 'dir'], ['a.txt', 'file'], ['b.txt', 'file'], ['c.txt', 'file']], [`${root}/.git`]: [['index', 'file'], ['HEAD', 'file']] }, status: '## main\0', numstat: '' }, ran)
  const copied: string[] = []
  on('ui.copy', (_$: any, e: any) => {
    copied.push(e.text)
    return { value: { isCopied: true } }
  })
  on('classic.SessionStart', () => ({}))
  on('classic.FileChanged', () => ({}))
  const started = await $.classic.SessionStart({ source: 'startup', cwd: root } as any)
  expect((started as any).watchPaths).toEqual([`${root}/.git/index`, `${root}/.git/HEAD`])
  await $.session.start({ cwd: root, surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'filetree', surface: 'terminal', component: 'Pane', requestId: 'filetree', props: paneProps(60) })
  await clock.settle()
  await ui.post({ copy: `${root}/b.txt` }, { in: 'rows' })
  await ui.post({ copy: `${root}/b.txt`, shift: true }, { in: 'rows' })
  await clock.settle()
  expect(copied).toEqual(['b.txt', `${root}/b.txt`])
  await ui.input({ key: 'q', text: 'b', kind: 'change' })
  await clock.settle()
  expect(await ui.find({ key: 'clear' })).toBeDefined()
  await ui.press({ key: 'clear' })
  await clock.settle()
  expect(await ui.find({ key: 'clear' })).toBeUndefined()
  await ui.post({ key: 'end' }, { in: 'rows' })
  await clock.settle()
  const rowsOf = async () => ((await ui.drawn()) as any).children.find((c: any) => c.type === 'Client').props.props
  expect((await rowsOf()).active).toBe(`${root}/c.txt`)
  await ui.post({ key: 'home' }, { in: 'rows' })
  await clock.settle()
  expect((await rowsOf()).active).toBe(`${root}/.git`)
  const before = ran.filter(a => a.includes('status')).length
  await $.classic.FileChanged({ file_path: `${root}/.git/index`, event: 'change' } as any)
  await clock.advance(400)
  expect(ran.filter(a => a.includes('status')).length).toBeGreaterThan(before)
  await ui.unmount()
})

test('sidebar only: no pane in the default layout, and an inline pane closes itself', { timeoutMs: 20_000 }, async ($, on) => {
  const ran: Ran = []
  const root = '/home/k/proj'
  const clock = world(on, { os: 'linux', env: { HOME: '/home/k' }, cwd: root, top: '', dirs: { [root]: [['a.txt', 'file']] }, status: '', numstat: '' }, ran)
  const opened = opens
  const closed: unknown[] = []
  on('ui.close', (_$: any, e: any) => {
    closed.push(e)
    return { value: undefined }
  })
  await $.session.start({ cwd: root, surface: 'terminal', isInteractive: true })
  await clock.settle()
  const before = opened.length
  const r = await $.command.run({ command: 'filetree', args: '', origin: { kind: 'person' }, presentation: { isFullscreen: false, columns: 200 } } as any)
  expect(JSON.stringify(r)).toContain('/tui fullscreen')
  expect(opened.length).toBe(before)
  const ui = await $.ui.mount({ plugin: 'filetree', surface: 'terminal', component: 'Pane', requestId: 'filetree', props: { ...paneProps(60), placement: 'inline' } })
  await clock.settle()
  expect(closed.length).toBeGreaterThan(0)
  await ui.unmount()
})

const shimmer = (name: string, tone: string) => `"t":${JSON.stringify(name)},"sh":"${tone}"`
const fullscreen = (args: string) => ({ command: 'filetree', args, origin: { kind: 'person' }, presentation: { isFullscreen: true, columns: 200 } }) as any

test('after /clear the tree rebuilds itself, keeps a pinned folder, and an empty root never loops', { timeoutMs: 20_000 }, async ($, on) => {
  const ran: Ran = []
  const root = '/home/k/proj'
  const clock = world(on, { os: 'linux', env: { HOME: '/home/k' }, cwd: root, top: '', dirs: { [root]: [['a.ts', 'file'], ['sub', 'dir']], [`${root}/sub`]: [['b.ts', 'file']] }, status: '', numstat: '' }, ran)
  on('classic.SessionStart', () => ({}))
  expect(ancestorsOf('/repo/a.ts', '')).toEqual([])
  expect(ancestorsOf('/repo2/a.ts', '/repo')).toEqual([])
  const ui = await $.ui.mount({ plugin: 'filetree', surface: 'terminal', component: 'Pane', requestId: 'filetree', props: paneProps(60) })
  await $.tool.call({ tool: 'Read', file_path: `${root}/a.ts` } as any)
  await clock.settle()
  await $.classic.SessionStart({ source: 'clear', cwd: root } as any)
  await clock.settle()
  expect(await texts(ui)).toContain(`"id":"${root}/a.ts"`)
  await $.command.run(fullscreen(`${root}/sub`))
  await clock.settle()
  await $.classic.SessionStart({ source: 'clear', cwd: root } as any)
  await clock.settle()
  const shown = await texts(ui)
  expect(shown).toContain(`"id":"${root}/sub/b.ts"`)
  expect(shown).not.toContain(`"id":"${root}/a.ts"`)
  await ui.unmount()
})

test('opener failures show a toast instead of failing silently', { timeoutMs: 20_000 }, async ($, on) => {
  const ran: Ran = []
  const root = '/Users/k/proj'
  const clock = world(on, { os: 'darwin', env: { HOME: '/Users/k' }, cwd: root, top: '', dirs: { [root]: [['a.xyz', 'file']] }, status: '', numstat: '', exits: { open: [1, 'No application knows how to open a.xyz\n'] } }, ran)
  await $.session.start({ cwd: root, surface: 'desktop', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'filetree', surface: 'desktop', component: 'Pane', requestId: 'filetree', props: paneProps(60) })
  await ui.post({ press: `${root}/a.xyz` }, { in: 'rows' })
  await ui.post({ press: `${root}/a.xyz` }, { in: 'rows' })
  await clock.settle()
  expect(ran).toContainEqual(['open', `${root}/a.xyz`])
  expect(ran.some(a => a[0] === 'toast' && (a[1] ?? '').includes('No application knows how to open a.xyz'))).toBe(true)
  await ui.unmount()
})

test('an older directory listing never overwrites a newer one', { timeoutMs: 20_000 }, async ($, on) => {
  const ran: Ran = []
  const root = '/home/k/scratch'
  const w: World = { os: 'linux', env: { HOME: '/home/k' }, cwd: root, top: '', dirs: { [root]: [['old.txt', 'file']] }, status: '', numstat: '', delays: {} }
  const clock = world(on, w, ran)
  await $.session.start({ cwd: root, surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'filetree', surface: 'terminal', component: 'Pane', requestId: 'filetree', props: paneProps(60) })
  w.delays = { [root]: [1_000] }
  await ui.press({ key: 'refresh' })
  w.dirs[root] = [['new.txt', 'file']]
  await ui.press({ key: 'refresh' })
  await clock.settle()
  expect(await texts(ui)).toContain('new.txt')
  await clock.advance(1_500)
  const shown = await texts(ui)
  expect(shown).toContain('new.txt')
  expect(shown).not.toContain('old.txt')
  await ui.unmount()
})

test('a listing error keeps the cached rows and says so', { timeoutMs: 20_000 }, async ($, on) => {
  const ran: Ran = []
  const root = '/home/k/scratch'
  const w: World = { os: 'linux', env: { HOME: '/home/k' }, cwd: root, top: '', dirs: { [root]: [['a.txt', 'file']] }, status: '', numstat: '' }
  const clock = world(on, w, ran)
  await $.session.start({ cwd: root, surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'filetree', surface: 'terminal', component: 'Pane', requestId: 'filetree', props: paneProps(60) })
  w.denied = [root]
  await ui.press({ key: 'refresh' })
  await clock.settle()
  expect(await texts(ui)).toContain(`"id":"${root}/a.txt"`)
  expect(ran.some(a => a[0] === 'toast' && (a[1] ?? '').includes('could not list'))).toBe(true)
  await ui.unmount()
})

test('replacing many folders in one batch keeps unchanged nodes and drops what vanished', async () => {
  const dir = (id: string, loaded: boolean) => ({ id, parent: id.slice(0, id.lastIndexOf('/')) || '/', name: id.slice(id.lastIndexOf('/') + 1), kind: 'dir' as const, hidden: false, mtime: 0, loaded })
  const file = (id: string) => ({ ...dir(id, false), kind: 'file' as const })
  const nodes = [dir('/r/a', true), dir('/r/b', true), file('/r/a/x'), dir('/r/b/y', true), file('/r/b/y/z')]
  const out = replaceChildren(nodes, new Map([
    ['/r/a', toNodes('/r/a', [{ name: 'w', kind: 'file', mtimeMs: 0, isLink: false }])],
    ['/r/b', []],
    ['/r/b/y', toNodes('/r/b/y', [{ name: 'z', kind: 'file', mtimeMs: 0, isLink: false }])],
  ]))
  expect(out.map(n => n.id).sort()).toEqual(['/r/a', '/r/a/w', '/r/b'])
  expect(out.find(n => n.id === '/r/b')?.loaded).toBe(true)
})

test('a cwd change moves the tree and drops the old selection before the next prompt', { timeoutMs: 20_000 }, async ($, on) => {
  const ran: Ran = []
  const a = '/home/k/repo-a'
  const b = '/home/k/repo-b'
  const c = '/home/k/repo-c'
  const w: World = { os: 'linux', env: { HOME: '/home/k' }, cwd: a, top: '', dirs: { [a]: [['a.txt', 'file']], [b]: [['b.txt', 'file']], [c]: [['c.txt', 'file']] }, status: '', numstat: '' }
  const clock = world(on, w, ran)
  on('classic.CwdChanged', () => ({}))
  await $.session.start({ cwd: a, surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'filetree', surface: 'terminal', component: 'Pane', requestId: 'filetree', props: paneProps(60) })
  await ui.post({ press: `${a}/a.txt` }, { in: 'rows' })
  await clock.settle()
  w.cwd = b
  const sent = await $.prompt.submit({ text: 'what is this?', wait: false } as any)
  expect(JSON.stringify(sent)).not.toContain(`${a}/a.txt`)
  await clock.settle()
  expect(await texts(ui)).toContain('b.txt')
  w.cwd = c
  await $.classic.CwdChanged({ old_cwd: b, new_cwd: c } as any)
  await clock.settle()
  expect(await texts(ui)).toContain('c.txt')
  await ui.unmount()
})

test('a background git push stays running until its task notification arrives', { timeoutMs: 20_000 }, async ($, on) => {
  const ran: Ran = []
  const root = '/home/k/proj'
  const clock = world(on, {
    os: 'linux', env: { HOME: '/home/k' }, cwd: root, top: root, dirs: { [root]: [['a.txt', 'file']] }, status: '## main\0', numstat: '',
    tool: e => ({ result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: e.command === 'git push' ? 'b1' : 'b2' } }),
  }, ran)
  await $.session.start({ cwd: root, surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'filetree', surface: 'terminal', component: 'Pane', requestId: 'filetree', props: paneProps(60) })
  await $.tool.call({ tool: 'Bash', command: 'git push', run_in_background: true } as any)
  await clock.settle()
  expect(await texts(ui)).toContain('pushing…')
  expect(await texts(ui)).not.toContain('pushed')
  await $.prompt.submit({ text: '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>Background command "git push" completed (exit code 0)</summary>\n</task-notification>', wait: false } as any)
  await clock.settle()
  expect(await texts(ui)).toContain('pushed')
  await $.tool.call({ tool: 'Bash', command: 'git pull', run_in_background: true } as any)
  await clock.settle()
  await $.prompt.submit({ text: '<task-notification>\n<task-id>b2</task-id>\n<status>failed</status>\n<summary>Background command "git pull" failed with exit code 1</summary>\n</task-notification>', wait: false } as any)
  await clock.settle()
  expect(await texts(ui)).toContain('pull failed')
  await ui.unmount()
})

test('a failed Bash command still refreshes what it changed before failing', { timeoutMs: 20_000 }, async ($, on) => {
  const ran: Ran = []
  const root = '/home/k/proj'
  const w: World = { os: 'linux', env: { HOME: '/home/k' }, cwd: root, top: root, dirs: { [root]: [['a.txt', 'file'], ['b.txt', 'file']] }, status: '## main\0', numstat: '', tool: () => ({ isError: true, result: 'Exit code 1' }) }
  const clock = world(on, w, ran)
  await $.session.start({ cwd: root, surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'filetree', surface: 'terminal', component: 'Pane', requestId: 'filetree', props: paneProps(60) })
  expect(await texts(ui)).toContain(`"id":"${root}/a.txt"`)
  const before = ran.filter(a => a.includes('status')).length
  w.dirs[root] = [['b.txt', 'file']]
  await $.tool.call({ tool: 'Bash', command: 'rm a.txt && false' } as any)
  await clock.settle()
  expect(ran.filter(a => a.includes('status')).length).toBeGreaterThan(before)
  expect(await texts(ui)).not.toContain(`"id":"${root}/a.txt"`)
  await ui.unmount()
})

test('git activity is only certified by evidence: HEAD for commits, the exit code only for plain && chains', { timeoutMs: 20_000 }, async ($, on) => {
  const ran: Ran = []
  const root = '/home/k/proj'
  const w: World = { os: 'linux', env: { HOME: '/home/k' }, cwd: root, top: root, dirs: { [root]: [['a.txt', 'file']] }, status: '## main\0', numstat: '', heads: ['abc1234def0'] }
  const clock = world(on, w, ran)
  await $.session.start({ cwd: root, surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'filetree', surface: 'terminal', component: 'Pane', requestId: 'filetree', props: paneProps(60) })
  await $.tool.call({ tool: 'Bash', command: 'git commit -m test || true' } as any)
  await clock.settle()
  let shown = await texts(ui)
  expect(shown).toContain('commit failed')
  expect(shown).not.toContain('committed')
  expect(ran.some(a => a.includes('diff-tree'))).toBe(false)
  w.heads = ['abc1234def0', 'fed4321cba9']
  await $.tool.call({ tool: 'Bash', command: 'git commit -m real' } as any)
  await clock.settle()
  shown = await texts(ui)
  expect(shown).toContain('committed')
  expect(shown).toContain('fed4321')
  await $.tool.call({ tool: 'Bash', command: 'git push; echo done' } as any)
  await clock.settle()
  expect(await texts(ui)).toContain('ran git push')
  await $.tool.call({ tool: 'Bash', command: 'git fetch && git status' } as any)
  await clock.settle()
  expect(await texts(ui)).toContain('fetched')
  await ui.unmount()
})

test('unknown git verbs count as writers and read-only commands skip git work', { timeoutMs: 20_000 }, async ($, on) => {
  const ran: Ran = []
  const root = '/home/k/proj'
  const w: World = { os: 'linux', env: { HOME: '/home/k' }, cwd: root, top: root, dirs: { [root]: [['README.md', 'file'], ['gone.txt', 'file']] }, status: '## main\0', numstat: '' }
  const clock = world(on, w, ran)
  await $.session.start({ cwd: root, surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'filetree', surface: 'terminal', component: 'Pane', requestId: 'filetree', props: paneProps(60) })
  const statuses = () => ran.filter(a => a[0] === 'git' && a.includes('status')).length
  let before = statuses()
  await $.tool.call({ tool: 'Bash', command: 'cat README.md' } as any)
  await $.tool.call({ tool: 'Bash', command: 'git status' } as any)
  await clock.settle()
  expect(statuses()).toBe(before)
  expect(ran.some(a => a[0] === 'find')).toBe(false)
  w.dirs[root] = [['README.md', 'file']]
  before = statuses()
  await $.tool.call({ tool: 'Bash', command: 'git clean -fd' } as any)
  await clock.settle()
  expect(statuses()).toBeGreaterThan(before)
  expect(ran.some(a => a[0] === 'find')).toBe(true)
  expect(await texts(ui)).not.toContain('gone.txt')
  await ui.unmount()
})

test('search matches relative paths and refresh picks up files added since the index was built', { timeoutMs: 20_000 }, async ($, on) => {
  const ran: Ran = []
  const root = '/home/k/proj'
  const w: World = { os: 'linux', env: { HOME: '/home/k' }, cwd: root, top: root, dirs: { [root]: [['src', 'dir'], ['alpha.txt', 'file']], [`${root}/src`]: [['a.ts', 'file']] }, status: '## main\0', numstat: '' }
  const clock = world(on, w, ran)
  await $.session.start({ cwd: root, surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'filetree', surface: 'terminal', component: 'Pane', requestId: 'filetree', props: paneProps(60) })
  await ui.input({ key: 'q', text: 'src/a.ts', kind: 'change' })
  await clock.settle()
  expect(await texts(ui)).toContain(`"id":"${root}/src/a.ts"`)
  await ui.input({ key: 'q', text: 'alpha', kind: 'change' })
  await clock.settle()
  w.dirs[`${root}/src`] = [['a.ts', 'file'], ['beta.ts', 'file']]
  await ui.press({ key: 'refresh' })
  await ui.input({ key: 'q', text: 'beta', kind: 'change' })
  await clock.settle()
  expect(await texts(ui)).toContain(`"id":"${root}/src/beta.ts"`)
  await ui.unmount()
})

test('a pinned path with dot segments resolves to the same folder', { timeoutMs: 20_000 }, async ($, on) => {
  const ran: Ran = []
  const root = '/home/k/proj'
  const clock = world(on, { os: 'linux', env: { HOME: '/home/k' }, cwd: '/home/k', top: '', dirs: { [root]: [['a.ts', 'file']], [`${root}/src`]: [] }, status: '', numstat: '' }, ran)
  await $.session.start({ cwd: '/home/k', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const r = await $.command.run(fullscreen(`${root}/./src/..`))
  expect(JSON.stringify(r)).toContain('File tree on ~/proj.')
})

test('a written file whose name holds a newline still shimmers', { timeoutMs: 20_000 }, async ($, on) => {
  const ran: Ran = []
  const root = '/home/k/scratch'
  const clock = world(on, { os: 'linux', env: { HOME: '/home/k' }, cwd: root, top: '', dirs: { [root]: [['a\nb.ts', 'file'], ['c.txt', 'file']] }, status: '', numstat: '', find: `${root}/a\nb.ts\0` }, ran)
  await $.session.start({ cwd: root, surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'filetree', surface: 'terminal', component: 'Pane', requestId: 'filetree', props: paneProps(60) })
  await $.tool.call({ tool: 'Bash', command: 'touch "a\nb.ts"' } as any)
  await clock.settle()
  expect(ran.find(a => a[0] === 'find')).toContain('-print0')
  expect(await texts(ui)).toContain(shimmer('a\nb.ts', 'orange'))
  await ui.unmount()
})

test('/filetree toggles: closes the open pane, reopens it, and a path always retargets', { timeoutMs: 20_000 }, async ($, on) => {
  const ran: Ran = []
  const root = '/home/k/proj'
  const clock = world(on, { os: 'linux', env: { HOME: '/home/k' }, cwd: root, top: '', dirs: { [root]: [['a.ts', 'file'], ['sub', 'dir']], [`${root}/sub`]: [['b.ts', 'file']] }, status: '', numstat: '' }, ran)
  const closed: any[] = []
  on('ui.close', (_$: any, e: any) => {
    closed.push(e)
    return { value: undefined }
  })
  await $.session.start({ cwd: root, surface: 'terminal', isInteractive: true })
  await clock.settle()
  const opened = opens.length
  const gone = await $.command.run(fullscreen(''))
  await clock.settle()
  expect(JSON.stringify(gone)).toContain('File tree closed.')
  expect(closed.map(c => c.id)).toEqual(['filetree'])
  expect(opens.length).toBe(opened)
  const back = await $.command.run(fullscreen(''))
  await clock.settle()
  expect(JSON.stringify(back)).toContain('File tree on ~/proj')
  expect(opens.length).toBe(opened + 1)
  await $.command.run(fullscreen(`${root}/sub`))
  await clock.settle()
  expect(closed.length).toBe(1)
  expect(opens.length).toBe(opened + 2)
  const ui = await $.ui.mount({ plugin: 'filetree', surface: 'terminal', component: 'Pane', requestId: 'filetree', props: paneProps(60) })
  await ui.press({ key: 'close' })
  await clock.settle()
  expect(closed.length).toBe(2)
  const again = await $.command.run(fullscreen(''))
  await clock.settle()
  expect(JSON.stringify(again)).toContain('File tree on')
  expect(closed.length).toBe(2)
  expect(opens.length).toBe(opened + 3)
  await ui.unmount()
})

test('the pane has its own close control, away from the top right', { timeoutMs: 20_000 }, async ($, on) => {
  const ran: Ran = []
  const root = '/home/k/proj'
  const clock = world(on, { os: 'linux', env: { HOME: '/home/k' }, cwd: root, top: '', dirs: { [root]: [['a.ts', 'file']] }, status: '', numstat: '' }, ran)
  const closed: any[] = []
  on('ui.close', (_$: any, e: any) => {
    closed.push(e)
    return { value: undefined }
  })
  await $.session.start({ cwd: root, surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'filetree', surface: 'terminal', component: 'Pane', requestId: 'filetree', props: paneProps(60) })
  await clock.settle()
  const tree = (await ui.drawn()) as any
  const last = tree.children.at(-1)
  expect(JSON.stringify(last)).toContain('"key":"close"')
  expect(JSON.stringify(tree.children[0])).not.toContain('"key":"close"')
  expect(await ui.find({ key: 'close' })).toBeDefined()
  await ui.press({ key: 'close' })
  await clock.settle()
  expect(closed.map(c => c.id)).toEqual(['filetree'])
  await ui.unmount()
})

const drawnCells = (segs: { t: string }[]) => segs.reduce((n, seg) => n + cellWidth(seg.t), 0)

test('narrow pane: no row is wider than the pane and no wide glyph sits in the last cell', { timeoutMs: 20_000 }, async ($, on) => {
  const ran: Ran = []
  const root = '/home/k/proj'
  const names = Array.from({ length: 30 }, (_, i) => [`file-with-a-long-name-${i}.ts`, 'file'] as [string, 'file'])
  const clock = world(on, {
    os: 'linux', env: { HOME: '/home/k', SSH_CONNECTION: '1 2 3 4' }, cwd: root, top: root,
    dirs: { [root]: [['sub', 'dir'], ['debug.log', 'file'], ['Defaults.json', 'file'], ...names], [`${root}/sub`]: [['x.ts', 'file']] },
    status: '## main\0 M Defaults.json\0!! debug.log\0 M file-with-a-long-name-3.ts\0', numstat: '5\t2\tDefaults.json\0',
  }, ran)
  await $.session.start({ cwd: root, surface: 'terminal', isInteractive: true })
  await clock.settle()
  for (const columns of [30, 14]) {
    const props = { ...paneProps(columns), scroll: { offset: 0, bodyRows: 12 } }
    const ui = await $.ui.mount({ plugin: 'filetree', surface: 'terminal', component: 'Pane', requestId: 'filetree', props })
    await clock.settle()
    const p = ((await ui.drawn()) as any).children.find((c: any) => c.type === 'Client').props.props
    expect(p.bar).toBeDefined()
    expect(JSON.stringify(p.rows)).toContain('debug.log')
    expect(JSON.stringify(p.rows)).toContain('\uf05e')
    for (const row of p.rows as { id: string; left: { t: string }[]; right: { t: string }[] }[]) {
      const last = [...row.left, ...row.right].filter(seg => seg.t).at(-1)?.t ?? ''
      expect(NERD.test([...last].at(-1) ?? '')).toBe(false)
      if (row.id) expect(drawnCells(row.left) + drawnCells(row.right)).toBeLessThanOrEqual(Math.max(columns, 12) - 1)
    }
    await ui.unmount()
  }
})

test('names are cut by terminal cells, wide characters count twice', () => {
  expect(cellWidth('abc')).toBe(3)
  expect(cellWidth('日本語')).toBe(6)
  expect(clip('abcdef', 4)).toBe('abc…')
  expect(clip('日本語', 5)).toBe('日本…')
  expect(clip('abc', 3)).toBe('abc')
})

const PATCH = 'diff --git a/src/a.ts b/src/a.ts\nindex 1111111..2222222 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,4 @@ function a()\n one\n-two\n+two!\n+three\n four\n'

test('a diff is cut to the first hunk header and kept whole when it fits', () => {
  const shaped = shapeDiff(PATCH)
  expect(shaped?.source.startsWith('@@ -1,3 +1,4 @@ function a()\n')).toBe(true)
  expect(shaped?.source).not.toContain('diff --git')
  expect(shaped?.omitted).toBe(0)
  expect(shapeDiff('Binary files a/x and b/x differ\n')).toBeNull()
  expect(shapeDiff('')).toBeNull()
  expect(shapeDiff('@@ -1 +1 @@\n-a\r\n+b\u001b[0m\n')?.source).toBe('@@ -1 +1 @@\n-a\n+b[0m\n')
})

test('a long diff keeps whole hunks, and a single huge hunk is cut with its counts rewritten', () => {
  const hunk = (at: number, n: number) => `@@ -${at},${n} +${at},${n} @@\n${Array.from({ length: n }, (_, i) => ` line ${at + i} ${'x'.repeat(40)}`).join('\n')}\n`
  const many = shapeDiff(hunk(1, 100) + hunk(500, 100) + hunk(900, 100))
  expect(many?.source.length).toBeLessThanOrEqual(DIFF_LIMIT)
  expect(many?.source.match(/^@@/gm)?.length).toBe(2)
  expect(many?.omitted).toBeGreaterThan(0)
  const huge = shapeDiff(hunk(1, 1000))
  expect(huge?.source.length).toBeLessThanOrEqual(DIFF_LIMIT)
  const [header = '', ...body] = (huge?.source ?? '').split('\n').filter(Boolean)
  expect(header).toBe(`@@ -1,${body.length} +1,${body.length} @@`)
  expect(huge?.omitted).toBe(1000 - body.length)
})

test('a cut hunk never ends past the limit, even when its rewritten counts are longer than the estimate', () => {
  const hunk = `@@ -10000,900 +10000,900 @@\n${Array.from({ length: 900 }, (_, i) => `+${'y'.repeat(i % 13)}`).join('\n')}\n`
  for (let limit = 60; limit < 700; limit += 7) {
    const shaped = shapeDiff(hunk, limit)
    expect((shaped?.source ?? '').length).toBeLessThanOrEqual(limit)
  }
})

test('C1 control characters are stripped from the diff too', () => {
  expect(shapeDiff('@@ -1 +1 @@\n-a\n+b\u0085c\u009b\n')?.source).toBe('@@ -1 +1 @@\n-a\n+bc\n')
})

const changedWorld = (on0: any, ran: Ran, over: Partial<World> = {}) => {
  const root = '/home/k/proj'
  const patches: string[][] = []
  const clock = world(on0, {
    os: 'linux', env: { HOME: '/home/k' }, cwd: root, top: root,
    dirs: { [root]: [['src', 'dir'], ['clean.ts', 'file'], ['new.ts', 'file'], ['logo.png', 'file']], [`${root}/src`]: [['a.ts', 'file']] },
    status: '## main\0 M src/a.ts\0?? new.ts\0 M logo.png\0', numstat: '2\t1\tsrc/a.ts\0',
    patch: argv => {
      patches.push(argv)
      return argv.includes('--no-index') ? { exitCode: 1, stdout: 'diff --git a/new.ts b/new.ts\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1,2 @@\n+hello\n+world\n' } : argv.includes('logo.png') ? { exitCode: 0, stdout: 'diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ\n' } : { exitCode: 0, stdout: PATCH }
    },
    ...over,
  }, ran)
  return { root, patches, clock }
}
test('pressing the diff action of a changed file opens its git diff in a second pane', { timeoutMs: 20_000 }, async ($, on) => {
  const ran: Ran = []
  const { root, patches, clock } = changedWorld(on, ran)
  const closed: any[] = []
  on('ui.close', (_$: any, e: any) => {
    closed.push(e)
    return { value: undefined }
  })
  await $.session.start({ cwd: root, surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'filetree', surface: 'terminal', component: 'Pane', requestId: 'filetree', props: paneProps(60) })
  await clock.settle()
  await ui.post({ press: `${root}/src` }, { in: 'rows' })
  await clock.settle()
  const rows = ((await ui.drawn()) as any).children.find((c: any) => c.type === 'Client').props.props.rows
  const row = rows.find((r: any) => r.id === `${root}/src/a.ts`)
  expect(row.right.some((s: any) => s.diff === true)).toBe(true)
  expect(rows.find((r: any) => r.id === `${root}/clean.ts`).right.some((s: any) => s.diff)).toBe(false)
  const before = opens.length
  await ui.post({ diff: `${root}/src/a.ts` }, { in: 'rows' })
  await clock.settle()
  expect(opens.slice(before)).toEqual([{ id: 'filetree-diff', title: 'Diff: a.ts', focus: true, closeOnEscape: true }])
  expect(patches.at(-1)).toContain('HEAD')
  expect(patches.at(-1)?.at(-1)).toBe('src/a.ts')
  const view = await $.ui.mount({ plugin: 'filetree', surface: 'terminal', component: 'Pane', requestId: 'filetree-diff', props: paneProps(60) })
  await clock.settle()
  const code = await view.find({ type: 'Code' })
  expect((code as any).props).toMatchObject({ format: 'diff', path: 'src/a.ts' })
  expect((code as any).props.source.startsWith('@@ -1,3 +1,4 @@')).toBe(true)
  await view.press({ key: 'close' })
  await clock.settle()
  expect(closed.map(c => c.id)).toEqual(['filetree-diff'])
  await view.unmount()
  await ui.unmount()
})

test('the d key shows the diff of an untracked file; clean, binary and empty diffs say so instead', { timeoutMs: 20_000 }, async ($, on) => {
  const ran: Ran = []
  const { root, patches, clock } = changedWorld(on, ran)
  await $.session.start({ cwd: root, surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'filetree', surface: 'terminal', component: 'Pane', requestId: 'filetree', props: paneProps(60) })
  const view = await $.ui.mount({ plugin: 'filetree', surface: 'terminal', component: 'Pane', requestId: 'filetree-diff', props: paneProps(60) })
  await clock.settle()
  const show = async (name: string) => {
    await ui.post({ press: `${root}/${name}` }, { in: 'rows' })
    await ui.post({ key: 'd' }, { in: 'rows' })
    await clock.settle()
  }
  await show('new.ts')
  expect(patches.at(-1)).toEqual(expect.arrayContaining(['--no-index', '/dev/null', 'new.ts']))
  expect(((await view.find({ type: 'Code' })) as any).props.source).toBe('@@ -0,0 +1,2 @@\n+hello\n+world\n')
  await show('logo.png')
  expect(await view.find({ type: 'Code' })).toBeUndefined()
  expect(JSON.stringify(await view.drawn())).toContain('Binary file')
  const calls = patches.length
  const before = opens.length
  await show('clean.ts')
  expect(patches.length).toBe(calls)
  expect(opens.length).toBe(before)
  expect(ran.some(a => a[0] === 'toast' && (a[1] ?? '').includes('clean.ts has no changes'))).toBe(true)
  await view.unmount()
  await ui.unmount()
})

test('diff errors, empty diffs and very long diffs are told, not hidden', { timeoutMs: 20_000 }, async ($, on) => {
  const ran: Ran = []
  let mode = 'empty'
  const big = '@@ -1,900 +1,900 @@\n' + Array.from({ length: 900 }, (_, i) => `-old line ${i} ${'y'.repeat(30)}`).join('\n') + '\n'
  const { root, clock } = changedWorld(on, ran, {
    patch: () => (mode === 'empty' ? { exitCode: 0, stdout: '' } : mode === 'fail' ? { exitCode: 128, stdout: '', stderr: 'fatal: bad revision\nmore' } : { exitCode: 0, stdout: big }),
  })
  await $.session.start({ cwd: root, surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'filetree', surface: 'terminal', component: 'Pane', requestId: 'filetree', props: paneProps(60) })
  const view = await $.ui.mount({ plugin: 'filetree', surface: 'terminal', component: 'Pane', requestId: 'filetree-diff', props: paneProps(60) })
  await clock.settle()
  await ui.post({ press: `${root}/src` }, { in: 'rows' })
  const show = async () => {
    await ui.post({ diff: `${root}/new.ts` }, { in: 'rows' })
    await clock.settle()
    return JSON.stringify(await view.drawn())
  }
  expect(await show()).toContain('No textual changes')
  mode = 'fail'
  expect(await show()).toContain('git diff failed: fatal: bad revision')
  mode = 'big'
  const shown = await show()
  expect(shown).toContain('more diff lines not shown')
  expect(((await view.find({ type: 'Code' })) as any).props.source.length).toBeLessThanOrEqual(DIFF_LIMIT)
  await view.unmount()
  await ui.unmount()
})
