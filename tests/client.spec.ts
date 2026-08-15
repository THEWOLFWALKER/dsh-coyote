import { readFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { GuiBridge } from '../src/gui/bridge.ts'
import { CoyoteRuntime } from '../src/runtime/runtime.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// ───────────────────── mini React for structural rendering ─────────────────────

interface FakeElement {
  type: string | ((props: unknown) => unknown)
  props: Record<string, unknown> & { children?: unknown }
  children: unknown[]
}

interface HookSlot {
  value?: unknown
}

/** Per-component hook storage + render bookkeeping; no DOM, no scheduler. */
function makeFakeReact() {
  const registry = new Map<unknown, { hooks: HookSlot[]; index: number }>()
  const effects: Array<{ effect: () => void | (() => void); cleanup?: () => void; ran: boolean }> = []
  let current: { hooks: HookSlot[]; index: number } | null = null

  function createElement(
    type: string | ((props: unknown) => unknown),
    props?: Record<string, unknown> | null,
    ...children: unknown[]
  ): FakeElement {
    return {
      type,
      props: props ?? {},
      children: children.flat(9).filter(child => child !== null && child !== undefined && child !== false && child !== true),
    }
  }

  function useState(initial: unknown): [unknown, (value: unknown) => void] {
    if (current === null) throw new Error('useState outside render')
    const i = current.index++
    const slot = current.hooks[i] ?? { value: typeof initial === 'function' ? (initial as () => unknown)() : initial }
    if (current.hooks[i] === undefined) current.hooks[i] = slot
    return [
      slot.value,
      (value: unknown) => {
        slot.value = typeof value === 'function' ? (value as (prev: unknown) => unknown)(slot.value) : value
      },
    ]
  }

  function useEffect(effect: () => void | (() => void)): void {
    effects.push({ effect, ran: false })
  }

  function useRef(initial: unknown): { current: unknown } {
    if (current === null) throw new Error('useRef outside render')
    const i = current.index++
    if (current.hooks[i] === undefined) current.hooks[i] = { value: { current: initial } }
    return (current.hooks[i] as { value: { current: unknown } }).value
  }

  function useCallback<T>(fn: T): T {
    return fn
  }

  /** Render one component function; hook state persists across invocations. */
  function invoke(fn: (props: never) => unknown, props: unknown): unknown {
    let slot = registry.get(fn)
    if (slot === undefined) {
      slot = { hooks: [], index: 0 }
      registry.set(fn, slot)
    }
    slot.index = 0
    current = slot
    const result = (fn as unknown as (p: unknown) => unknown)(props)
    current = null
    return result
  }

  /** Run pending effects once (mount semantics); records cleanups. */
  function flushEffects(): void {
    for (const entry of effects) {
      if (entry.ran) continue
      entry.ran = true
      const cleanup = entry.effect()
      if (typeof cleanup === 'function') entry.cleanup = cleanup
    }
  }

  /** Run recorded effect cleanups (unmount semantics). */
  function flushCleanups(): void {
    for (const entry of effects) entry.cleanup?.()
  }

  return { createElement, useState, useEffect, useRef, useCallback, Fragment: 'fragment', invoke, flushEffects, flushCleanups }
}

/** Depth-first search for elements matching a predicate. */
function findAll(node: unknown, pred: (el: FakeElement) => boolean, out: FakeElement[] = []): FakeElement[] {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (typeof (node as FakeElement).type !== 'undefined' && 'props' in (node as FakeElement)) {
    const el = node as FakeElement
    if (pred(el)) out.push(el)
    for (const child of [el.props.children, ...el.children]) findAll(child, pred, out)
  }
  return out
}

const textOf = (node: unknown): string => {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && 'children' in (node as FakeElement)) {
    return textOf((node as FakeElement).children) + textOf((node as FakeElement).props.children)
  }
  return ''
}

// ───────────────────── load the client bundle once ─────────────────────

const localStorageStore = new Map<string, string>()
;(globalThis as Record<string, unknown>).localStorage = {
  getItem: (key: string) => (localStorageStore.has(key) ? localStorageStore.get(key) : null),
  setItem: (key: string, value: string) => localStorageStore.set(key, String(value)),
  removeItem: (key: string) => localStorageStore.delete(key),
}

