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

    /** 0..99999999 的中文读法 -> 片段名（万以上借 ten-thousand 片段）。 */
    function integerClips(n) {
      if (n <= 0) return ['0']
      if (n >= 10000) {
        const high = Math.floor(n / 10000)
        const rest = n % 10000
        const out = [...integerClips(high), 'ten-thousand']
        if (rest === 0) return out
        // 「一万零一」「一万一千」中间的零在中文里要念出来。
        if (rest < 1000) out.push('0')
        return [...out, ...integerClips(rest)]
      }
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

    /** 真正的零保持零；正数不足一分时仍播一分，避免听成免费。 */
    function roundedAmount(amount) {
      return amount > 0 ? Math.max(0.01, Math.round(amount * 100) / 100) : 0
    }

    /** 金额 -> 片段名（整数 + 点 + 小数逐位 + 元）。 */
    function amountClips(amount) {
      const clamped = roundedAmount(amount)
      const [whole, fraction = ''] = clamped.toFixed(2).split('.')
      const clips = integerClips(Number(whole))
      const digits = fraction.replace(/0+$/, '')
      if (digits.length > 0) clips.push('dot', ...digits.split(''))
      clips.push('yuan')
      return clips
    }

    /**
     * 按一轮用量与单价估算费用（元）。
     * harness 的 usage.outputTokens 已经包含推理 token（dsh-llm-pi-ai 的 mapUsage 约定），
     * 所以这里不能再单独加一次 reasoningTokens，否则推理多的轮次会被算贵一倍。
     */
    function estimateFromUsage(usage = {}, price = {}) {
      const per = (tokens, rate) => (Number(tokens) || 0) * (Number(rate) || 0) / 1_000_000
      return per(usage.inputTokens, price.input)
        + per(usage.outputTokens, price.output)
        + per(usage.cacheReadTokens, price.cachedInput)
        + per(usage.cacheWriteTokens, price.cacheWrite)
    }

    /** 某轮用到的模型单价（元/百万 token）：用户覆盖 > 费用插件价格表 > 兜底单价。 */
    function pickPrice({ config, pricing, record }) {
      const key = `${record?.provider ?? ''}/${record?.model ?? ''}`
      const override = config?.modelPrices?.[key] ?? {}
      const catalog = pricing?.providers?.[record?.provider]?.[record?.model] ?? {}
      const pick = (field) => {
        const value = override[field] ?? catalog[field]
        return Number.isFinite(value) ? value : undefined
      }
      const fallbackInput = Math.max(0, Number(config?.inputPrice) || 0)
      const fallbackOutput = Math.max(0, Number(config?.outputPrice) || 0)
      return {
        input: pick('input') ?? fallbackInput,
        output: pick('output') ?? fallbackOutput,
        cachedInput: pick('cachedInput') ?? fallbackInput * 0.1,
        cacheWrite: pick('cacheWrite') ?? fallbackInput * 1.25,
      }
    }

    /**
     * 这一轮播多少钱：cost-meter 明确算过（found:true）就用它的金额，否则按单价估算。
     * cost-meter 对未定价轮次返回 found:false、cost:0——那是「不知道」，不是「花了 0 元」。
     */
    function resolveAmountOf({ config, pricing, record }) {
      const usable = config?.basis !== 'tokens'
      const known = record?.costFound === true && typeof record.costCny === 'number' && Number.isFinite(record.costCny)
      if (usable && known) return { amount: record.costCny, source: 'cost-meter' }
      // 兼容只带 costCny 的旧版宿主：有正数金额就采信。
      if (usable && typeof record?.costCny === 'number' && record.costCny > 0) return { amount: record.costCny, source: 'cost-meter' }
      return { amount: estimateFromUsage(record?.usage, pickPrice({ config, pricing, record })), source: 'estimate' }
    }

    let ACTIVE_LOCALE = 'zh'
    const I18N = {
      zh: {
        on: '开启', off: '关闭', yes: '是', no: '否',
        sectionAnnounce: '播报', enabled: '启用', voice: '音色', alipay: '支付宝', dabaifan: '大白饭',
        basis: '金额来源', basisMeter: '费用插件', basisTokens: '按单价估算',
        preview: '试听', clearLog: '清空记录',
        meterReading: '费用插件状态读取中…',
        meterConnected: '已连接 dsh-cost-meter，金额取它的每轮费用。',
        meterMissing: '未检测到 dsh-cost-meter，金额按模型价格估算。',
        sectionPlay: '播放', minAmount: '低于此金额不播（元）', gapMs: '片段间隔（毫秒）', volume: '音量',
        sectionPrice: '模型价格（元/百万 token）',
        pricingReading: '价格表读取中…',
        modelRowHint: '每行两列：输入 / 输出。留空则用价格表里的值。',
        fallbackInput: '其他模型：输入价', fallbackOutput: '其他模型：输出价',
        estimateOnly: '仅在「按单价估算」时生效。',
        sectionTiming: '时机', completedOnly: '只在正常完成的轮次播报', quiet: '静音时段', quietFromTo: '从 / 到',
        sectionLog: '最近播报', emptyLog: '还没有播报记录。',
        statusError: '状态读取失败：', estimateSuffix: '（估算）', turnLabel: '轮',
        currencyUnit: '元', pricingTable: '价格表', pricingBuiltin: '插件内置', pricingModels: '个模型',
        placeholderInput: '输入', placeholderOutput: '输出',
        audioBlocked: '浏览器暂未允许播放声音，点一次「试听」后再重试。',
        audioUnsupported: '浏览器不支持音频播放。',
        audioLoadFailed: '音频片段读取失败', audioFailed: '播放失败',
        audioInterrupted: '播放因页面刷新或插件停用而中断，可手动重试。',
        queued: '排队中', playing: '播放中', failed: '播放失败', skipped: '队列已满，未播放', retry: '重试',
      },
      en: {
        on: 'On', off: 'Off', yes: 'Yes', no: 'No',
        sectionAnnounce: 'Announcement', enabled: 'Enabled', voice: 'Voice', alipay: 'Alipay', dabaifan: 'Big fish',
        basis: 'Amount source', basisMeter: 'Cost plugin', basisTokens: 'Estimate',
        preview: 'Preview', clearLog: 'Clear log',
        meterReading: 'Checking the cost plugin…',
        meterConnected: 'Connected to dsh-cost-meter; amounts come from its per-turn cost.',
        meterMissing: 'dsh-cost-meter not found; amounts are estimated from model prices.',
        sectionPlay: 'Playback', minAmount: 'Skip below this amount (CNY)', gapMs: 'Clip gap (ms)', volume: 'Volume',
        sectionPrice: 'Model prices (CNY / 1M tokens)',
        pricingReading: 'Loading price table…',
        modelRowHint: 'Two columns per model: input / output. Leave empty to use the price table.',
        fallbackInput: 'Other models: input', fallbackOutput: 'Other models: output',
        estimateOnly: 'Only used when the amount is estimated.',
        sectionTiming: 'Timing', completedOnly: 'Only announce completed turns', quiet: 'Quiet hours', quietFromTo: 'From / to',
        sectionLog: 'Recent announcements', emptyLog: 'Nothing announced yet.',
        statusError: 'Status request failed: ', estimateSuffix: ' (estimate)', turnLabel: 'turn',
        currencyUnit: 'CNY', pricingTable: 'Price table', pricingBuiltin: 'bundled', pricingModels: 'models',
        placeholderInput: 'in', placeholderOutput: 'out',
        audioBlocked: 'The browser blocked audio. Press "Preview", then retry.',
        audioUnsupported: 'This browser does not support audio playback.',
        audioLoadFailed: 'Could not load audio clip', audioFailed: 'Playback failed',
        audioInterrupted: 'Playback was interrupted by a page reload or plugin shutdown. Retry manually.',
        queued: 'Queued', playing: 'Playing', failed: 'Playback failed', skipped: 'Queue full; not played', retry: 'Retry',
      },
    }
    const t = (key) => (I18N[ACTIVE_LOCALE] ?? I18N.zh)[key] ?? I18N.zh[key] ?? key

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
      // 音频队列不跨页面/插件实例恢复；中断记录必须可手动补播，不能永远停在瞬态。
      if (!Array.isArray(log)) log = []
      log = log.map((entry) => ['queued', 'playing'].includes(entry?.state)
        ? { ...entry, state: 'failed', error: t('audioInterrupted') }
        : entry)
      writeJSON(LOG_KEY, log)
      let seen = (() => { try { const raw = localStorage.getItem(SEEN_KEY); return raw ? JSON.parse(raw) : {} } catch { return {} } })()
      let view = {
        config,
        log,
        pricing: null,
        models: [],
        status: { costMeter: null, error: '', audioError: '', playing: false, sessionId: null, audio: 'idle' },
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
      let initialized = false
      let sessionGeneration = 0
      let busy = false
      let audioContext = null
      let cancelPlayback = null
      const BUFFER_LIMIT = 512
      const buffers = new Map()
      const queue = []
      let pumping = false

      const updateLog = (id, patch) => {
        if (!id || stopped) return
        log = log.map((entry) => entry.id === id ? { ...entry, ...patch } : entry)
        writeJSON(LOG_KEY, log)
        emit({ log })
      }
      const playbackError = (error) => String(error?.message ?? t('audioFailed'))

      const pruneSeen = () => {
        const cutoff = Date.now() - 2 * 24 * 60 * 60_000
        const next = {}
        for (const [key, time] of Object.entries(seen)) if (Number(time) > cutoff) next[key] = time
        seen = next
      }

      const ensureAudio = () => {
        if (stopped) throw new Error('Player disposed')
        if (!audioContext) {
          const Audio = window.AudioContext || window.webkitAudioContext
          if (!Audio) throw new Error(t('audioUnsupported'))
          audioContext = new Audio()
        }
        return audioContext
      }

      // 必须在按钮的用户手势内调用 resume，不能等下载完音频才解锁。
      const unlockAudio = () => {
        try {
          const context = ensureAudio()
          if (context.state === 'suspended') void context.resume().catch(() => {})
        } catch (error) { setStatus({ audioError: playbackError(error) }) }
      }

      const CLIP_VERSION = 3

      const loadBuffer = async (name) => {
        const cached = buffers.get(name)
        if (cached) return cached
        const context = ensureAudio()
        const response = await fetch(`api/cost-voice/clip?name=${encodeURIComponent(name)}&v=${CLIP_VERSION}`, { cache: 'force-cache' })
        if (!response.ok) throw new Error(`${t('audioLoadFailed')} (${response.status})`)
        const bytes = await response.arrayBuffer()
        const buffer = await context.decodeAudioData(bytes)
        if (buffers.size >= BUFFER_LIMIT) buffers.delete(buffers.keys().next().value)
        buffers.set(name, buffer)
        return buffer
      }

      /** 先把一整句的所有片段并行取回并解码，再按顺序排时间轴——避免首句边取边播的等待与卡顿。 */
      const prefetch = async (dir, clips) => {
        const names = clips.map((clip) => `${dir}/${clip}.mp3`)
        const settled = await Promise.allSettled(names.map(loadBuffer))
        const failed = settled.find((item) => item.status === 'rejected')
        if (failed) throw failed.reason
        return settled.map((item) => item.value)
      }

      const playBuffers = async (buffersList) => {
        const context = ensureAudio()
        if (context.state === 'suspended') {
          setStatus({ audio: context.state })
          let timeout
          try {
            await Promise.race([
              context.resume(),
              new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(t('audioBlocked'))), 1500) }),
            ])
          } finally { clearTimeout(timeout) }
        }
        if (context.state !== 'running') throw new Error(t('audioBlocked'))
        if (stopped) return
        setStatus({ audio: context.state, playing: true })
        const master = context.createGain()
        const sources = []
        try {
          master.gain.value = Math.max(0, Math.min(1, view.config.volume))
          master.connect(context.destination)
          let at = context.currentTime + 0.03
          const gap = Math.max(0, Number(view.config.gapMs) || 0) / 1000
          for (const buffer of buffersList) {
            const source = context.createBufferSource()
            sources.push(source)
            source.buffer = buffer
            source.connect(master)
            source.start(at)
            at += buffer.duration + gap
          }
          const totalMs = Math.max(0, (at - context.currentTime) * 1000)
          await new Promise((resolve) => {
            const timeout = setTimeout(resolve, totalMs)
            cancelPlayback = () => { clearTimeout(timeout); resolve() }
          })
        } finally {
          cancelPlayback = null
          for (const source of sources) { try { source.stop(); source.disconnect() } catch { /* 已结束或已关闭 */ } }
          master.disconnect()
        }
      }

      const playClips = async (dir, clips) => {
        const buffersList = await prefetch(dir, clips)
        await playBuffers(buffersList)
      }

      // 大白饭：1–100 分钱的常用金额用整句预渲染，避免数字拼接的断句感；其余回落片段拼接。
      const playAnnouncement = async (pack, amount) => {
        const cents = Math.round(amount * 100)
        if (pack === 'dabaifan' && cents >= 1 && cents <= 100) {
          let whole
          try { whole = await prefetch('dabaifan-amounts', [String(cents)]) } catch { /* 整句资源缺失时用拼接兜底 */ }
          if (whole) { await playBuffers(whole); return }
        }
        await playClips(PACKS[pack].dir, [PACKS[pack].prefix, ...amountClips(amount)])
      }

      /** 播报排队：正在播的时候来了新一轮就排在后面，而不是直接丢掉。 */
      const pump = async () => {
        if (pumping) return
        pumping = true
        try {
          while (!stopped && queue.length > 0) {
            const job = queue.shift()
            updateLog(job.id, { state: 'playing', error: '' })
            try {
              await playAnnouncement(job.pack, job.amount)
              if (!stopped) {
                updateLog(job.id, { state: 'played', error: '' })
                setStatus({ audioError: '' })
              }
            } catch (error) {
              if (!stopped) {
                const message = playbackError(error)
                updateLog(job.id, { state: 'failed', error: message })
                setStatus({ audioError: message })
              }
            }
          }
        } finally {
          pumping = false
          if (!stopped) setStatus({ playing: false })
        }
      }

      const enqueue = (pack, amount, id) => {
        if (stopped) return
        queue.push({ pack, amount, id })
        if (queue.length > 4) {
          for (const dropped of queue.splice(0, queue.length - 4)) updateLog(dropped.id, { state: 'skipped' })
        }
        setStatus({ playing: true })
        void pump()
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
      const priceOf = (record) => pickPrice({ config: view.config, pricing: view.pricing, record })

      const estimateAmount = (record) => estimateFromUsage(record?.usage, priceOf(record))

      const resolveAmount = (record) => resolveAmountOf({ config: view.config, pricing: view.pricing, record })

      const inQuietHours = () => {
        const c = view.config
        if (!c.quiet || c.quietStart === c.quietEnd) return false
        const now = new Date()
        const minutes = now.getHours() * 60 + now.getMinutes()
        const start = minutesOf(c.quietStart)
        const end = minutesOf(c.quietEnd)
        return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end
      }

      const announce = (record) => {
        const key = `${record.sessionId}:${record.turn}`
        if (seen[key]) return
        seen[key] = Date.now()
        pruneSeen()
        writeJSON(SEEN_KEY, seen)
        if (!view.config.enabled) return
        if (view.config.completedOnly && record.kind !== 'completed') return
        if (inQuietHours()) return
        const { amount, source } = resolveAmount(record)
        if (!Number.isFinite(amount) || amount < view.config.minAmount) return
        const rounded = roundedAmount(amount)
        const pack = view.config.voice === 'dabaifan' ? 'dabaifan' : 'alipay'
        const text = `${t(pack)} ${rounded.toFixed(2)} ${t('currencyUnit')}`
        log = [{ id: key, state: 'queued', error: '', time: Date.now(), turn: record.turn, amount: rounded, pack, source, text, provider: record.provider ?? '', model: record.model ?? '' }, ...log].slice(0, 20)
        writeJSON(LOG_KEY, log)
        emit({ log })
        enqueue(pack, rounded, key)
      }

      const poll = async () => {
        if (stopped || busy || !sessionId) return
        if (document.visibilityState !== 'visible') return
        busy = true
        const generation = sessionGeneration
        try {
          const query = new URLSearchParams({ sessionId, since: String(cursor) })
          const response = await fetch(`api/cost-voice/turns?${query}`, { cache: 'no-store' })
          if (!response.ok) throw new Error(`状态接口 ${response.status}`)
          const data = await response.json()
          if (stopped || generation !== sessionGeneration) return
          setStatus({ costMeter: Boolean(data.costMeter), error: '' })
          const seenModels = Array.isArray(data.models) ? data.models.slice(0, 6) : [...view.models]
          for (const record of data.events ?? []) {
            if (!record?.provider || !record?.model) continue
            const key = `${record.provider}/${record.model}`
            if (!seenModels.some((entry) => entry.key === key)) seenModels.unshift({ key, provider: record.provider, model: record.model })
          }
          const nextModels = seenModels.slice(0, 6)
          if (JSON.stringify(nextModels) !== JSON.stringify(view.models)) emit({ models: nextModels })
          if (Number.isSafeInteger(data.seq) && data.seq >= 0) {
            const baseline = !initialized || data.seq < cursor
            initialized = true
            cursor = data.seq
            if (!baseline) for (const record of data.events ?? []) announce(record)
          }
        } catch (error) {
          if (!stopped && generation === sessionGeneration) setStatus({ error: String(error?.message ?? error) })
        } finally {
          busy = false
          // 切换会话期间的旧请求不能覆盖新游标；它退场后立即取新会话基线。
          if (!stopped && generation !== sessionGeneration) void poll()
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
          sessionGeneration += 1
          cursor = 0
          initialized = false
          setStatus({ sessionId: id })
          void poll()
        },
        update(patch) {
          const next = { ...view.config, ...patch }
          emit({ config: next })
          writeJSON(CONFIG_KEY, next)
        },
        preview(amount = 0.12) {
          unlockAudio()
          const pack = view.config.voice === 'dabaifan' ? 'dabaifan' : 'alipay'
          enqueue(pack, amount)
        },
        retry(id) {
          const entry = log.find((item) => item.id === id)
          if (!entry || !['failed', 'skipped'].includes(entry.state)) return
          unlockAudio()
          updateLog(id, { state: 'queued', error: '' })
          enqueue(entry.pack, entry.amount, id)
        },
        clearLog() {
          log = []
          writeJSON(LOG_KEY, [])
          emit({ log })
        },
        dispose() {
          stopped = true
          sessionGeneration += 1
          queue.length = 0
          if (cancelPlayback) cancelPlayback()
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
.cv-actions button, .cv-log button { border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); border-radius: 8px; padding: 6px 12px; font-size: 12px; cursor: pointer; }
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
        ? `${t('pricingTable')}: ${v.pricing.source === 'dsh-cost-meter' ? 'dsh-cost-meter' : t('pricingBuiltin')} · ${v.pricing.generatedAt ?? '—'} · ${v.pricing.count} ${t('pricingModels')} · USD→CNY ${v.pricing.fx}`
        : t('pricingReading')
      const updateModelPrice = (key, field, raw) => {
        const next = { ...(c.modelPrices ?? {}) }
        const entry = { ...(next[key] ?? {}) }
        if (raw.trim() === '') {
          delete entry[field]
        } else {
          const value = Number(raw)
          if (!Number.isFinite(value) || value < 0) return
          entry[field] = value
        }
        if (Object.keys(entry).length > 0) next[key] = entry
        else delete next[key]
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
              placeholder: catalog.input !== undefined ? String(catalog.input) : t('placeholderInput'),
              value: entry.input ?? '', onChange: (event) => updateModelPrice(key, 'input', event.target.value),
            }),
            h('input', {
              className: 'cv-num', type: 'number', min: 0, step: 'any',
              placeholder: catalog.output !== undefined ? String(catalog.output) : t('placeholderOutput'),
              value: entry.output ?? '', onChange: (event) => updateModelPrice(key, 'output', event.target.value),
            })))
      }
      return h('div', { className: 'cv-page' },
        h('style', null, css),
        h('section', { className: 'cv-group' },
          h('h3', null, t('sectionAnnounce')),
          h('div', { className: 'cv-row' }, h('span', null, t('enabled')), toggle('enabled', c.enabled ? t('on') : t('off'))),
          h('div', { className: 'cv-row' }, h('span', null, t('voice')), segment('voice', [['alipay', t('alipay')], ['dabaifan', t('dabaifan')]])),
          h('div', { className: 'cv-row' }, h('span', null, t('basis')), segment('basis', [['auto', t('basisMeter')], ['tokens', t('basisTokens')]])),
          h('div', { className: 'cv-actions' },
            h('button', { type: 'button', className: 'primary', onClick: () => controller.preview() }, t('preview')),
            h('button', { type: 'button', onClick: () => controller.clearLog() }, t('clearLog'))),
          h('p', { className: 'cv-note' },
            costMeter === null ? t('meterReading') : costMeter ? t('meterConnected') : t('meterMissing'))),
        h('section', { className: 'cv-group' },
          h('h3', null, t('sectionPlay')),
          number('minAmount', t('minAmount'), ''),
          number('gapMs', t('gapMs'), ''),
          h('div', { className: 'cv-row' }, h('span', null, t('volume')),
            h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: c.volume, onChange: (event) => update({ volume: Number(event.target.value) }) }))),
        h('section', { className: 'cv-group' },
          h('h3', null, t('sectionPrice')),
          h('p', { className: 'cv-note' }, pricingNote),
          v.models.length > 0 ? h(React.Fragment, null,
            v.models.map(modelPriceRow),
            h('p', { className: 'cv-note' }, t('modelRowHint'))) : null,
          number('inputPrice', t('fallbackInput'), ''),
          number('outputPrice', t('fallbackOutput'), ''),
          h('p', { className: 'cv-note' }, t('estimateOnly'))),
        h('section', { className: 'cv-group' },
          h('h3', null, t('sectionTiming')),
          h('div', { className: 'cv-row' }, h('span', null, t('completedOnly')), toggle('completedOnly', c.completedOnly ? t('yes') : t('no'))),
          h('div', { className: 'cv-row' }, h('span', null, t('quiet')), toggle('quiet', c.quiet ? t('on') : t('off'))),
          c.quiet ? h('div', { className: 'cv-row' }, h('span', null, t('quietFromTo')),
            h('span', { style: { display: 'inline-flex', gap: 6, alignItems: 'center' } },
              h('input', { className: 'cv-num', type: 'time', value: c.quietStart, onChange: (event) => update({ quietStart: event.target.value }) }),
              h('input', { className: 'cv-num', type: 'time', value: c.quietEnd, onChange: (event) => update({ quietEnd: event.target.value }) }))) : null),
        h('section', { className: 'cv-group' },
          h('h3', null, t('sectionLog')),
          v.log.length === 0 ? h('p', { className: 'cv-note' }, t('emptyLog')) : h('ul', { className: 'cv-log' },
            v.log.map((entry) => h('li', { key: `${entry.time}-${entry.turn}` },
              h('span', null, `${new Date(entry.time).toLocaleTimeString()} · ${t('turnLabel')} ${entry.turn}`),
              h('b', null, `${entry.text}${entry.source === 'estimate' ? t('estimateSuffix') : ''}`),
              entry.state && entry.state !== 'played' ? h('span', { className: entry.state === 'failed' ? 'cv-error' : '', title: entry.error || undefined },
                t(entry.state),
                ['failed', 'skipped'].includes(entry.state) ? h('button', { type: 'button', onClick: () => controller.retry(entry.id) }, t('retry')) : null) : null))),
          v.status.error ? h('p', { className: 'cv-error' }, `${t('statusError')}${v.status.error}`) : null,
          v.status.audioError ? h('p', { className: 'cv-error', role: 'alert' }, v.status.audioError) : null,
          v.status.audio === 'suspended' && !v.status.audioError ? h('p', { className: 'cv-note cv-warn' }, t('audioBlocked')) : null,
        ))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        try {
          const active = String(ctx.get('locale')?.getSnapshot?.()?.active ?? '')
          ACTIVE_LOCALE = active.toLowerCase().startsWith('en') ? 'en' : 'zh'
        } catch { ACTIVE_LOCALE = 'zh' }
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
      /** 供 scripts/test-core.mjs 直接验证的纯函数（不进运行时逻辑）。 */
      __test: { integerClips, amountClips, estimateFromUsage, pickPrice, resolveAmountOf, PACKS },
    }
  },
})

