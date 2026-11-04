// 离线冒烟：用假的 ctx 跑一遍宿主半，验证事件折叠、轮次事实接口与片段路由。
// 用法：node scripts/smoke-host.mjs
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const routes = new Map()
const handlers = new Map()

const ctx = {
  on(name, handler) { handlers.set(name, handler) },
  effect(fn) { return fn() },
  get(name) {
    if (name === 'costMeter') return { getTurnCost: async () => 0.0123 }
    if (name === 'agents') return {
      get: (id) => id === 's2' ? { session: { snapshotEvents: () => ([{ type: 'assistant/message', data: { message: { source: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' } } } }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }]) } } : undefined,
    }
    return undefined
  },
  connection: {
    fetch: {
      register(route) { routes.set(route.path, route); return () => routes.delete(route.path) },
    },
  },
}

const { apply } = await import(pathToFileURL(join(root, 'index.js')).href)
apply(ctx, {})

const emit = (sessionId, event) => {
  const session = { id: sessionId }
  handlers.get('session/event')(session, event)
}

emit('s1', { type: 'turn/start', seq: 10, data: { turn: 1 } })
emit('s1', { type: 'request/context', seq: 11, data: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' } })
emit('s1', {
  type: 'assistant/message', seq: 12,
  data: { turn: 1, step: 1, message: { source: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' } }, usage: { inputTokens: 1200, outputTokens: 340, cacheReadTokens: 800 } },
})
emit('s1', { type: 'turn/end', seq: 13, data: { turn: 1, reason: { kind: 'completed' } } })
await new Promise((resolve) => setTimeout(resolve, 30))

const feed = await routes.get('/api/cost-voice/turns').fetch(new Request('http://x/api/cost-voice/turns?sessionId=s1&since=0'))
const feedBody = await feed.json()
const record = feedBody.events?.[0]
const checks = {
  feedStatus: feed.status,
  hasEvent: Boolean(record),
  turn: record?.turn,
  kind: record?.kind,
  usage: record?.usage,
  costCny: record?.costCny,
  provider: record?.provider,
  costMeterFlag: feedBody.costMeter,
}

const goodClip = await routes.get('/api/cost-voice/clip').fetch(new Request('http://x/api/cost-voice/clip?name=alipay-zh/prefix-account.mp3'))
checks.clipStatus = goodClip.status
checks.clipType = goodClip.headers.get('content-type')
checks.clipBytes = (await goodClip.arrayBuffer()).byteLength
const badClip = await routes.get('/api/cost-voice/clip').fetch(new Request('http://x/api/cost-voice/clip?name=../index.js'))
checks.badClipStatus = badClip.status
const amountClip = await routes.get('/api/cost-voice/clip').fetch(new Request('http://x/api/cost-voice/clip?name=dabaifan-amounts/12.mp3'))
checks.amountClipStatus = amountClip.status
checks.amountClipBytes = (await amountClip.arrayBuffer()).byteLength

const historyFeed = await routes.get('/api/cost-voice/turns').fetch(new Request('http://x/api/cost-voice/turns?sessionId=s2&since=0'))
const historyBody = await historyFeed.json()
checks.historyModels = historyBody.models
if (!Array.isArray(historyBody.models) || historyBody.models[0]?.model !== 'deepseek-v4.1-flash') failHistory = true

const pricingResponse = await routes.get('/api/cost-voice/pricing').fetch(new Request('http://x/api/cost-voice/pricing'))
const pricing = await pricingResponse.json()
const deepseek = pricing.providers?.['opencode-go']?.['deepseek-v4.1-flash']
checks.pricingStatus = pricingResponse.status
checks.pricingSource = pricing.source
checks.pricingCount = pricing.count
checks.deepseekPrice = deepseek

let failHistory = false
const fail = []
if (checks.feedStatus !== 200) fail.push('feed status')
if (!checks.hasEvent || checks.turn !== 1 || checks.kind !== 'completed') fail.push('turn record')
if (checks.usage?.inputTokens !== 1200 || checks.usage?.outputTokens !== 340) fail.push('usage sum')
if (checks.costCny !== 0.0123) fail.push('cost from costMeter')
if (checks.costMeterFlag !== true) fail.push('costMeter flag')
if (checks.clipStatus !== 200 || checks.clipBytes < 1000) fail.push('clip route')
if (checks.badClipStatus !== 404) fail.push('clip guard')
if (checks.amountClipStatus !== 200 || !(checks.amountClipBytes > 1000)) fail.push('amount clip')
if (checks.pricingStatus !== 200 || !(checks.pricingCount > 0)) fail.push('pricing catalog')
if (!deepseek || !(deepseek.input > 0) || !(deepseek.output > 0)) fail.push('per-model price')
if (failHistory) fail.push('models from session history')

console.log(JSON.stringify({ checks, pass: fail.length === 0, fail }, null, 2))
process.exit(fail.length === 0 ? 0 : 1)



