// 宿主半单测：费用归一的 found 语义、价格表换算、用量累加。
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

console.log(`\n${passed} 项通过`)
