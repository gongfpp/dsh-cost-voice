// 客户端半纯函数单测：数字读法、金额取源、费用估算。不需要浏览器，也不碰音频。
// 用法：node scripts/test-core.mjs
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let definition = null

globalThis.window = { __ModuleLoader__: { load: (value) => { definition = value } } }
globalThis.document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} }
globalThis.localStorage = { getItem: () => null, setItem() {} }
globalThis.fetch = async () => ({ ok: true, json: async () => ({}) })

await import(pathToFileURL(join(root, 'client.js')).href)
const plugin = definition.factory(() => ({ createElement: () => null, useState: () => [null, () => {}], useEffect() {}, useRef: () => ({ current: null }), useCallback: (fn) => fn, useSyncExternalStore: (s, g) => g() }))
const { integerClips, amountClips, estimateFromUsage, pickPrice, resolveAmountOf } = plugin.__test

let passed = 0
const check = (name, fn) => { fn(); passed += 1; console.log(`  ok  ${name}`) }

console.log('数字读法')
check('0 -> 0', () => assert.deepEqual(integerClips(0), ['0']))
check('1 -> 一', () => assert.deepEqual(integerClips(1), ['1']))
check('10 -> 十', () => assert.deepEqual(integerClips(10), ['ten']))
check('11 -> 十一', () => assert.deepEqual(integerClips(11), ['ten', '1']))
check('20 -> 二十', () => assert.deepEqual(integerClips(20), ['2', 'ten']))
check('101 -> 一百零一', () => assert.deepEqual(integerClips(101), ['1', 'hundred', '0', '1']))
check('110 -> 一百一十', () => assert.deepEqual(integerClips(110), ['1', 'hundred', '1', 'ten']))
check('1001 -> 一千零一', () => assert.deepEqual(integerClips(1001), ['1', 'thousand', '0', '1']))
check('1234', () => assert.deepEqual(integerClips(1234), ['1', 'thousand', '2', 'hundred', '3', 'ten', '4']))
check('9999', () => assert.deepEqual(integerClips(9999), ['9', 'thousand', '9', 'hundred', '9', 'ten', '9']))
check('10000 -> 一万', () => assert.deepEqual(integerClips(10000), ['1', 'ten-thousand']))
check('10001 -> 一万零一', () => assert.deepEqual(integerClips(10001), ['1', 'ten-thousand', '0', '1']))
check('11000 -> 一万一千', () => assert.deepEqual(integerClips(11000), ['1', 'ten-thousand', '1', 'thousand']))
check('12345 -> 一万二千三百四十五', () => assert.deepEqual(integerClips(12345), ['1', 'ten-thousand', '2', 'thousand', '3', 'hundred', '4', 'ten', '5']))

console.log('金额读法')
check('0 -> 零点零一元', () => assert.deepEqual(amountClips(0), ['0', 'dot', '0', '1', 'yuan']))
check('0.12 -> 零点一二元', () => assert.deepEqual(amountClips(0.12), ['0', 'dot', '1', '2', 'yuan']))
check('1.5 -> 一点五元', () => assert.deepEqual(amountClips(1.5), ['1', 'dot', '5', 'yuan']))
check('12 -> 十二元', () => assert.deepEqual(amountClips(12), ['ten', '2', 'yuan']))
check('100.05 -> 一百点零五元', () => assert.deepEqual(amountClips(100.05), ['1', 'hundred', 'dot', '0', '5', 'yuan']))
check('0.014 四舍五入下限', () => assert.deepEqual(amountClips(0.014), ['0', 'dot', '0', '1', 'yuan']))

console.log('费用估算')
check('输入 1 元/百万 + 输出 2 元/百万', () => {
  const use = { inputTokens: 1_000_000, outputTokens: 1_000_000 }
  assert.equal(estimateFromUsage(use, { input: 1, output: 2, cachedInput: 0.1, cacheWrite: 1.25 }).toFixed(6), '3.000000')
})
check('推理 token 已含在 output 里，不再重复计', () => {
  const use = { inputTokens: 0, outputTokens: 1_000_000, reasoningTokens: 1_000_000 }
  assert.equal(estimateFromUsage(use, { input: 1, output: 2 }).toFixed(6), '2.000000')
})
check('缓存读按缓存价', () => {
  const use = { cacheReadTokens: 1_000_000 }
  assert.equal(estimateFromUsage(use, { input: 1, output: 2, cachedInput: 0.1 }).toFixed(6), '0.100000')
})

console.log('单价选择')
const config = { inputPrice: 3, outputPrice: 6, modelPrices: { 'p/m': { output: 9 } } }
check('用户覆写 > 价格表 > 兜底', () => {
  const pricing = { providers: { p: { m: { input: 1, output: 2 } } } }
  const price = pickPrice({ config, pricing, record: { provider: 'p', model: 'm' } })
  assert.equal(price.input, 1)
  assert.equal(price.output, 9)
})
check('没有价格表时用兜底单价', () => {
  const price = pickPrice({ config, pricing: null, record: { provider: 'x', model: 'y' } })
  assert.equal(price.input, 3)
  assert.equal(price.output, 6)
  assert.equal(price.cachedInput.toFixed(4), '0.3000')
  assert.equal(price.cacheWrite.toFixed(4), '3.7500')
})

console.log('金额取源')
const pricing = { providers: { p: { m: { input: 1, output: 2 } } } }
const base = { sessionId: 's', turn: 1, provider: 'p', model: 'm', usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 } }
check('费用插件算过就用它', () => {
  const got = resolveAmountOf({ config: { basis: 'auto' }, pricing, record: { ...base, costCny: 1.23, costFound: true } })
  assert.deepEqual(got, { amount: 1.23, source: 'cost-meter' })
})
check('费用插件说没算过（found:false, cost:0）就回落到估算', () => {
  const got = resolveAmountOf({ config: { basis: 'auto' }, pricing, record: { ...base, costCny: null, costFound: false } })
  assert.equal(got.source, 'estimate')
  assert.equal(got.amount.toFixed(6), '3.000000')
})
check('旧版宿主只给 0 元时也回落估算', () => {
  const got = resolveAmountOf({ config: { basis: 'auto' }, pricing, record: { ...base, costCny: 0 } })
  assert.equal(got.source, 'estimate')
})
check('旧版宿主给正数金额就采信', () => {
  const got = resolveAmountOf({ config: { basis: 'auto' }, pricing, record: { ...base, costCny: 0.42 } })
  assert.deepEqual(got, { amount: 0.42, source: 'cost-meter' })
})
check('选了按单价估算就不读费用插件', () => {
  const got = resolveAmountOf({ config: { basis: 'tokens' }, pricing, record: { ...base, costCny: 9, costFound: true } })
  assert.equal(got.source, 'estimate')
})

console.log(`\n${passed} 项通过`)