interface Handoff {
  id: string
  factory: (require: (spec: string) => unknown) => unknown
}

let handoff: Handoff | undefined
;(globalThis as Record<string, unknown>).__DSH_COYOTE_TEST__ = {}
;(globalThis as Record<string, unknown>).window = {
  __ModuleLoader__: { load: (h: Handoff) => { handoff = h } },
}

const bundleSource = readFileSync(join(root, 'client/index.js'), 'utf8')
;(0, eval)(bundleSource)

const fakeReact = makeFakeReact()
function requireFactory(spec: string): unknown {
  if (spec === 'react') return fakeReact
  throw new Error(`unexpected require in factory: ${spec}`)
}
const loaded = handoff as Handoff | undefined
if (loaded === undefined) throw new Error('bundle never called window.__ModuleLoader__.load')
const moduleExports = loaded.factory(requireFactory) as {
  name: string
  inject: string[]
  apply: (ctx: unknown) => void
}
/* Test-hook surface: plain functions/classes from the bundle. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const T = ((globalThis as Record<string, unknown>).__DSH_COYOTE_TEST__ as { exports: Record<string, any> }).exports

// ───────────────────── shared fixture: a real runtime + bridge ─────────────────────

describe('coyote client bundle', () => {
  let dir: string
  let runtime: CoyoteRuntime
  let bridge: GuiBridge
  let guiUrl: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'coyote-client-'))
  })

  afterEach(async () => {
    await runtime?.dispose()
  })

  async function makeRuntime(): Promise<string> {
    runtime = new CoyoteRuntime(
      { server: { port: 0, bindTimeoutMs: 60_000, heartbeatIntervalMs: 60_000 }, waveformDir: dir, sessionCooldownSec: 0 },
      () => {},
    )
    bridge = new GuiBridge(runtime)
    runtime.mountGui(socket => bridge.handleConnection(socket))
    const address = await runtime.start()
    guiUrl = `ws://127.0.0.1:${address.port}/gui`
    return guiUrl
  }

  // ── loader handoff contract ──

  it('hands off to the module loader and exports the plugin shape', () => {
    expect(loaded.id).toBe('dsh-coyote')
    expect(moduleExports.name).toBe('dsh-coyote')
    expect(moduleExports.inject).toEqual(['slots'])
    expect(typeof moduleExports.apply).toBe('function')
    expect(T.PanelConnection).toBeDefined()
    expect(T.CoyotePanel).toBeDefined()
  })

  it('apply registers a sidebar.footer.action slot entry', () => {
    const registered: unknown[] = []
    const ctx = {
      slots: {
        inject: (_slot: string, register: () => unknown) => { registered.push(register()) },
        register: (meta: unknown, component: unknown) => ({ meta, component }),
      },
    }
    ;(moduleExports.apply as (ctx: unknown) => void)(ctx)
    expect(registered).toHaveLength(1)
    const entry = registered[0] as { meta: Record<string, unknown>; component: unknown }
    expect(entry.meta.name).toBe('sidebar.footer.action')
    expect(entry.meta.id).toBe('dsh-coyote')
    expect(entry.component).toBe(T.CoyoteWidget)
  })

  // ── pure helpers ──

  it('derives the server URL from the page origin and honors overrides', () => {
    expect(T.deriveServerUrl({ hostname: '192.168.1.5', protocol: 'http:' }, '')).toBe('ws://192.168.1.5:9999/gui')
    expect(T.deriveServerUrl({ hostname: 'example.com', protocol: 'https:' }, '')).toBe('wss://example.com:9999/gui')
    expect(T.deriveServerUrl({ hostname: 'example.com', protocol: 'https:' }, ' ws://proxy:7/gui ')).toBe('ws://proxy:7/gui')
    expect(T.deriveServerUrl(undefined, '')).toBe('ws://127.0.0.1:9999/gui')
    expect(T.deriveServerUrl(undefined, undefined)).toBe('ws://127.0.0.1:9999/gui')
  })

  it('validates user-entered URLs', () => {
    expect(T.parseServerUrl('  ws://h:1/gui ')).toBe('ws://h:1/gui')
    expect(T.parseServerUrl('wss://h/gui')).toBe('wss://h/gui')
    expect(T.parseServerUrl('http://h/gui')).toBeNull()
    expect(T.parseServerUrl('not a url')).toBeNull()
    expect(T.parseServerUrl('   ')).toBeNull()
  })

  it('builds play ops with validation and clamping', () => {
    expect(T.buildPlayOp({ waveform: 'breath', channel: 'both', mode: 'loop', durationSec: 2.5, intensityPercent: 40, mirror: true }).op).toEqual({
      op: 'play', waveform: 'breath', channel: 'both', mode: 'loop',
      duration_sec: 3, intensity_percent: 40, mirror: true,
    })
    expect(T.buildPlayOp({ waveform: ' x ', durationSec: 10, intensityPercent: 100 }).op).toEqual({
      op: 'play', waveform: 'x', channel: 'A', mode: 'once',
      duration_sec: 10, intensity_percent: 100, mirror: false,
    })
    expect(T.buildPlayOp({ waveform: '', durationSec: 10, intensityPercent: 100 }).error).toContain('波形')
    expect(T.buildPlayOp({ waveform: 'x', durationSec: -1, intensityPercent: 100 }).error).toContain('时长')
    expect(T.buildPlayOp({ waveform: 'x', durationSec: 10, intensityPercent: 101 }).error).toContain('百分比')
    expect(T.buildPlayOp({ waveform: 'x', durationSec: 10000, intensityPercent: 100 }).op.duration_sec).toBe(600)
  })

  it('labels states and clamps strength steps', () => {
    expect(T.stateLabel('bound').text).toContain('绑定')
    expect(T.stateLabel('waiting-app').text).toContain('扫码')
    expect(T.stateLabel('idle').text).toContain('未配对')
    expect(T.stepValue(8, 5, 10)).toBe(10)
    expect(T.stepValue(8, -5, 10)).toBe(3)
    expect(T.stepValue(0, -5, 10)).toBe(0)
  })

  // ── PanelConnection against the real bridge ──

  it('connects, mirrors bridge events into snapshots, and surfaces op errors', async () => {
    const url = await makeRuntime()
    const conn = new T.PanelConnection()
    afterEach(() => conn.disconnect())

    conn.connect(url)
    await vi.waitFor(() => expect(conn.getSnapshot().wsState).toBe('connected'))
    const snap = conn.getSnapshot()
    expect(snap.status.state).toBe('idle')
    expect(snap.waveforms).toHaveLength(12)
    expect(snap.url).toBe(url)

    conn.send({ op: 'strength', channel: 'A', value: 10 })
    await vi.waitFor(() => expect(conn.getSnapshot().lastError).toContain('no bound App'))

    conn.send({ op: 'wat' })
    await vi.waitFor(() => expect(conn.getSnapshot().lastError).toContain('unknown op'))
  })

  it('clears the last error once a later op is acknowledged', async () => {
    const url = await makeRuntime()
    const conn = new T.PanelConnection()
    afterEach(() => conn.disconnect())

    conn.connect(url)
    await vi.waitFor(() => expect(conn.getSnapshot().wsState).toBe('connected'))

    conn.send({ op: 'strength', channel: 'A', value: 10 })
    await vi.waitFor(() => expect(conn.getSnapshot().lastError).toContain('no bound App'))

    // 'end' succeeds even while idle, so the bridge acks it.
    conn.send({ op: 'end' })
    await vi.waitFor(() => {
      const snap = conn.getSnapshot()
      expect(snap.lastAck?.op).toBe('end')
      expect(snap.lastError).toBeUndefined()
    })
  })

  it('rejects invalid URLs without opening a socket', () => {
    const conn = new T.PanelConnection()
    conn.connect('http://nope')
    expect(conn.getSnapshot().lastError).toContain('ws:// 或 wss://')
    expect(conn.getSnapshot().wsState).toBe('disconnected')
  })

  it('follows a full pair → bind → strength cycle with live status updates', async () => {
    const url = await makeRuntime()
    const conn = new T.PanelConnection()
    afterEach(() => conn.disconnect())

    // App side binds while the panel watches.
    const session = await runtime.pair()
    const match = /ws:\/\/([^/]+):(\d+)\//.exec(session.qrPayload)!
    const appFrames: Array<{ type: string; message: string; clientId?: string; targetId?: string }> = []
    const app = new WebSocket(`ws://${match[1]}:${match[2]}/${session.controlId}`)
    app.on('message', data => appFrames.push(JSON.parse(String(data))))
    await new Promise(resolve => app.once('open', resolve))

    conn.connect(url)
    await vi.waitFor(() => expect(conn.getSnapshot().wsState).toBe('connected'))

    await vi.waitFor(() => expect(appFrames.some(f => f.type === 'bind' && f.targetId === '')).toBe(true))
    const initial = appFrames.find(f => f.type === 'bind' && f.targetId === '')!
    app.send(JSON.stringify({ type: 'bind', clientId: session.controlId, targetId: initial.clientId, message: 'DGLAB' }))
    await vi.waitFor(() => expect(appFrames.some(f => f.type === 'bind' && f.message === '200')).toBe(true))
    app.send(JSON.stringify({ type: 'msg', clientId: 'app', targetId: 'ctrl', message: 'strength-0+0+100+100' }))

    await vi.waitFor(() => expect(conn.getSnapshot().status?.state).toBe('bound'))

    conn.send({ op: 'strength', channel: 'A', value: 30 })
    await vi.waitFor(() => expect(appFrames.some(f => f.message === 'strength-1+2+30')).toBe(true))
    // The real App reports the applied strength back; echo it like the device.
    app.send(JSON.stringify({ type: 'msg', clientId: 'app', targetId: 'ctrl', message: 'strength-30+0+100+100' }))
    await vi.waitFor(() => expect(conn.getSnapshot().status?.strength?.a).toBe(30))

    conn.send({ op: 'panic' })
    await vi.waitFor(() => expect(appFrames.some(f => f.message === 'strength-1+2+0')).toBe(true))
    app.close()
  })

  it('persists the chosen URL in localStorage', () => {
    T.saveUrl('ws://saved:1234/gui')
    expect(T.loadSavedUrl()).toBe('ws://saved:1234/gui')
    localStorageStore.delete('dsh-coyote:server-url')
    expect(T.loadSavedUrl()).toBe('')
  })

  // ── component structure over the mini React ──

  it('renders the widget trigger and opens a live panel bound to the bridge', async () => {
    const url = await makeRuntime()
    localStorageStore.set('dsh-coyote:server-url', url)

    const trigger = fakeReact.invoke(T.CoyoteWidget as never, { wide: true }) as FakeElement
    const button = findAll(trigger, el => el.type === 'button')[0]!
    expect(textOf(trigger)).toContain('Coyote')
    ;(button.props.onClick as () => void)()

    const opened = fakeReact.invoke(T.CoyoteWidget as never, { wide: true }) as FakeElement
    const panel = findAll(opened, el => typeof el.type === 'function' && el.type === T.CoyotePanel)[0]!
    fakeReact.invoke(panel.type as never, panel.props)
    fakeReact.flushEffects()

    let tree = fakeReact.invoke(T.CoyotePanel as never, { onClose: () => {} }) as FakeElement
    await vi.waitFor(() => {
      tree = fakeReact.invoke(T.CoyotePanel as never, { onClose: () => {} }) as FakeElement
      expect(textOf(tree)).toContain('波形库 · 12')
    })
    expect(textOf(tree)).toContain('Coyote 电击控制')
    expect(textOf(tree)).toContain('波形库 · 12')
    expect(findAll(tree, el => el.type === 'input' && el.props.type === 'range')).toHaveLength(2)
    expect(textOf(tree)).toContain('紧急停止')

    // play is disabled while unbound; picking a waveform enables the row
    const playBtn = findAll(tree, el => el.type === 'button' && textOf(el) === '▶ 播放')[0]!
    expect(playBtn.props.disabled).toBe(true)
    const waveRow = findAll(tree, el => typeof el.props.onClick === 'function' && textOf(el).includes('Breathing'))[0]!
    ;(waveRow.props.onClick as () => void)()
    tree = fakeReact.invoke(T.CoyotePanel as never, { onClose: () => {} }) as FakeElement
    const playBtn2 = findAll(tree, el => el.type === 'button' && textOf(el) === '▶ 播放')[0]!
    expect(playBtn2.props.disabled).toBe(true) // still unbound

    fakeReact.flushCleanups()
  })
})
