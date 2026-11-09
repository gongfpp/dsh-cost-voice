// 客户端行为回归：运行真实插件及设置页，模拟请求、浏览器音频与时钟，不需浏览器或真实等待。
// 用法：node scripts/test-client.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(setImmediate) }
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const record = (turn, costCny = 0.12, sessionId = 's') => ({ sessionId, turn, kind: 'completed', costCny, costFound: true, usage: {} })
const model = (name) => ({ key: `p/${name}`, provider: 'p', model: name })
const elements = (node) => node && typeof node === 'object'
  ? [node, ...(node.children ?? []).flat(Infinity).flatMap(elements)] : []

function harness(options = {}) {
  let definition, poll, now = 0, timerId = 0
  const timers = new Map(), registrations = [], cleanups = [], requests = [], contexts = []
  const storage = options.storage ?? new Map()
  if (options.config) storage.set('dsh-cost-voice.config.v1', JSON.stringify(options.config))
  const state = { feed: { seq: 0, events: [], models: [] }, clipFailure: false, blocked: false, gesture: false, resumes: [], requests, contexts, storage, timers }
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (initial) => [initial, () => {}], useEffect() {}, useRef: () => ({ current: null }),
    useCallback: (fn) => fn, useSyncExternalStore: (_, snapshot) => snapshot(),
  }
  class AudioContext {
    state = options.suspended ? 'suspended' : 'running'
    destination = {}
    sources = []
    constructor() { contexts.push(this) }
    get currentTime() { return now / 1000 }
    resume() {
      state.resumes.push(state.gesture)
      if (state.blocked) return new Promise(() => {})
      this.state = 'running'
      return Promise.resolve()
    }
    decodeAudioData() { return Promise.resolve({ duration: 0.01 }) }
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} } }
    createBufferSource() {
      const src = { connect() {}, disconnect() {}, start() { src.started = true }, stop() { src.stopped = true } }
      this.sources.push(src)
      return src
    }
    close() { this.state = 'closed'; return Promise.resolve() }
  }
  const sandbox = {
    window: { __ModuleLoader__: { load: (value) => { definition = value } }, ...(options.unsupported ? {} : { AudioContext }) },
    document: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} },
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    fetch: async (url) => {
      requests.push(String(url))
      if (url.includes('/turns')) return { ok: true, json: async () => state.onFeed ? state.onFeed(String(url)) : state.feed }
      if (url.includes('/pricing')) return { ok: true, json: async () => ({ providers: { p: { a: { input: 2, output: 3 } } } }) }
      if (state.clipFailure || (state.wholeMissing && url.includes('dabaifan-amounts'))) return { ok: false, status: 503 }
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(1) }
    },
    URLSearchParams, console,
    setInterval: (fn) => { poll = fn; return -1 }, clearInterval() {},
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, at: now + ms }); return id },
    clearTimeout: (id) => timers.delete(id),
  }
  vm.runInNewContext(source, sandbox, { filename: 'client.js' })
  definition.factory(() => react).apply({
    get: () => ({ getSnapshot: () => ({ active: options.locale ?? 'zh' }) }),
    effect: (fn) => cleanups.push(fn()),
    slots: { inject: (_, fn) => fn(), register: (spec, component) => registrations.push({ spec, component }) },
  })
  const controller = registrations.find((x) => x.spec.name === 'shell.overlay').component({}).props.controller
  const render = () => {
    const element = registrations.find((x) => x.spec.name === 'plugins.bundle.config').component({ view: 'page' })
    return element.type(element.props)
  }
  const advance = async (ms) => {
    const until = now + ms
    while (true) {
      await flush()
      const next = [...timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
      if (!next) break
      now = next[1].at
      timers.delete(next[0]); next[1].fn()
    }
    now = until
    await flush()
  }
  return {
    ...state, state, controller, render, poll: () => poll(), advance,
    async start(seq = 1, sessionId = 's') { state.feed = { seq, events: [], models: [] }; controller.selectSession(sessionId); await flush() },
    async turn(turn, amount = 0.12, extra = {}) { state.feed = { seq: turn, events: [record(turn, amount)], models: [], ...extra }; await poll(); await flush() },
    gesture(fn) { state.gesture = true; try { fn() } finally { state.gesture = false } },
    dispose() { for (const fn of cleanups) fn?.() },
  }
}

