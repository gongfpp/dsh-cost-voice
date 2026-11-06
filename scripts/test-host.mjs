// 宿主半单测：费用 found 语义、价格换算、用量累加与异步 feed 快照。
// 用法：node scripts/test-host.mjs
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const host = await import(pathToFileURL(join(root, 'index.js')).href)
const { normalizeCost, normalizeCatalog, addUsage, emptyUsage } = host

let passed = 0
const check = (name, fn) => { fn(); passed += 1; console.log(`  ok  ${name}`) }

console.log('费用归一')
check('数字直接采信', () => assert.deepEqual(normalizeCost(2.5), { amount: 2.5, found: true }))
check('cost-meter 未定价（found:false, cost:0）不算 0 元', () => {
  assert.deepEqual(normalizeCost({ found: false, cost: 0, apiCost: 0, rows: [], calls: [] }), { amount: null, found: false })
})
check('cost-meter 正常结果', () => {
  assert.deepEqual(normalizeCost({ found: true, cost: 1.234, apiCost: 0.171 }), { amount: 1.234, found: true })
})
check('免费/套餐轮次 found:true cost:0 仍是已知金额', () => {
  assert.deepEqual(normalizeCost({ found: true, cost: 0 }), { amount: 0, found: true })
})
check('认 costCny 字段的旧返回形状', () => {
  assert.deepEqual(normalizeCost({ costCny: 0.5 }), { amount: 0.5, found: true })
})
check('读不出数字时返回未知', () => {
  assert.deepEqual(normalizeCost(undefined), { amount: null, found: false })
  assert.deepEqual(normalizeCost({ oops: 1 }), { amount: null, found: false })
})
check('负数归零', () => assert.deepEqual(normalizeCost(-3), { amount: 0, found: true }))

console.log('价格表换算')
check('USD/百万 token 按 7.2 折成元', () => {
  const table = normalizeCatalog({ openai: { chat: { 'gpt-x': { input: 1, output: 2, cachedInput: 0.1, cacheWrite: 1.25 } } } })
  assert.deepEqual(table.openai['gpt-x'], { input: 7.2, output: 14.4, cachedInput: 0.72, cacheWrite: 9 })
})
check('已经是 CNY 时不再乘汇率', () => {
  const table = normalizeCatalog({ p: { f: { m: { input: 1, output: 2 } } } }, 'CNY')
  assert.equal(table.p.m.input, 1)
})
check('cacheMiss/cacheHit 别名可用', () => {
  const table = normalizeCatalog({ p: { f: { m: { cacheMiss: 1, output: 2, cacheHit: 0.1 } } } })
  assert.equal(table.p.m.input, 7.2)
  assert.equal(table.p.m.cachedInput, 0.72)
})
check('没有可用单价的模型被丢掉', () => {
  const table = normalizeCatalog({ p: { f: { m: { free: true } } } })
  assert.equal(table.p, undefined)
})

console.log('用量累加')
check('逐条累加多个模型调用', () => {
  const usage = emptyUsage()
  addUsage(usage, { inputTokens: 100, outputTokens: 50 })
  addUsage(usage, { inputTokens: 10, cacheReadTokens: 7, reasoningTokens: 3 })
  assert.deepEqual(usage, { inputTokens: 110, outputTokens: 50, cacheReadTokens: 7, cacheWriteTokens: 0, reasoningTokens: 3 })
})
check('忽略空值与负数', () => {
  const usage = emptyUsage()
  addUsage(usage, { inputTokens: null, outputTokens: -5 })
  addUsage(usage, undefined)
  assert.deepEqual(usage, emptyUsage())
})

