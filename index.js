// dsh-cost-voice 宿主半：把每轮的 token 用量与（可得的）费用汇成一条事实，供页面轮询；
// 同时按需下发音频片段。所有逻辑只读会话事件，不写会话日志。
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'cost-voice'
export const inject = ['connection']

const PACK_FILES = /^(alipay-zh|dabaifan-clone|dabaifan-amounts)\/([a-z0-9-]+)\.mp3$/
const KEEP_MS = 10 * 60_000
const USD_TO_CNY = 7.2

/** 把价格目录（USD/百万 token）折成元，并压成 provider -> model -> 单价。 */
export function normalizeCatalog(providers, currency = 'USD') {
  const factor = currency === 'CNY' ? 1 : USD_TO_CNY
  const table = {}
  for (const [provider, families] of Object.entries(providers ?? {})) {
    if (!families || typeof families !== 'object') continue
    const rows = {}
    for (const models of Object.values(families)) {
      if (!models || typeof models !== 'object') continue
      for (const [model, price] of Object.entries(models)) {
        const input = Number(price?.input ?? price?.cacheMiss)
        const output = Number(price?.output)
        if (!Number.isFinite(input) && !Number.isFinite(output)) continue
        const cachedInput = Number(price?.cachedInput ?? price?.cacheHit)
        const cacheWrite = Number(price?.cacheWrite)
        rows[model] = {
          ...(Number.isFinite(input) ? { input: Number((input * factor).toFixed(4)) } : {}),
          ...(Number.isFinite(output) ? { output: Number((output * factor).toFixed(4)) } : {}),
          ...(Number.isFinite(cachedInput) ? { cachedInput: Number((cachedInput * factor).toFixed(4)) } : {}),
          ...(Number.isFinite(cacheWrite) ? { cacheWrite: Number((cacheWrite * factor).toFixed(4)) } : {}),
        }
      }
    }
    if (Object.keys(rows).length > 0) table[provider] = rows
  }
  return table
}

const countOf = (table) => Object.values(table).reduce((sum, rows) => sum + Object.keys(rows).length, 0)

/** 找价格目录：优先 dsh-cost-meter 随包文件，其次它在运行中的服务目录，最后插件自带快照。 */
function loadPriceCatalog(root, ctx) {
  const candidates = []
  try {
    const require = createRequire(import.meta.url)
    candidates.push(join(dirname(require.resolve('dsh-cost-meter/package.json')), 'docs', 'provider-pricing.json'))
  } catch { /* 没装 cost-meter 时继续找 */ }
  for (const base of [process.env.DSH_PROFILE_DIR, join(homedir(), '.dsh', 'profiles')]) {
    if (!base) continue
    try {
      if (base.endsWith('profiles')) {
        for (const name of readdirSync(base)) candidates.push(join(base, name, 'node_modules', 'dsh-cost-meter', 'docs', 'provider-pricing.json'))
      } else {
        candidates.push(join(base, 'node_modules', 'dsh-cost-meter', 'docs', 'provider-pricing.json'))
      }
    } catch { /* 目录不可读时跳过 */ }
  }
  candidates.push(join(root, 'assets', 'pricing.json'))
  for (const file of candidates) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      const table = normalizeCatalog(raw.providers ?? raw, 'USD')
      if (countOf(table) === 0) continue
      return {
        source: file.includes('dsh-cost-meter') ? 'dsh-cost-meter' : 'bundled',
        generatedAt: typeof raw.generatedAt === 'string' ? raw.generatedAt : null,
        fx: USD_TO_CNY,
        count: countOf(table),
        providers: table,
      }
    } catch { continue }
  }
  // 文件都找不到时，直接问运行中的 cost-meter 服务（它的目录带实时价格）。
  try {
    const meter = ctx?.get?.('costMeter')
    const catalog = meter && typeof meter.getPriceCatalog === 'function' ? meter.getPriceCatalog() : null
    if (catalog && typeof catalog.then === 'function') return null
    if (catalog) {
      const table = normalizeCatalog(catalog, 'USD')
      if (countOf(table) > 0) return { source: 'dsh-cost-meter', generatedAt: null, fx: USD_TO_CNY, count: countOf(table), providers: table }
    }
  } catch { /* 服务不可用时用快照 */ }
  return { source: 'none', generatedAt: null, fx: USD_TO_CNY, count: 0, providers: {} }
}