let passed = 0
async function check(name, run) { await run(); passed++; console.log(`  ok  ${name}`) }

await check('新安装默认大白饭，范围内金额播放内置整句', async () => {
  const h = harness(); await h.start(0); await h.turn(1, 0.31); await h.advance(1000)
  assert.equal(h.controller.getSnapshot().config.voice, 'dabaifan')
  assert.ok(h.requests.some((url) => url.includes('dabaifan-amounts%2F31.mp3')))
  assert.ok(!h.requests.some((url) => url.includes('alipay-zh')))
  assert.equal(h.controller.getSnapshot().log[0].pack, 'dabaifan'); h.dispose()
})
await check('升级保留用户已有支付宝音色选择', async () => {
  const h = harness({ config: { voice: 'alipay' } }); await h.start(0); await h.turn(1, 0.31); await h.advance(1000)
  assert.equal(h.controller.getSnapshot().config.voice, 'alipay')
  assert.ok(h.requests.some((url) => url.includes('alipay-zh')))
  assert.ok(!h.requests.some((url) => url.includes('dabaifan-amounts'))); h.dispose()
})

await check('首次基线为 0 后，第一轮新完成仍会播报', async () => {
  const h = harness(); await h.start(0); await h.turn(1); await h.advance(1000)
  assert.equal(h.controller.getSnapshot().log.length, 1)
  assert.equal(h.controller.getSnapshot().log[0].state, 'played'); h.dispose()
})
await check('首次进入不补播历史，后续新轮次才播', async () => {
  const h = harness(); h.state.feed = { seq: 5, events: [record(5)], models: [] }; h.controller.selectSession('s'); await flush()
  assert.equal(h.controller.getSnapshot().log.length, 0)
  await h.turn(6); await h.advance(1000); assert.equal(h.controller.getSnapshot().log.length, 1); h.dispose()
})
await check('刷新后同一轮不重复播报', async () => {
  const h = harness(); await h.start(1); await h.turn(2); await h.advance(1000); h.dispose()
  const next = harness({ storage: h.storage }); await next.start(1); await next.turn(2)
  assert.equal(next.controller.getSnapshot().log.length, 1); assert.equal(next.contexts.length, 0); next.dispose()
})
await check('刷新或重新启用后将瞬态记录标为中断，可手动重试且不自动重播', async () => {
  const h = harness(); await h.start(); await h.turn(2); await h.turn(3)
  assert.equal(h.controller.getSnapshot().log.find((x) => x.turn === 2).state, 'playing')
  assert.equal(h.controller.getSnapshot().log.find((x) => x.turn === 3).state, 'queued')
  h.dispose()
  const next = harness({ storage: h.storage }); await next.start(3); await next.advance(10000)
  assert.equal(next.contexts.length, 0)
  assert.ok(next.controller.getSnapshot().log.every((x) => x.state === 'failed' && /中断/.test(x.error)))
  assert.equal(elements(next.render()).filter((x) => x.type === 'button' && x.children.includes('重试')).length, 2)
  next.gesture(() => next.controller.retry('s:2')); await next.advance(1000)
  next.gesture(() => next.controller.retry('s:3')); await next.advance(1000)
  assert.equal(next.controller.getSnapshot().log.length, 2)
  assert.ok(next.controller.getSnapshot().log.every((x) => x.state === 'played')); next.dispose()
})
await check('英文中断记录恢复原因保持英文', async () => {
  const storage = new Map([['dsh-cost-voice.log.v1', JSON.stringify([{ id: 's:2', state: 'queued', pack: 'alipay', amount: 0.12 }])]])
  const h = harness({ storage, locale: 'en' })
  assert.equal(h.controller.getSnapshot().log[0].state, 'failed')
  assert.match(h.controller.getSnapshot().log[0].error, /interrupted/)
  assert.ok(elements(h.render()).some((x) => x.type === 'button' && x.children.includes('Retry'))); h.dispose()
})
await check('宿主游标归零后可以重新接收后续轮次', async () => {
  const h = harness(); await h.start(9); h.state.feed = { seq: 0, events: [], models: [] }; await h.poll()
  await h.turn(1); await h.advance(1000); assert.equal(h.controller.getSnapshot().log[0].turn, 1); h.dispose()
})
await check('切换会话时丢弃旧请求，自动为新会话重新建基线', async () => {
  const h = harness(); const pending = deferred(); let first = true
  h.state.onFeed = (url) => {
    if (first) { first = false; return pending.promise }
    assert.ok(url.includes('sessionId=new')); assert.ok(url.includes('since=0'))
    return { seq: 7, events: [], models: [model('new')] }
  }
  h.controller.selectSession('old'); h.controller.selectSession('new')
  pending.resolve({ seq: 100, costMeter: true, events: [record(100, 1, 'old')], models: [model('old')] }); await flush()
  assert.equal(h.controller.getSnapshot().models[0].model, 'new')
  assert.equal(h.controller.getSnapshot().log.length, 0); h.dispose()
})
await check('同样数量的模型发生切换时更新价格列表', async () => {
  const h = harness(); await h.start(); h.state.feed.models = [model('a')]; await h.poll()
  h.state.feed.models = [model('b')]; await h.poll(); assert.equal(h.controller.getSnapshot().models[0].key, 'p/b'); h.dispose()
})
await check('初始或同批七模型事件不挤回宿主已排除的旧模型，空闲轮询列表稳定', async () => {
  const events = Array.from({ length: 7 }, (_, i) => ({ ...record(i + 1), provider: 'p', model: `m${i + 1}` }))
  const models = ['m7', 'm6', 'm5', 'm4', 'm3', 'm2'].map(model)
  for (const baseline of [true, false]) {
    const h = harness()
    if (!baseline) await h.start(0)
    h.state.feed = { seq: 7, events, models }
    if (baseline) h.controller.selectSession('s')
    else await h.poll()
    await flush()
    assert.equal(h.controller.getSnapshot().models.map((x) => x.model).join(','), 'm7,m6,m5,m4,m3,m2')
    h.state.feed = { seq: 7, events: [], models }; await h.poll()
    assert.equal(h.controller.getSnapshot().models.map((x) => x.model).join(','), 'm7,m6,m5,m4,m3,m2'); h.dispose()
  }
})
await check('旧版宿主未提供模型列表时仍从轮次中补出模型', async () => {
  const h = harness(); await h.start(0)
  h.state.feed = { seq: 1, events: [{ ...record(1), provider: 'p', model: 'legacy' }] }; await h.poll()
  assert.equal(h.controller.getSnapshot().models[0].model, 'legacy'); h.dispose()
})
await check('清空单价恢复目录值，保留其他覆盖；显式 0 仍可设置', async () => {
  const h = harness({ config: { modelPrices: { 'p/a': { input: 5, output: 8 } } } }); await h.start()
  h.state.feed.models = [model('a')]; await h.poll()
  elements(h.render()).find((x) => x.type === 'input' && x.props.value === 5).props.onChange({ target: { value: '' } })
  assert.equal(h.controller.getSnapshot().config.modelPrices['p/a'].input, undefined)
  elements(h.render()).find((x) => x.type === 'input' && x.props.value === 8).props.onChange({ target: { value: '0' } })
  assert.equal(h.controller.getSnapshot().config.modelPrices['p/a'].output, 0)
  elements(h.render()).find((x) => x.type === 'input' && x.props.value === 0 && x.props.placeholder === '3').props.onChange({ target: { value: '' } })
  assert.equal(h.controller.getSnapshot().config.modelPrices['p/a'], undefined); h.dispose()
})
await check('明确免费播零元，且音频不包含小数点', async () => {
  const h = harness(); await h.start(); await h.turn(2, 0); await h.advance(1000)
  assert.equal(h.controller.getSnapshot().log[0].amount, 0)
  assert.ok(!h.requests.some((url) => url.includes('dot.mp3'))); h.dispose()
})
await check('正数不足一分仍播 0.01 元，门槛按未取整金额判断', async () => {
  const h = harness(); await h.start(); await h.turn(2, 0.001); await h.advance(1000)
  assert.equal(h.controller.getSnapshot().log[0].amount, 0.01)
  h.controller.update({ minAmount: 0.01 }); await h.turn(3, 0.009)
  assert.equal(h.controller.getSnapshot().log.length, 1); h.dispose()
})
await check('音频下载失败有失败记录、原因和可点击的重试按钮', async () => {
  const h = harness(); await h.start(); h.state.clipFailure = true; await h.turn(2); await flush()
  let snapshot = h.controller.getSnapshot()
  assert.equal(snapshot.log[0].state, 'failed'); assert.match(snapshot.status.audioError, /503/)
  assert.ok(elements(h.render()).some((x) => x.props.role === 'alert'))
  const retry = elements(h.render()).find((x) => x.type === 'button' && x.children.includes('重试'))
  assert.ok(retry); h.state.clipFailure = false; h.gesture(() => retry.props.onClick()); await h.advance(1000)
  snapshot = h.controller.getSnapshot(); assert.equal(snapshot.log.length, 1); assert.equal(snapshot.log[0].state, 'played'); assert.equal(snapshot.status.audioError, ''); h.dispose()
})
await check('浏览器不支持音频时不能记作播放成功', async () => {
  const h = harness({ unsupported: true }); await h.start(); await h.turn(2)
  assert.equal(h.controller.getSnapshot().log[0].state, 'failed'); assert.match(h.controller.getSnapshot().status.audioError, /不支持/); h.dispose()
})
await check('试听在点击手势内解锁音频，不等下载才 resume', async () => {
  const h = harness({ suspended: true }); h.gesture(() => h.controller.preview())
  assert.equal(h.state.resumes[0], true); await h.advance(1000); h.dispose()
})
await check('播放被浏览器阻止不会永久卡住队列，解锁后可重试', async () => {
  const h = harness({ suspended: true }); await h.start(); h.state.blocked = true; await h.turn(2); await h.advance(1600)
  assert.equal(h.controller.getSnapshot().log[0].state, 'failed'); assert.match(h.controller.getSnapshot().status.audioError, /试听/)
  assert.equal(h.controller.getSnapshot().status.playing, false)
  h.state.blocked = false; h.gesture(() => h.controller.retry('s:2')); await h.advance(1000)
  assert.equal(h.controller.getSnapshot().log[0].state, 'played'); h.dispose()
})
await check('队列上限内顺序播放，溢出项标明未播放且可以重试', async () => {
  const h = harness(); await h.start()
  for (let turn = 2; turn <= 7; turn++) await h.turn(turn)
  assert.equal(h.controller.getSnapshot().log.find((x) => x.turn === 3).state, 'skipped')
  await h.advance(10000)
  assert.equal(h.controller.getSnapshot().log.filter((x) => x.state === 'played').length, 5)
  h.gesture(() => h.controller.retry('s:3')); await h.advance(1000)
  assert.equal(h.controller.getSnapshot().log.filter((x) => x.state === 'played').length, 6); h.dispose()
})
await check('大白饭整句缺失时可以回落拼接；零元不请求不存在的整句', async () => {
  const h = harness({ config: { voice: 'dabaifan' } }); await h.start(); await h.turn(2, 0); await h.advance(1000)
  assert.ok(h.requests.some((x) => x.includes('dabaifan-clone')))
  assert.ok(!h.requests.some((x) => x.includes('dabaifan-amounts')))
  h.state.wholeMissing = true; await h.turn(3, 0.12); await h.advance(1000)
  assert.ok(h.requests.some((x) => x.includes('dabaifan-amounts')))
  assert.equal(h.controller.getSnapshot().log[0].state, 'played'); h.dispose()
})
await check('停止插件后清空排队并关闭音频，迟到响应不再启动播放', async () => {
  const h = harness(); await h.start(); await h.turn(2); await h.turn(3); h.dispose(); await h.advance(1000)
  assert.equal(h.contexts[0].state, 'closed'); assert.ok(h.contexts[0].sources.every((x) => x.stopped))
  assert.equal(h.contexts.length, 1)
  const pending = deferred(), late = harness(); late.state.onFeed = () => pending.promise; late.controller.selectSession('s'); late.dispose()
  pending.resolve({ seq: 1, models: [model('late')], events: [record(1)] }); await flush()
  assert.equal(late.controller.getSnapshot().models.length, 0); assert.equal(late.contexts.length, 0)
})
await check('英文页面的失败及重试反馈保持英文', async () => {
  const h = harness({ locale: 'en' }); await h.start(); h.state.clipFailure = true; await h.turn(2)
  assert.match(h.controller.getSnapshot().status.audioError, /Could not load audio/)
  assert.ok(elements(h.render()).some((x) => x.type === 'button' && x.children.includes('Retry'))); h.dispose()
})
console.log(`\n${passed} 项客户端行为回归通过`)