// 手动推进 timeout，不依赖真实 sleep；同时验证已完成的费用等待会清理 timer。
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const checkAsync = async (name, fn) => {
  const originalSet = globalThis.setTimeout
  const originalClear = globalThis.clearTimeout
  const timers = new Map()
  let nextId = 0
  let cleared = 0
  globalThis.setTimeout = (callback, delay) => {
    assert.equal(delay, 1500)
    const id = ++nextId
    timers.set(id, callback)
    return id
  }
  globalThis.clearTimeout = (id) => { cleared += 1; timers.delete(id) }
  try {
    await fn({
      get size() { return timers.size },
      get cleared() { return cleared },
      fire() {
        assert.equal(timers.size, 1)
        const [id, callback] = timers.entries().next().value
        timers.delete(id)
        callback()
      },
    })
    assert.equal(timers.size, 0, '费用完成后不得遗留 1.5 秒 timer')
    passed += 1
    console.log(`  ok  ${name}`)
  } finally {
    globalThis.setTimeout = originalSet
    globalThis.clearTimeout = originalClear
  }
}
const makeHarness = (getTurnCost) => {
  const routes = new Map()
  let onEvent
  host.apply({
    on(name, handler) { assert.equal(name, 'session/event'); onEvent = handler },
    effect(fn) { fn() },
    get(name) { return name === 'costMeter' && getTurnCost ? { getTurnCost } : undefined },
    connection: { fetch: { register(route) { routes.set(route.path, route); return () => {} } } },
  })
  return {
    finish(sessionId, turn, model = `model-${turn}`) {
      const emit = (type, offset, data) => onEvent({ id: sessionId }, { type, seq: turn * 10 + offset, data })
      emit('turn/start', 0, { turn })
      emit('request/context', 1, { provider: 'test-provider', model })
      emit('assistant/message', 2, { turn, usage: { inputTokens: 100, outputTokens: 20 } })
      emit('turn/end', 3, { turn, reason: { kind: 'completed' } })
    },
    feed(sessionId, since = 0) {
      return routes.get('/api/cost-voice/turns').fetch(new Request(`http://x/api/cost-voice/turns?sessionId=${sessionId}&since=${since}`))
        .then((response) => response.json())
    },
  }
}

console.log('异步轮次 feed')
await checkAsync('费用延期期间跨会话和同会话新轮次均不被游标跳过', async (timers) => {
  const cost = deferred()
  const started = deferred()
  const calls = []
  const harness = makeHarness((...args) => {
    calls.push(args)
    if (args[0] === 'a' && args[1] === 10) { started.resolve(); return cost.promise }
    return { found: true, cost: 0.25 }
  })
  harness.finish('a', 1)
  const first = harness.feed('a')
  await started.promise
  assert.equal(timers.size, 1)
  harness.finish('b', 1, 'other-session')
  harness.finish('a', 2)
  cost.resolve({ found: true, cost: 1.23 })
  const body = await first
  assert.equal(body.seq, 1)
  assert.deepEqual(body.events.map((row) => row.seq), [1])
  assert.equal(body.events[0].costCny, 1.23)
  assert.equal(body.events[0].costFound, true)
  assert.deepEqual(body.models.map((row) => row.model), ['model-1'])
  assert.deepEqual(calls[0], ['a', 10, 13, 'CNY'])
  assert.equal(timers.size, 0)
  assert.equal(timers.cleared, 1)
  const next = await harness.feed('a', body.seq)
  assert.equal(next.seq, 3)
  assert.deepEqual(next.events.map((row) => [row.seq, row.sessionId, row.turn]), [[3, 'a', 2]])
  assert.deepEqual((await harness.feed('b')).events.map((row) => [row.seq, row.sessionId]), [[2, 'b']])
  assert.deepEqual((await harness.feed('a', next.seq)).events, [])
})

await checkAsync('超时保留本次记录与快照游标，延期金额仍可落地且不吞新轮次', async (timers) => {
  const cost = deferred()
  const started = deferred()
  const harness = makeHarness((sessionId, startSeq) => {
    if (sessionId === 'a' && startSeq === 10) { started.resolve(); return cost.promise }
    return { found: true, cost: 0 }
  })
  harness.finish('a', 1)
  const first = harness.feed('a')
  await started.promise
  harness.finish('b', 1)
  harness.finish('a', 2)
  timers.fire()
  const body = await first
  assert.equal(body.seq, 1)
  assert.deepEqual(body.events.map((row) => row.seq), [1])
  assert.equal(body.events[0].costCny, null)
  assert.equal(body.events[0].costFound, null)
  assert.equal(timers.cleared, 1)
  const next = await harness.feed('a', body.seq)
  assert.equal(next.seq, 3)
  assert.deepEqual(next.events.map((row) => [row.seq, row.costCny, row.costFound]), [[3, 0, true]])
  cost.resolve({ found: true, cost: 9 })
  const replay = await harness.feed('a')
  assert.equal(replay.events[0].costCny, 9)
  assert.equal(replay.events[0].costFound, true)
})

