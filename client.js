// dsh-cost-voice 客户端半：监听每轮结束事实 -> 拼音频播报；并在「设置 → 插件」里提供配置页。
// 纯音频拼接：不调用浏览器语音合成，片段由宿主按需下发。
window.__ModuleLoader__.load({
  id: 'dsh-cost-voice',
  factory(require) {
    const React = require('react')
    const { useCallback, useEffect, useRef, useState, useSyncExternalStore } = React
    const h = React.createElement

    const CONFIG_KEY = 'dsh-cost-voice.config.v1'
    const SEEN_KEY = 'dsh-cost-voice.seen.v1'
    const LOG_KEY = 'dsh-cost-voice.log.v1'
    const DEFAULTS = {
      enabled: true,
      voice: 'alipay',
      basis: 'auto',
      inputPrice: 1,
      outputPrice: 2,
      minAmount: 0,
      volume: 0.9,
      gapMs: 40,
      modelPrices: {},
      completedOnly: true,
      quiet: false,
      quietStart: '00:00',
      quietEnd: '08:00',
    }
    const PACKS = {
      alipay: { dir: 'alipay-zh', prefix: 'prefix-account', label: '支付宝' },
      dabaifan: { dir: 'dabaifan-clone', prefix: 'prefix-dabaifan', label: '大白饭' },
    }
    const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']

    /** 0..9999 的中文读法 -> 片段名。 */
    function integerClips(n) {
      if (n <= 0) return ['0']
      const units = [[1000, 'thousand'], [100, 'hundred'], [10, 'ten'], [1, '']]
      const out = []
      let zeroPending = false
      for (const [value, clip] of units) {
        const d = Math.floor(n / value) % 10
        if (d === 0) {
          if (out.length > 0 && n % value !== 0) zeroPending = true
          continue
        }
        if (zeroPending) { out.push('0'); zeroPending = false }
        if (!(value === 10 && d === 1 && out.length === 0)) out.push(DIGITS[d])
        if (clip) out.push(clip)
      }
      return out
    }

    /** 金额 -> 片段名（整数 + 点 + 小数逐位 + 元）。 */
    function amountClips(amount) {
      const clamped = Math.max(0.01, Math.round(amount * 100) / 100)
      const [whole, fraction = ''] = clamped.toFixed(2).split('.')
      const clips = integerClips(Number(whole))
      const digits = fraction.replace(/0+$/, '')
      if (digits.length > 0) clips.push('dot', ...digits.split(''))
      clips.push('yuan')
      return clips
    }

    const readJSON = (key, fallback) => {
      try {
        const raw = localStorage.getItem(key)
        return raw ? { ...fallback, ...JSON.parse(raw) } : { ...fallback }
      } catch { return { ...fallback } }
    }
    const writeJSON = (key, value) => {
      try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* 存不下就只在内存里生效 */ }
    }

    const minutesOf = (hhmm) => Number(String(hhmm).slice(0, 2)) * 60 + Number(String(hhmm).slice(3, 5))

    function createController() {
      const config = readJSON(CONFIG_KEY, DEFAULTS)
      let log = (() => { try { const raw = localStorage.getItem(LOG_KEY); return raw ? JSON.parse(raw) : [] } catch { return [] } })()
      let seen = (() => { try { const raw = localStorage.getItem(SEEN_KEY); return raw ? JSON.parse(raw) : {} } catch { return {} } })()
      let view = {
        config,
        log,
        pricing: null,
        models: [],
        status: { costMeter: null, error: '', playing: false, lastText: '', sessionId: null, audio: 'idle' },
      }
      const listeners = new Set()
      const emit = (patch) => {
        view = { ...view, ...patch }
        for (const listener of listeners) listener()
      }
      const setStatus = (patch) => emit({ status: { ...view.status, ...patch } })
      let stopped = false
      let timer = null
      let sessionId = null
      let cursor = 0
      let busy = false
      let audioContext = null
      const buffers = new Map()
      const queue = []

      const pruneSeen = () => {
        const cutoff = Date.now() - 2 * 24 * 60 * 60_000
        const next = {}
        for (const [key, time] of Object.entries(seen)) if (Number(time) > cutoff) next[key] = time
        seen = next
      }

      const ensureAudio = () => {
        if (!audioContext) {
          const Audio = window.AudioContext || window.webkitAudioContext
          if (!Audio) return null
          audioContext = new Audio()
        }
        return audioContext
      }

      const loadBuffer = async (name) => {
        if (buffers.has(name)) return buffers.get(name)
        const context = ensureAudio()
        if (!context) throw new Error('浏览器不支持音频播放')
        const response = await fetch(`api/cost-voice/clip?name=${encodeURIComponent(name)}&v=2`, { cache: 'force-cache' })
        if (!response.ok) throw new Error(`音频片段读取失败 (${response.status})`)
        const bytes = await response.arrayBuffer()
        const buffer = await context.decodeAudioData(bytes)
        buffers.set(name, buffer)
        return buffer
      }

      const playClips = async (dir, clips) => {
        const context = ensureAudio()
        if (!context) { setStatus({ audio: 'unsupported' }); return }
        if (context.state === 'suspended') { try { await context.resume() } catch { /* 等用户手势 */ } }
        setStatus({ audio: context.state, playing: true })
        const master = context.createGain()
        master.gain.value = Math.max(0, Math.min(1, view.config.volume))
        master.connect(context.destination)
        let at = context.currentTime + 0.03
        const gap = Math.max(0, Number(view.config.gapMs) || 0) / 1000
        for (const clip of clips) {
          const buffer = await loadBuffer(`${dir}/${clip}.mp3`)
          const source = context.createBufferSource()
          source.buffer = buffer
          source.connect(master)
          source.start(at)
          at += buffer.duration + gap
        }
        const totalMs = Math.max(0, (at - context.currentTime) * 1000)
        await new Promise((resolve) => setTimeout(resolve, totalMs))
        setStatus({ playing: false })
      }

      // 大白饭：1–100 分钱的常用金额用整句预渲染，避免数字拼接的断句感；其余回落片段拼接。
      const playAnnouncement = async (pack, amount) => {
        const cents = Math.round(amount * 100)
        if (pack === 'dabaifan' && cents >= 1 && cents <= 100) {
          try { await playClips('dabaifan-amounts', [String(cents)]); return } catch { /* 还没预渲染到这一句就用拼接兜底 */ }
        }
        await playClips(PACKS[pack].dir, [PACKS[pack].prefix, ...amountClips(amount)])
      }

      const loadPricing = async () => {
        try {
          const response = await fetch('api/cost-voice/pricing', { cache: 'no-store' })
          if (!response.ok) return
          const pricing = await response.json()
          if (pricing && typeof pricing === 'object') emit({ pricing })
        } catch { /* 价格表读不到时用兜底单价 */ }
      }

      /** 某一轮使用模型的价格（元/百万 token）：用户覆盖 > 费用插件价格表 > 兜底单价。 */
      const priceOf = (record) => {
        const key = `${record?.provider ?? ''}/${record?.model ?? ''}`
        const override = view.config.modelPrices?.[key] ?? {}
        const catalog = view.pricing?.providers?.[record?.provider]?.[record?.model] ?? {}
        const pick = (field) => {
          const value = override[field] ?? catalog[field]
          return Number.isFinite(value) ? value : undefined
        }
        const fallbackInput = Math.max(0, Number(view.config.inputPrice) || 0)
        const fallbackOutput = Math.max(0, Number(view.config.outputPrice) || 0)
        return {
          input: pick('input') ?? fallbackInput,
          output: pick('output') ?? fallbackOutput,
          cachedInput: pick('cachedInput') ?? fallbackInput * 0.1,
          cacheWrite: pick('cacheWrite') ?? fallbackInput * 1.25,
        }
      }

      const estimateAmount = (record) => {
        const price = priceOf(record)
        const usage = record.usage ?? {}
        const per = (tokens, rate) => (Number(tokens) || 0) * (Number(rate) || 0) / 1_000_000
        return per(usage.inputTokens, price.input)
          + per(usage.outputTokens, price.output)
          + per(usage.cacheReadTokens, price.cachedInput)
          + per(usage.cacheWriteTokens, price.cacheWrite)
          + per(usage.reasoningTokens, price.output)
      }

      const resolveAmount = (record) => {
        if (view.config.basis !== 'tokens' && typeof record.costCny === 'number' && Number.isFinite(record.costCny)) {
          return { amount: record.costCny, source: 'cost-meter' }
        }
        return { amount: estimateAmount(record), source: 'estimate' }
      }

      const inQuietHours = () => {
        const c = view.config
        if (!c.quiet || c.quietStart === c.quietEnd) return false
        const now = new Date()
        const minutes = now.getHours() * 60 + now.getMinutes()
        const start = minutesOf(c.quietStart)
        const end = minutesOf(c.quietEnd)
        return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end
      }

      const announce = async (record) => {
        const key = `${record.sessionId}:${record.turn}`
        if (seen[key]) return
        seen[key] = Date.now()
        pruneSeen()
        writeJSON(SEEN_KEY, seen)
        if (!view.config.enabled) return
        if (view.config.completedOnly && record.kind !== 'completed') return
        if (inQuietHours()) return
        const { amount, source } = resolveAmount(record)
        const rounded = Math.max(0.01, Math.round(amount * 100) / 100)
        if (rounded < view.config.minAmount) return
        const pack = view.config.voice === 'dabaifan' ? 'dabaifan' : 'alipay'
        const text = `${PACKS[pack].label} ${rounded.toFixed(2)} 元`
        if (view.status.playing) return
        log = [{ time: Date.now(), turn: record.turn, amount: rounded, pack, source, text, provider: record.provider ?? '', model: record.model ?? '' }, ...log].slice(0, 20)
        writeJSON(LOG_KEY, log)
        emit({ log })
        try { await playAnnouncement(pack, rounded) } catch { /* 播放失败不打断会话 */ }
      }

      const poll = async () => {
        if (stopped || busy || !sessionId) return
        if (document.visibilityState !== 'visible') return
        busy = true
        try {
          const query = new URLSearchParams({ sessionId, since: String(cursor) })
          const response = await fetch(`api/cost-voice/turns?${query}`, { cache: 'no-store' })
          if (!response.ok) throw new Error(`状态接口 ${response.status}`)
          const data = await response.json()
          setStatus({ costMeter: Boolean(data.costMeter), error: '' })
          const seenModels = Array.isArray(data.models) ? data.models.slice(0, 6) : [...view.models]
          for (const record of data.events ?? []) {
            if (!record?.provider || !record?.model) continue
            const key = `${record.provider}/${record.model}`
            if (!seenModels.some((entry) => entry.key === key)) seenModels.unshift({ key, provider: record.provider, model: record.model })
          }
          if (seenModels.length !== view.models.length) emit({ models: seenModels.slice(0, 6) })
          if (Number.isSafeInteger(data.seq)) {
            if (data.seq < cursor) cursor = 0
            const baseline = cursor === 0
            cursor = data.seq
            if (!baseline) for (const record of data.events ?? []) await announce(record)
          }
        } catch (error) {
          setStatus({ error: String(error?.message ?? error) })
        } finally {
          busy = false
        }
      }

      timer = setInterval(poll, 1500)
      document.addEventListener('visibilitychange', poll)
      void loadPricing()

      return {
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
        getSnapshot: () => view,
        selectSession(id) {
          if (sessionId === id) return
          sessionId = id
          cursor = 0
          setStatus({ sessionId: id })
          void poll()
        },
        update(patch) {
          const next = { ...view.config, ...patch }
          emit({ config: next })
          writeJSON(CONFIG_KEY, next)
        },
        preview(amount = 0.12) {
          const pack = view.config.voice === 'dabaifan' ? 'dabaifan' : 'alipay'
          void playAnnouncement(pack, amount).catch(() => {})
        },
        clearLog() {
          log = []
          writeJSON(LOG_KEY, [])
          emit({ log })
        },
        dispose() {
          stopped = true
          clearInterval(timer)
          document.removeEventListener('visibilitychange', poll)
          if (audioContext) void audioContext.close().catch(() => {})
          listeners.clear()
        },
      }
    }

    const useView = (controller) => useSyncExternalStore(controller.subscribe, controller.getSnapshot)

    function Overlay({ controller, useSessions }) {
      const current = useSessions((state) => Object.values(state.byId)
        .find((row) => (row?.retainedBy?.mainView ?? 0) > 0)?.id)
      useEffect(() => { controller.selectSession(current) }, [controller, current])
      return null
    }

    const css = `
.cv-page { display: flex; flex-direction: column; gap: 20px; font-size: 13px; color: var(--dsw-alias-label-primary); }
.cv-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.cv-row > span { color: var(--dsw-alias-label-secondary); }
.cv-group { display: flex; flex-direction: column; gap: 12px; padding: 14px 16px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); }
.cv-group > h3 { margin: 0; font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.cv-seg { display: inline-flex; padding: 2px; gap: 2px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); }
.cv-seg button { border: 0; background: transparent; color: var(--dsw-alias-label-secondary); font-size: 12px; padding: 5px 12px; border-radius: 6px; cursor: pointer; }
.cv-seg button[aria-pressed="true"] { background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); box-shadow: 0 1px 2px rgba(0,0,0,.12); }
.cv-num { width: 96px; padding: 5px 8px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-size: 12px; text-align: right; }
.cv-switch { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; }
.cv-switch input { width: 16px; height: 16px; accent-color: var(--dsw-alias-brand-primary); }
.cv-actions { display: flex; gap: 8px; }
.cv-actions button { border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); border-radius: 8px; padding: 6px 12px; font-size: 12px; cursor: pointer; }
.cv-actions button.primary { border-color: transparent; background: var(--dsw-alias-brand-primary); color: #fff; }
.cv-log { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0; list-style: none; }
.cv-log li { display: flex; justify-content: space-between; gap: 12px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.cv-log b { color: var(--dsw-alias-label-primary); font-weight: 600; }
.cv-note { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.6; }
.cv-warn { color: var(--dsw-alias-state-warn-primary); }
.cv-error { color: var(--dsw-alias-state-error-primary); }
`

    function Settings({ controller }) {
      const v = useView(controller)
      const c = v.config
      const update = (patch) => controller.update(patch)
      const [draft, setDraft] = useState({ inputPrice: String(c.inputPrice), outputPrice: String(c.outputPrice), minAmount: String(c.minAmount), gapMs: String(c.gapMs) })
      useEffect(() => {
        setDraft({ inputPrice: String(c.inputPrice), outputPrice: String(c.outputPrice), minAmount: String(c.minAmount), gapMs: String(c.gapMs) })
      }, [c.inputPrice, c.outputPrice, c.minAmount, c.gapMs])
      const commit = (key) => (event) => {
        const raw = event.target.value
        setDraft((d) => ({ ...d, [key]: raw }))
        const value = Number(raw)
        if (raw.trim() !== '' && Number.isFinite(value) && value >= 0) update({ [key]: value })
      }
      const segment = (key, options) => h('div', { className: 'cv-seg', role: 'group' },
        options.map(([value, label]) => h('button', {
          key: value, type: 'button', 'aria-pressed': c[key] === value, onClick: () => update({ [key]: value }),
        }, label)))
      const toggle = (key, label) => h('label', { className: 'cv-switch' },
        h('input', { type: 'checkbox', checked: Boolean(c[key]), onChange: (event) => update({ [key]: event.target.checked }) }),
        h('span', null, label))
      const number = (key, label, suffix) => h('label', { className: 'cv-row' },
        h('span', null, label),
        h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
          h('input', { className: 'cv-num', type: 'number', min: 0, step: 'any', value: draft[key], onChange: commit(key) }),
          h('span', { style: { fontSize: 12 } }, suffix)))
      const costMeter = v.status.costMeter
      const catalogOf = (provider, model) => v.pricing?.providers?.[provider]?.[model] ?? {}
      const pricingNote = v.pricing
        ? `价格表：${v.pricing.source === 'dsh-cost-meter' ? 'dsh-cost-meter' : '插件内置'} · ${v.pricing.generatedAt ?? '—'} · ${v.pricing.count} 个模型 · USD→CNY ${v.pricing.fx}`
        : '价格表读取中…'
      const updateModelPrice = (key, field, raw) => {
        const value = Number(raw)
        if (!Number.isFinite(value) || value < 0) return
        const next = { ...(c.modelPrices ?? {}) }
        next[key] = { ...(next[key] ?? {}), [field]: value }
        update({ modelPrices: next })
      }
      const modelPriceRow = ({ key, provider, model }) => {
        const catalog = catalogOf(provider, model)
        const entry = c.modelPrices?.[key] ?? {}
        return h('div', { className: 'cv-row', key },
          h('span', { title: key }, model),
          h('span', { style: { display: 'inline-flex', gap: 6, alignItems: 'center' } },
            h('input', {
              className: 'cv-num', type: 'number', min: 0, step: 'any',
              placeholder: catalog.input !== undefined ? String(catalog.input) : '输入',
              value: entry.input ?? '', onChange: (event) => updateModelPrice(key, 'input', event.target.value),
            }),
            h('input', {
              className: 'cv-num', type: 'number', min: 0, step: 'any',
              placeholder: catalog.output !== undefined ? String(catalog.output) : '输出',
              value: entry.output ?? '', onChange: (event) => updateModelPrice(key, 'output', event.target.value),
            })))
      }
      return h('div', { className: 'cv-page' },
        h('style', null, css),
        h('section', { className: 'cv-group' },
          h('h3', null, '播报'),
          h('div', { className: 'cv-row' }, h('span', null, '启用'), toggle('enabled', c.enabled ? '开启' : '关闭')),
          h('div', { className: 'cv-row' }, h('span', null, '音色'), segment('voice', [['alipay', '支付宝'], ['dabaifan', '大白饭']])),
          h('div', { className: 'cv-row' }, h('span', null, '金额来源'), segment('basis', [['auto', '费用插件'], ['tokens', '按单价估算']])),
          h('div', { className: 'cv-actions' },
            h('button', { type: 'button', className: 'primary', onClick: () => controller.preview() }, '试听'),
            h('button', { type: 'button', onClick: () => controller.clearLog() }, '清空记录')),
          h('p', { className: 'cv-note' },
            costMeter === null ? '费用插件状态读取中…' : costMeter ? '已连接 dsh-cost-meter，金额取它的每轮费用。' : '未检测到 dsh-cost-meter，金额按模型价格估算。')),
        h('section', { className: 'cv-group' },
          h('h3', null, '播放'),
          number('minAmount', '低于此金额不播（元）', ''),
          number('gapMs', '片段间隔（毫秒）', ''),
          h('div', { className: 'cv-row' }, h('span', null, '音量'),
            h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: c.volume, onChange: (event) => update({ volume: Number(event.target.value) }) }))),
        h('section', { className: 'cv-group' },
          h('h3', null, '模型价格（元/百万 token）'),
          h('p', { className: 'cv-note' }, pricingNote),
          v.models.length > 0 ? h(React.Fragment, null,
            v.models.map(modelPriceRow),
            h('p', { className: 'cv-note' }, '每行两列：输入 / 输出。留空则用价格表里的值。')) : null,
          number('inputPrice', '其他模型：输入价', ''),
          number('outputPrice', '其他模型：输出价', ''),
          h('p', { className: 'cv-note' }, '仅在「按单价估算」时生效。')),
        h('section', { className: 'cv-group' },
          h('h3', null, '时机'),
          h('div', { className: 'cv-row' }, h('span', null, '只在正常完成的轮次播报'), toggle('completedOnly', c.completedOnly ? '是' : '否')),
          h('div', { className: 'cv-row' }, h('span', null, '静音时段'), toggle('quiet', c.quiet ? '开启' : '关闭')),
          c.quiet ? h('div', { className: 'cv-row' }, h('span', null, '从 / 到'),
            h('span', { style: { display: 'inline-flex', gap: 6, alignItems: 'center' } },
              h('input', { className: 'cv-num', type: 'time', value: c.quietStart, onChange: (event) => update({ quietStart: event.target.value }) }),
              h('input', { className: 'cv-num', type: 'time', value: c.quietEnd, onChange: (event) => update({ quietEnd: event.target.value }) }))) : null),
        h('section', { className: 'cv-group' },
          h('h3', null, '最近播报'),
          v.log.length === 0 ? h('p', { className: 'cv-note' }, '还没有播报记录。') : h('ul', { className: 'cv-log' },
            v.log.map((entry) => h('li', { key: `${entry.time}-${entry.turn}` },
              h('span', null, `${new Date(entry.time).toLocaleTimeString()} · 第 ${entry.turn} 轮`),
              h('b', null, `${entry.text}${entry.source === 'estimate' ? '（估算）' : ''}`)))),
          v.status.error ? h('p', { className: 'cv-error' }, `状态读取失败：${v.status.error}`) : null,
          v.status.audio === 'suspended' ? h('p', { className: 'cv-note cv-warn' }, '浏览器暂未允许播放声音，点一次「试听」后再继续。') : null,
        ))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const controller = createController()
        ctx.effect(() => () => controller.dispose(), 'cost-voice: player')
        ctx.slots.inject('shell.overlay', () => ctx.slots.register(
          { name: 'shell.overlay', id: 'cost-voice', order: 60 },
          (props) => h(Overlay, { ...props, controller }),
        ))
        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register(
          { name: 'plugins.bundle.config', key: 'dsh-cost-voice' },
          (props) => (props.view === 'page' ? h(Settings, { ...props, controller }) : null),
        ))
      },
    }
  },
})

