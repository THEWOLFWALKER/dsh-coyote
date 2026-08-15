/**
 * dsh-coyote — client plugin bundle (browser half).
 *
 * A DeepSeek Harness web-GUI panel for the DG-LAB Coyote e-stim plugin.
 * Everything the panel does goes through the host plugin's `/gui` WebSocket
 * bridge, so the browser panel and the model-facing `coyote_*` tools share
 * one safety envelope: soft limits, the asymmetric increase limiter, session
 * cooldown, playback caps, and the disconnect fail-safe all still apply.
 *
 * The bundle is authored as a plain closure factory for the client module
 * loader (`window.__ModuleLoader__.load({ id, factory })`). React comes from
 * the loader module table via the injected `require` — nothing is bundled and
 * there is no build step. Styling is inline against the DSH CSS variables so
 * the panel follows the host theme.
 *
 * Structure of this file:
 *   constants → pure helpers → PanelConnection (framework-free) →
 *   React components → apply(ctx) → guarded test hook.
 */
window.__ModuleLoader__.load({
  id: 'dsh-coyote',
  factory: (require) => {
    const React = require('react')
    const { useState, useEffect, useRef, useCallback } = React

    // ────────────────────────── constants ──────────────────────────

    const PKG = 'dsh-coyote'
    const URL_KEY = 'dsh-coyote:server-url'
    /** Must match the host plugin's default `port` config. */
    const DEFAULT_PORT = 9999
    const RECONNECT_BASE_MS = 1000
    const RECONNECT_MAX_MS = 15000

    /** Panel-scoped keyframes + slider thumb styling (inline styles cannot). */
    if (typeof document !== 'undefined' && document.head) {
      const style = document.createElement('style')
      style.textContent = [
        '@keyframes dshCoyFadeIn { from { opacity: 0 } to { opacity: 1 } }',
        '@keyframes dshCoyPulse { 0%,100% { opacity: 1 } 50% { opacity: .45 } }',
        '.dshCoyRange { -webkit-appearance: none; appearance: none; height: 4px; border-radius: 2px;',
        '  background: var(--dsw-alias-border-l2, rgba(128,128,128,.35)); outline: none; }',
        '.dshCoyRange::-webkit-slider-thumb { -webkit-appearance: none; appearance: none;',
        '  width: 14px; height: 14px; border-radius: 50%; cursor: pointer;',
        '  background: var(--dsw-alias-brand-primary, #4d8dff); }',
        '.dshCoyRange::-moz-range-thumb { width: 14px; height: 14px; border: none;',
        '  border-radius: 50%; cursor: pointer; background: var(--dsw-alias-brand-primary, #4d8dff); }',
      ].join('\n')
      document.head.appendChild(style)
    }

    // ────────────────────────── pure helpers ────────────────────────

    /**
     * Derive the default `/gui` WebSocket URL from the page origin:
     * `ws(s)://<hostname>:<port>/gui`, following the page scheme so an
     * https-hosted DSH does not attempt mixed content. `override` is the
     * user-saved URL (localStorage) and wins when present.
     */
    function deriveServerUrl(locationLike, override, port) {
      if (typeof override === 'string' && override.trim() !== '') return override.trim()
      const p = port || DEFAULT_PORT
      const loc = locationLike || (typeof location !== 'undefined' ? location : undefined)
      const host = loc && loc.hostname ? loc.hostname : '127.0.0.1'
      const scheme = loc && loc.protocol === 'https:' ? 'wss:' : 'ws:'
      return `${scheme}//${host}:${p}/gui`
    }

    /** Validate a user-entered URL; returns the trimmed URL or null. */
    function parseServerUrl(text) {
      if (typeof text !== 'string') return null
      const trimmed = text.trim()
      if (trimmed === '') return null
      let parsed
      try {
        parsed = new URL(trimmed)
      } catch {
        return null
      }
      if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return null
      return trimmed
    }

    /** Human label + tone color for a connection state. */
    function stateLabel(state) {
      if (state === 'bound') return { text: '已连接 · App 已绑定', color: 'var(--dsw-alias-state-success-primary, #3dd68c)' }
      if (state === 'waiting-app') return { text: '等待 App 扫码…', color: 'var(--dsw-alias-state-business-primary, #4d8dff)' }
      return { text: '未配对', color: 'var(--dsw-alias-label-secondary, #9a9a9a)' }
    }

    /** Build the `play` op from the panel form; returns { op } or { error }. */
    function buildPlayOp(form) {
      const f = form || {}
      const waveform = typeof f.waveform === 'string' ? f.waveform.trim() : ''
      if (waveform === '') return { error: '请选择一个波形' }
      const mode = f.mode === 'loop' ? 'loop' : 'once'
      const duration = Number(f.durationSec)
      if (!Number.isFinite(duration) || duration <= 0) return { error: '时长必须是正数（秒）' }
      const intensity = Math.round(Number(f.intensityPercent))
      if (!Number.isFinite(intensity) || intensity < 0 || intensity > 100) {
        return { error: '强度百分比必须在 0–100 之间' }
      }
      const op = {
        op: 'play',
        waveform,
        channel: f.channel === 'B' ? 'B' : f.channel === 'both' ? 'both' : 'A',
        mode,
        duration_sec: Math.min(Math.round(duration), 600),
        intensity_percent: intensity,
        mirror: f.mirror === true,
      }
      return { op }
    }

    /** Clamp a strength step for the +/- buttons. */
    function stepValue(current, delta, limit) {
      const cap = Math.max(0, Math.min(200, limit == null ? 200 : limit))
      return Math.max(0, Math.min(cap, (current || 0) + delta))
    }

    // ─────────────────── PanelConnection (framework-free) ───────────────────

    /**
     * Owns the `/gui` WebSocket: connect/disconnect, op sending with a
     * monotonically increasing id, event → snapshot reduction, and automatic
     * reconnection with capped exponential backoff. Components only read
     * `getSnapshot()` and subscribe to `onChange`.
     */
    class PanelConnection {
      constructor() {
        this.wsState = 'disconnected' // disconnected | connecting | connected
        this.status = undefined // latest RuntimeStatus from the bridge
        this.waveforms = []
        this.lastError = undefined
        this.lastAck = undefined
        this.url = ''
        this._listeners = new Set()
        this._ws = undefined
        this._retry = 0
        this._timer = undefined
        this._closedByUser = false
        this._seq = 0
        this._dispatch = this._dispatch.bind(this)
      }

      /** Register a change listener; returns an unsubscribe function. */
      onChange(listener) {
        this._listeners.add(listener)
        return () => this._listeners.delete(listener)
      }

      /** Current read-only snapshot (reference replaced on every change). */
      getSnapshot() {
        return {
          wsState: this.wsState,
          status: this.status,
          waveforms: this.waveforms,
          lastError: this.lastError,
          lastAck: this.lastAck,
          url: this.url,
        }
      }

      /** Connect to `url`. An active connection is replaced. */
      connect(url) {
        const target = parseServerUrl(url)
        if (target === null) {
          this.fail('服务器地址必须是 ws:// 或 wss:// URL')
          return
        }
        this._teardownSocket()
        this._closedByUser = false
        this.url = target
        this.wsState = 'connecting'
        this.lastError = undefined
        this._notify()
        this._open()
      }

      /** User-initiated disconnect: stops auto-reconnect. */
      disconnect() {
        this._closedByUser = true
        this._teardownSocket()
        this.wsState = 'disconnected'
        this.status = undefined
        this.waveforms = []
        this._notify()
      }

      /** Send one op; returns false when the socket is not open. */
      send(op) {
        if (this._ws === undefined || this._ws.readyState !== 1 /* OPEN */) {
          this.fail('面板未连接到 dsh-coyote 服务')
          return false
        }
        try {
          this._ws.send(JSON.stringify({ ...op, seq: ++this._seq }))
          return true
        } catch (error) {
          this.fail(`发送失败: ${String(error && error.message ? error.message : error)}`)
          return false
        }
      }

      // ── internals ──

      _open() {
        let socket
        try {
          socket = new WebSocket(this.url)
        } catch (error) {
          this.fail(`无法建立连接: ${String(error && error.message ? error.message : error)}`)
          this._scheduleReconnect()
          return
        }
        this._ws = socket
        socket.onopen = () => {
          if (socket !== this._ws) return
          this._retry = 0
          this.wsState = 'connected'
          this.lastError = undefined
          this._notify()
          this.send({ op: 'hello' })
        }
        socket.onmessage = (event) => {
          if (socket !== this._ws) return
          this._dispatch(event.data)
        }
        socket.onclose = () => {
          if (socket !== this._ws) return
          this._ws = undefined
          this.wsState = 'disconnected'
          this.status = undefined
          this._notify()
          this._scheduleReconnect()
        }
        socket.onerror = () => {
          /* onclose follows; nothing to do here */
        }
      }

      _dispatch(raw) {
        let event
        try {
          event = JSON.parse(String(raw))
        } catch {
          return
        }
        if (event == null || typeof event !== 'object') return
        if (event.event === 'status' && event.status != null) this.status = event.status
        else if (event.event === 'waveforms' && Array.isArray(event.waveforms)) this.waveforms = event.waveforms
        else if (event.event === 'ack') {
          // A successful op clears the previous error so stale warnings do not linger.
          this.lastAck = { op: event.op, at: Date.now() }
          this.lastError = undefined
        }
        else if (event.event === 'error') this.lastError = String(event.message || '未知错误')
        else return
        this._notify()
      }

      _scheduleReconnect() {
        if (this._closedByUser) return
        if (this._timer !== undefined) clearTimeout(this._timer)
        const delay = Math.min(RECONNECT_BASE_MS * 2 ** this._retry, RECONNECT_MAX_MS)
        this._retry += 1
        this._timer = setTimeout(() => {
          this._timer = undefined
          if (this._closedByUser) return
          this.wsState = 'connecting'
          this._notify()
          this._open()
        }, delay)
        if (typeof this._timer === 'object' && this._timer && this._timer.unref) this._timer.unref()
      }

      _teardownSocket() {
        if (this._timer !== undefined) {
          clearTimeout(this._timer)
          this._timer = undefined
        }
        const ws = this._ws
        this._ws = undefined
        if (ws !== undefined) {
          ws.onopen = ws.onmessage = ws.onclose = ws.onerror = undefined
          try {
            if (ws.readyState === 0 || ws.readyState === 1) ws.close()
          } catch {
            /* already closing */
          }
        }
      }

      fail(message) {
        this.lastError = message
        this._notify()
      }

      _notify() {
        for (const listener of [...this._listeners]) {
          try {
            listener()
          } catch {
            /* listener errors must not break the connection */
          }
        }
      }
    }

    // ────────────────────────── React components ──────────────────────────

    /** Panel palette over DSH alias variables (dark-theme safe). */
    const C = {
      text: 'var(--dsw-alias-label-primary, #e8e8e8)',
      dim: 'var(--dsw-alias-label-secondary, #9a9a9a)',
      hover: 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.16))',
      border: 'var(--dsw-alias-border-l2, rgba(128,128,128,0.28))',
      panel: 'var(--dsw-specific-sidebar-fill, var(--dsw-alias-button-elevated-fill, #232323))',
      danger: '#e05252',
      ok: 'var(--dsw-alias-state-success-primary, #3dd68c)',
      brand: 'var(--dsw-alias-brand-primary, #4d8dff)',
    }

    function btnStyle(overrides) {
      return {
        border: `1px solid ${C.border}`,
        background: 'transparent',
        color: C.text,
        borderRadius: 6,
        padding: '3px 10px',
        fontSize: 12,
        cursor: 'pointer',
        ...(overrides || {}),
      }
    }

    function sectionTitle(text) {
      return {
        color: C.dim,
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: 1,
        margin: '10px 0 4px',
      }
    }

    /** Sidebar trigger + the floating panel it opens. */
    function CoyoteWidget(props) {
      const e = React.createElement
      const [open, setOpen] = useState(false)

      const trigger = e('button', {
        onClick: () => setOpen(!open),
        title: 'Coyote 电击控制',
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 6,
          height: 28,
          minWidth: 28,
          padding: '0 8px',
          background: open ? C.hover : 'transparent',
          border: 'none',
          borderRadius: 8,
          color: C.text,
          cursor: 'pointer',
          fontSize: 13,
        },
      }, '⚡', props.wide ? e('span', null, 'Coyote') : null)

      return e(React.Fragment, null,
        trigger,
        open ? e(CoyotePanel, { onClose: () => setOpen(false) }) : null)
    }

    /** The floating control panel. One PanelConnection per mount. */
    function CoyotePanel(props) {
      const e = React.createElement

      // ── connection state (external store → React) ──
      const connRef = useRef(null)
      if (connRef.current === null) connRef.current = new PanelConnection()
      const conn = connRef.current

      const [snap, setSnap] = useState(conn.getSnapshot())

      const [urlText, setUrlText] = useState('')

      // play form
      const [form, setFormState] = useState({
        waveform: '',
        channel: 'A',
        mode: 'once',
        durationSec: 30,
        intensityPercent: 100,
        mirror: false,
      })
      const setForm = (patch) => setFormState({ ...form, ...patch })

      const [importText, setImportText] = useState('')

      const [sliderA, setSliderA] = useState(null)
      const [sliderB, setSliderB] = useState(null)

      // ── lifecycle: auto-connect on mount, disconnect on unmount ──
      useEffect(() => {
        const saved = loadSavedUrl()
        const url = deriveServerUrl(typeof location !== 'undefined' ? location : undefined, saved)
        setUrlText(url)
        conn.connect(url)
        const off = conn.onChange(() => setSnap(conn.getSnapshot()))
        return () => {
          off()
          conn.disconnect()
        }
      }, [])

      const status = snap.status
      const state = status ? status.state : 'idle'
      const strength = status && status.strength
      const bound = state === 'bound'
      const waiting = state === 'waiting-app'
      const cooldown = status ? Math.max(0, status.cooldownRemainingSec || 0) : 0
      const effA = status ? status.effectiveLimitA : 100
      const effB = status ? status.effectiveLimitB : 100
      const curA = sliderA != null ? sliderA : strength ? strength.a : 0
      const curB = sliderB != null ? sliderB : strength ? strength.b : 0

      const sendOp = useCallback((op) => {
        setSliderA(null)
        setSliderB(null)
        return conn.send(op)
      })

      const setStrength = (channel, value) => sendOp({ op: 'strength', channel, value: Math.round(value) })

      const doPlay = () => {
        const built = buildPlayOp(form)
        if (built.error) {
          conn.fail(built.error)
          setSnap(conn.getSnapshot())
          return
        }
        sendOp(built.op)
      }

      const doImport = () => {
        if (importText.trim() === '') return
        sendOp({ op: 'import', text: importText })
        setImportText('')
      }

      const doConnect = () => {
        const parsed = parseServerUrl(urlText)
        if (parsed === null) {
          conn.fail('服务器地址必须是 ws:// 或 wss:// URL')
          setSnap(conn.getSnapshot())
          return
        }
        saveUrl(parsed)
        conn.connect(parsed)
      }

      // ── render ──

      const wsDot = snap.wsState === 'connected'
        ? C.ok
        : snap.wsState === 'connecting' ? C.brand : C.dim

      const header = e('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 } },
        e('span', {
          style: {
            width: 8, height: 8, borderRadius: '50%', background: wsDot, flexShrink: 0,
            animation: snap.wsState === 'connecting' ? 'dshCoyPulse 1s infinite' : undefined,
          },
        }),
        e('strong', { style: { color: C.text, flex: 1 } }, 'Coyote 电击控制'),
        e('button', { onClick: props.onClose, style: btnStyle({ border: 'none', color: C.dim, padding: '2px 8px', fontSize: 14 }) }, '✕'))

      // server URL row
      const serverRow = e('div', { style: { display: 'flex', gap: 6, marginBottom: 8 } },
        e('input', {
          value: urlText,
          onChange: (ev) => setUrlText(ev.target.value),
          onKeyDown: (ev) => { if (ev.key === 'Enter') doConnect() },
          placeholder: 'ws://主机:9999/gui',
          spellCheck: false,
          style: {
            flex: 1, fontSize: 11, padding: '4px 8px', color: C.text,
            background: 'transparent', border: `1px solid ${C.border}`, borderRadius: 8, outline: 'none',
          },
        }),
        e('button', { onClick: doConnect, style: btnStyle({ fontSize: 11 }) }, '连接'))

      const err = snap.lastError
        ? e('div', {
          style: { color: C.danger, fontSize: 12, marginBottom: 6, animation: 'dshCoyFadeIn .2s ease' },
        }, `⚠ ${snap.lastError}`)
        : null

      // link state + pairing
      const label = stateLabel(state)
      let linkBody
      if (waiting && status && status.session) {
        linkBody = e('div', { style: { textAlign: 'center' } },
          e('img', {
            src: status.session.qrDataUrl,
            alt: 'DG-LAB App 配对二维码',
            style: { width: 176, height: 176, borderRadius: 8, background: '#fff', padding: 4, margin: '4px auto' },
          }),
          e('div', { style: { color: C.dim, fontSize: 11, wordBreak: 'break-all' } },
            `用 DG-LAB App 扫码连接 · ${status.session.controlId.slice(0, 8)}…`),
          e('button', { onClick: () => sendOp({ op: 'end' }), style: btnStyle({ marginTop: 6, fontSize: 11 }) }, '取消配对'))
      } else {
        linkBody = e('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          e('span', { style: { color: label.color, fontSize: 12, flex: 1 } }, label.text),
          bound
            ? e('button', { onClick: () => sendOp({ op: 'end' }), style: btnStyle({ fontSize: 11 }) }, '结束会话')
            : e('button', {
              onClick: () => sendOp({ op: 'pair' }),
              disabled: cooldown > 0,
              style: btnStyle({ fontSize: 11, opacity: cooldown > 0 ? 0.5 : 1 }),
            }, cooldown > 0 ? `冷却 ${cooldown}s` : '开始配对'))
      }

      // strength controls per channel
      const channelRow = (name, cur, eff, sliderState, setSlider) => e('div', { style: { margin: '6px 0' } },
        e('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
          e('span', { style: { color: C.text, fontWeight: 700, fontSize: 12, width: 14 } }, name),
          e('span', { style: { color: C.dim, fontSize: 12, fontVariantNumeric: 'tabular-nums', minWidth: 64 } },
            `${cur} / ${eff}`),
          e('input', {
            type: 'range', min: 0, max: eff, step: 1,
            value: cur,
            className: 'dshCoyRange',
            style: { flex: 1 },
            disabled: !bound,
            onChange: (ev) => setSlider(Number(ev.target.value)),
            onPointerUp: () => { if (sliderState != null) setStrength(name, sliderState) },
            onKeyUp: (ev) => {
              if (sliderState != null && (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight')) setStrength(name, sliderState)
            },
          }),
          e('button', {
            disabled: !bound, onClick: () => setStrength(name, stepValue(cur, -5, eff)),
            style: btnStyle({ padding: '2px 7px', opacity: bound ? 1 : 0.5 }),
          }, '−5'),
          e('button', {
            disabled: !bound, onClick: () => setStrength(name, stepValue(cur, 5, eff)),
            style: btnStyle({ padding: '2px 7px', opacity: bound ? 1 : 0.5 }),
          }, '+5')),
        bound ? null : e('div', { style: { color: C.dim, fontSize: 10, paddingLeft: 20 } }, '绑定 App 后可调节'))

      const strengthSection = e('div', null,
        e('div', { style: sectionTitle('通道强度 · 0–200') }, '通道强度 · 0–200'),
        channelRow('A', curA, effA, sliderA, setSliderA),
        channelRow('B', curB, effB, sliderB, setSliderB),
        e('div', { style: { display: 'flex', gap: 6, marginTop: 2 } },
          e('button', {
            disabled: !bound, onClick: () => setStrength('both', 0),
            style: btnStyle({ color: C.danger, borderColor: C.danger, opacity: bound ? 1 : 0.5 }),
          }, '双通道归零')))

      // waveform section
      const waves = snap.waveforms || []
      const waveformSection = e('div', null,
        e('div', { style: sectionTitle(`波形库 · ${waves.length}`) }, `波形库 · ${waves.length}`),
        waves.length === 0
          ? e('div', { style: { color: C.dim, fontSize: 11 } }, snap.wsState === 'connected' ? '（无波形）' : '（未连接）')
          : e('div', { style: { maxHeight: 168, overflowY: 'auto', margin: '0 -4px', padding: '0 4px' } },
            waves.map((wave) => e('div', {
              key: `${wave.source}:${wave.id}`,
              onClick: () => setForm({ waveform: wave.id }),
              style: {
                display: 'flex', alignItems: 'center', gap: 6, padding: '5px 6px', borderRadius: 8,
                cursor: 'pointer', marginBottom: 2, fontSize: 12, color: C.text,
                background: form.waveform === wave.id ? C.hover : 'transparent',
                border: `1px solid ${form.waveform === wave.id ? C.border : 'transparent'}`,
              },
            },
              e('span', {
                style: {
                  fontSize: 9, padding: '0 5px', borderRadius: 8, flexShrink: 0,
                  color: wave.source === 'builtin' ? C.brand : C.ok,
                  border: `1px solid ${wave.source === 'builtin' ? C.brand : C.ok}`,
                },
              }, wave.source === 'builtin' ? '内置' : '导入'),
              e('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 } },
                wave.name),
              wave.suggestedIntensityPercent !== 100
                ? e('span', { style: { color: C.dim, fontSize: 10, flexShrink: 0 } }, `建议 ${wave.suggestedIntensityPercent}%`)
                : null))),
        e('div', { style: { display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap', alignItems: 'center' } },
          segBtn('A', form.channel, (v) => setForm({ channel: v })),
          segBtn('B', form.channel, (v) => setForm({ channel: v })),
          segBtn('both', form.channel, (v) => setForm({ channel: v }), '双'),
          segBtn('once', form.mode, (v) => setForm({ mode: v }), '单次'),
          segBtn('loop', form.mode, (v) => setForm({ mode: v }), '循环'),
          e('span', { style: { color: C.dim, fontSize: 11 } }, '时长'),
          e('input', {
            type: 'number', min: 1, max: 600, value: form.durationSec,
            onChange: (ev) => setForm({ durationSec: Number(ev.target.value) }),
            style: numInputStyle(),
          }),
          e('span', { style: { color: C.dim, fontSize: 11 } }, '强度'),
          e('input', {
            type: 'number', min: 0, max: 100, value: form.intensityPercent,
            onChange: (ev) => setForm({ intensityPercent: Number(ev.target.value) }),
            style: numInputStyle(),
          }),
          e('label', { style: { color: C.dim, fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 } },
            e('input', {
              type: 'checkbox', checked: form.mirror,
              onChange: (ev) => setForm({ mirror: ev.target.checked }),
            }), 'B 镜像'),
          e('button', {
            disabled: !bound || form.waveform === '',
            onClick: doPlay,
            style: btnStyle({ marginLeft: 'auto', borderColor: C.brand, color: C.brand, opacity: !bound || form.waveform === '' ? 0.5 : 1 }),
          }, '▶ 播放')))

      // playback + panic
      const playing = status ? status.playing === true : false
      const controlSection = e('div', { style: { display: 'flex', gap: 6, alignItems: 'center', marginTop: 8 } },
        e('span', {
          style: {
            color: playing ? C.ok : C.dim, fontSize: 11, flex: 1,
            animation: playing ? 'dshCoyPulse 1.6s infinite' : undefined,
          },
        }, playing ? '● 波形播放中' : '○ 空闲'),
        e('button', {
          disabled: !playing, onClick: () => sendOp({ op: 'stop' }),
          style: btnStyle({ opacity: playing ? 1 : 0.5 }),
        }, '停止波形'),
        e('button', {
          disabled: !bound, onClick: () => sendOp({ op: 'panic' }),
          style: btnStyle({
            background: C.danger, borderColor: C.danger, color: '#fff',
            fontWeight: 700, padding: '4px 14px', opacity: bound ? 1 : 0.5,
          }),
        }, '紧急停止'))

      // import section
      const importSection = e('div', null,
        e('div', { style: sectionTitle('导入社区波形 · .pulses / JSON') }, '导入社区波形 · .pulses / JSON'),
        e('textarea', {
          value: importText,
          onChange: (ev) => setImportText(ev.target.value),
          placeholder: '粘贴 Game-Hub 导出的 [{ name, pulseData: ["0a0a…"] }] 内容',
          rows: 2,
          style: {
            width: '100%', boxSizing: 'border-box', fontSize: 11, padding: '5px 8px', color: C.text,
            background: 'transparent', border: `1px solid ${C.border}`, borderRadius: 8,
            outline: 'none', resize: 'vertical', fontFamily: 'inherit',
          },
        }),
        e('div', { style: { display: 'flex', gap: 6, marginTop: 4 } },
          e('button', { onClick: doImport, disabled: importText.trim() === '', style: btnStyle({ fontSize: 11, opacity: importText.trim() === '' ? 0.5 : 1 }) }, '导入'),
          e('button', { onClick: () => sendOp({ op: 'list' }), style: btnStyle({ fontSize: 11 }) }, '刷新波形库')))

      const body = e('div', { style: { fontSize: 13 } },
        serverRow,
        err,
        e('div', { style: sectionTitle('链路') }, '链路'),
        linkBody,
        strengthSection,
        waveformSection,
        controlSection,
        importSection,
        e('div', { style: { color: C.dim, fontSize: 10, borderTop: `1px solid ${C.border}`, paddingTop: 8, marginTop: 10 } },
          '面板与 coyote_* 工具共用同一安全边界：软上限 · 升速限制 · 会话冷却 · 断连即停'))

      return e('div', {
        style: {
          position: 'fixed', right: 12, bottom: 48, width: 340, maxHeight: '72vh',
          background: C.panel, color: C.text, border: `1px solid ${C.border}`,
          borderRadius: 12, boxShadow: '0 12px 32px rgba(0,0,0,0.35)',
          padding: 12, zIndex: 1000, overflowY: 'auto',
          animation: 'dshCoyFadeIn .18s ease',
        },
      }, header, body)
    }

    /** Small segmented-choice button used by the play form row. */
    function segBtn(value, current, onPick, label) {
      const e = React.createElement
      const active = current === value
      return e('button', {
        key: value,
        onClick: () => onPick(value),
        style: {
          border: `1px solid ${active ? C.border : 'transparent'}`,
          background: active ? C.hover : 'transparent',
          color: active ? C.text : C.dim,
          borderRadius: 12, padding: '2px 8px', fontSize: 11, cursor: 'pointer',
        },
      }, label || value)
    }

    function numInputStyle() {
      return {
        width: 52, fontSize: 11, padding: '3px 6px', color: C.text,
        background: 'transparent', border: `1px solid ${C.border}`, borderRadius: 6, outline: 'none',
      }
    }

    // ────────────────────────── persistence ──────────────────────────

    function loadSavedUrl() {
      try {
        return localStorage.getItem(URL_KEY) || ''
      } catch {
        return ''
      }
    }

    function saveUrl(url) {
      try {
        localStorage.setItem(URL_KEY, url)
      } catch {
        /* private mode / disabled storage: keep the URL in memory only */
      }
    }

    // ────────────────────────── plugin apply ──────────────────────────

    /**
     * Register the panel into the DSH sidebar footer. `ctx` is the client
     * root context; slots are the only supported composition surface.
     */
    function apply(ctx) {
      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
        name: 'sidebar.footer.action',
        id: 'dsh-coyote',
        order: 50,
        registrant: PKG,
      }, CoyoteWidget))
    }

    // Guarded test hook: lets the offline harness exercise helpers, the
    // connection manager, and component structure without a browser; never
    // touched in the real GUI.
    if (typeof globalThis.__DSH_COYOTE_TEST__ === 'object' && globalThis.__DSH_COYOTE_TEST__ !== null) {
      globalThis.__DSH_COYOTE_TEST__.exports = {
        deriveServerUrl, parseServerUrl, stateLabel, buildPlayOp, stepValue,
        PanelConnection, CoyoteWidget, CoyotePanel, apply,
        loadSavedUrl, saveUrl,
      }
    }

    return { name: PKG, inject: ['slots'], apply }
  },
})