/** 一轮内的用量累加器。 */
export function emptyUsage() {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
}

export function addUsage(target, usage) {
  for (const field of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) {
    const value = Number(usage?.[field])
    if (Number.isFinite(value) && value > 0) target[field] += value
  }
}

/**
 * 把 costMeter.getTurnCost 的返回值折成 { amount, found }。
 * cost-meter 对「没有计费记录 / 未定价」的轮次返回 found:false、cost:0——这种 0 不是真花了 0 元，
 * 必须让页面回落到按单价估算，否则会播成 0.01 元。
 */
export function normalizeCost(value) {
  const candidate = typeof value === 'number'
    ? value
    : value?.costCny ?? value?.cost ?? value?.value ?? value?.amount
  const amount = typeof candidate === 'number' && Number.isFinite(candidate) ? Math.max(0, candidate) : null
  const found = amount !== null && value?.found !== false
  return { amount: found ? amount : null, found }
}

export function apply(ctx, config = {}) {
  const root = dirname(fileURLToPath(import.meta.url))
  let pricing = loadPriceCatalog(root, ctx)
  let pricingAt = Date.now()
  const events = []
  const clipCache = new Map()
  const turns = new Map()
  const pendingCost = new Map()
  let seq = 0

  /** 价格表长时间运行时定期重读，cost-meter 升级后不必重启 dsh web。 */
  const refreshPricing = (maxAgeMs = 30 * 60_000) => {
    if (Date.now() - pricingAt < maxAgeMs) return
    pricing = loadPriceCatalog(root, ctx)
    pricingAt = Date.now()
  }

  const remember = (record) => {
    events.push(record)
    if (events.length > 200) events.splice(0, events.length - 200)
  }

  /**
   * 有 cost-meter 时用它的每轮费用，否则留空由页面按单价估算。
   * 返回的 Promise 挂在 pendingCost 上：轮询接口会等它落地，避免页面先看到 costCny=null 就急着用估算播报。
   */
  const resolveCost = (sessionId, startSeq, endSeq, record) => {
    const meter = ctx.get('costMeter')
    if (!meter || typeof meter.getTurnCost !== 'function') {
      record.costFound = false
      return Promise.resolve()
    }
    const task = Promise.resolve()
      .then(() => meter.getTurnCost(sessionId, startSeq, endSeq, 'CNY'))
      .then((value) => {
        const { amount, found } = normalizeCost(value)
        record.costCny = amount
        record.costFound = found
      })
      .catch(() => { /* 计费插件不可用时保持 null，页面用单价估算 */ record.costFound = false })
      .finally(() => { pendingCost.delete(record.seq) })
    pendingCost.set(record.seq, task)
    return task
  }


  ctx.on('session/event', (session, event) => {
    const sessionId = session?.id
    if (!sessionId) return
    const data = event?.data ?? {}
    if (event.type === 'turn/start') {
      turns.set(sessionId, {
        turn: data.turn,
        startSeq: event.seq,
        usage: emptyUsage(),
        provider: '',
        model: '',
      })
      return
    }
    if (event.type === 'request/context') {
      const state = turns.get(sessionId)
      if (state) {
        state.provider = data.provider ?? state.provider
        state.model = data.model ?? state.model
      }
      return
    }
    if (event.type === 'assistant/message') {
      const state = turns.get(sessionId)
      if (!state || data.turn !== state.turn) return
      addUsage(state.usage, data.usage)
      const source = data.message?.source
      if (source?.provider) state.provider = source.provider
      if (source?.model) state.model = source.model
      return
    }
    if (event.type !== 'turn/end') return
    const state = turns.get(sessionId)
    if (!state || data.turn !== state.turn) return
    turns.delete(sessionId)
    const record = {
      seq: ++seq,
      sessionId,
      turn: data.turn,
      kind: data.reason?.kind ?? 'unknown',
      usage: state.usage,
      provider: state.provider,
      model: state.model,
      costCny: null,
      costFound: null,
      time: Date.now(),
    }
    remember(record)
    void resolveCost(sessionId, state.startSeq, event.seq, record)
  }, { global: true })

  // 页面轮询：增量返回本次会话的轮次事实。
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/cost-voice/turns',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      refreshPricing()
      const url = new URL(request.url)
      const sessionId = url.searchParams.get('sessionId') ?? ''
      const since = Number(url.searchParams.get('since') ?? 0)
      const now = Date.now()
      // 游标与记录来自同一次同步快照；等待费用期间新增的轮次留给下一次轮询。
      // seq 是所有会话共享的，不能在 await 后读取，否则会跳过尚未选入 fresh 的记录。
      const snapshotSeq = seq
      const snapshot = events.slice()
      const fresh = snapshot.filter((record) => record.sessionId === sessionId
        && record.seq > (Number.isSafeInteger(since) ? since : 0)
        && now - record.time < KEEP_MS)
      // 刚结束的轮次可能还在等 cost-meter 算钱：等它们落地再返回（最多 1.5 秒），
      // 这样页面拿到的是最终金额，而不是「先播估算、之后不纠正」。
      const waiting = fresh.map((record) => pendingCost.get(record.seq)).filter(Boolean)
      if (waiting.length > 0) {
        let timer
        try {
          await Promise.race([
            Promise.allSettled(waiting),
            new Promise((resolve) => { timer = setTimeout(resolve, 1500) }),
          ])
        } finally {
          clearTimeout(timer)
        }
      }

      const models = []
      // 最近使用的模型优先，重复模型仅占一项；空闲轮询也保持这六项，不退回最早六种。
      for (let index = snapshot.length - 1; index >= 0 && models.length < 6; index -= 1) {
        const record = snapshot[index]
        if (record.sessionId !== sessionId || !record.provider || !record.model) continue
        const key = `${record.provider}/${record.model}`
        if (!models.some((entry) => entry.key === key)) models.push({ key, provider: record.provider, model: record.model })
      }
      // 内存里没有该会话的轮次时，从会话日志里回溯最近用过的模型。
      if (models.length === 0) {
        try {
          const session = ctx.get('agents')?.get?.(sessionId)?.session
          const history = session?.snapshotEvents?.() ?? []
          for (let index = history.length - 1; index >= 0 && models.length < 6; index -= 1) {
            const entry = history[index]
            const source = entry?.type === 'assistant/message' ? entry.data?.message?.source : null
            const provider = source?.provider ?? entry?.data?.provider
            const model = source?.model ?? entry?.data?.model
            if (!provider || !model) continue
            const key = `${provider}/${model}`
            if (!models.some((item) => item.key === key)) models.push({ key, provider, model })
          }
        } catch { /* 会话不可读时只返回内存里已有的模型 */ }
      }
      return Response.json({
        costMeter: Boolean(ctx.get('costMeter')),
        seq: snapshotSeq,
        models: models.slice(0, 6),
        events: fresh,
      }, { headers: { 'cache-control': 'no-store' } })
    },
  }), 'cost-voice: turn feed')

  // 按模型的价格目录（元/百万 token），来自 dsh-cost-meter 的随包价格表。
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/cost-voice/pricing',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => {
      refreshPricing(5 * 60_000)
      return Response.json(pricing, { headers: { 'cache-control': 'no-store' } })
    },
  }), 'cost-voice: pricing')

  // 音频片段：按需读包内文件，命中后缓存在内存。
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/cost-voice/clip',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const url = new URL(request.url)
      const file = url.searchParams.get('name') ?? ''
      if (!PACK_FILES.test(file)) return new Response('unknown clip', { status: 404 })
      const path = join(root, 'assets', 'voices', file)
      const mtimeMs = statSync(path).mtimeMs
      let cached = clipCache.get(file)
      if (!cached || cached.mtimeMs !== mtimeMs) {
        cached = { mtimeMs, buffer: readFileSync(path) }
        clipCache.set(file, cached)
      }
      return new Response(cached.buffer, {
        status: 200,
        headers: { 'content-type': 'audio/mpeg', 'cache-control': 'private, max-age=3600' },
      })
    },
  }), 'cost-voice: clip route')
}