await checkAsync('空会话游标可跨过其他会话，但不会跳过其后新增的本会话事件', async () => {
  const harness = makeHarness()
  harness.finish('b', 1)
  const empty = await harness.feed('a')
  assert.equal(empty.seq, 1)
  assert.deepEqual(empty.events, [])
  harness.finish('a', 1)
  const next = await harness.feed('a', empty.seq)
  assert.equal(next.seq, 2)
  assert.deepEqual(next.events.map((row) => row.seq), [2])
  assert.equal(next.costMeter, false)
  assert.equal(next.events[0].costCny, null)
  assert.equal(next.events[0].costFound, false)
})

await checkAsync('七种模型仅保留最近六种，空闲 poll 不会使最新模型消失', async () => {
  const harness = makeHarness()
  for (let turn = 1; turn <= 6; turn += 1) harness.finish('a', turn, `m${turn}`)
  const initial = await harness.feed('a')
  assert.deepEqual(initial.models.map((row) => row.model).sort(), ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'])
  harness.finish('a', 7, 'm7')
  const seventh = await harness.feed('a', initial.seq)
  assert.equal(seventh.seq, 7)
  assert.deepEqual(seventh.events.map((row) => row.turn), [7])
  const expected = ['m7', 'm6', 'm5', 'm4', 'm3', 'm2']
  assert.deepEqual(seventh.models.map((row) => row.model), expected)
  const idle = await harness.feed('a', seventh.seq)
  assert.deepEqual(idle.events, [])
  assert.deepEqual(idle.models, seventh.models)
  // 同一模型再次使用应移动到最前，不重复占位；其他会话的模型不混入。
  harness.finish('a', 8, 'm3')
  harness.finish('b', 1, 'other-session')
  const reused = await harness.feed('a', idle.seq)
  assert.deepEqual(reused.models.map((row) => row.model), ['m3', 'm7', 'm6', 'm5', 'm4', 'm2'])
  assert.deepEqual((await harness.feed('a', reused.seq)).models, reused.models)
})

await checkAsync('六模型边界在费用延期期间仍与本次快照游标一致', async () => {
  const cost = deferred()
  const started = deferred()
  const harness = makeHarness((sessionId, startSeq) => {
    if (startSeq === 70) { started.resolve(); return cost.promise }
    return { found: true, cost: 0 }
  })
  for (let turn = 1; turn <= 7; turn += 1) harness.finish('a', turn, `m${turn}`)
  const pending = harness.feed('a')
  await started.promise
  harness.finish('a', 8, 'm8')
  cost.resolve({ found: true, cost: 1 })
  const snapshot = await pending
  assert.equal(snapshot.seq, 7)
  assert.deepEqual(snapshot.models.map((row) => row.model), ['m7', 'm6', 'm5', 'm4', 'm3', 'm2'])
  assert.deepEqual(snapshot.events.map((row) => row.turn), [1, 2, 3, 4, 5, 6, 7])
  const next = await harness.feed('a', snapshot.seq)
  assert.equal(next.seq, 8)
  assert.deepEqual(next.events.map((row) => row.turn), [8])
  assert.deepEqual(next.models.map((row) => row.model), ['m8', 'm7', 'm6', 'm5', 'm4', 'm3'])
  assert.deepEqual((await harness.feed('a', next.seq)).models, next.models)
})

for (const [name, getTurnCost, amount, found] of [
  ['同步抛错', () => { throw new Error('meter unavailable') }, null, false],
  ['异步拒绝', () => Promise.reject(new Error('meter unavailable')), null, false],
  ['未定价的 0', () => ({ found: false, cost: 0 }), null, false],
  ['已知免费', () => ({ found: true, cost: 0 }), 0, true],
  ['返回非法金额', () => ({ found: true, cost: NaN }), null, false],
  ['数字旧返回值', () => 0.0123, 0.0123, true],
]) {
  await checkAsync(`费用${name}不破坏 feed 与 found 语义`, async (timers) => {
    const harness = makeHarness(getTurnCost)
    harness.finish('a', 1)
    const body = await harness.feed('a')
    assert.equal(body.seq, 1)
    assert.equal(body.costMeter, true)
    assert.equal(body.events.length, 1)
    assert.equal(body.events[0].costCny, amount)
    assert.equal(body.events[0].costFound, found)
    assert.equal(timers.cleared, 1)
    assert.deepEqual((await harness.feed('a', body.seq)).events, [])
  })
}

console.log(`\n${passed} 项通过`)
