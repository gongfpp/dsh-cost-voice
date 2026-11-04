// 预渲染常用金额整句：避免数字拼接造成的音色/断句不统一。
// 用法：MIMO_API_KEY=... node scripts/render-amounts.mjs <输出目录> <声线参考音频> [最低分] [最高分]
// 生成 0.01–1.00 元共 100 句：<分>.mp3，文本如「大白饭到账，零点一二元」。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [outDir, refArg, minArg, maxArg] = process.argv.slice(2)
const apiKey = process.env.MIMO_API_KEY
if (!outDir || !refArg || !apiKey) {
  console.error('用法：MIMO_API_KEY=... node scripts/render-amounts.mjs <输出目录> <声线参考音频> [最低分] [最高分]')
  process.exit(1)
}
const from = Number(minArg ?? 1)
const to = Number(maxArg ?? 100)
const baseURL = (process.env.MIMO_BASE_URL || 'https://api.xiaomimimo.com/v1').replace(/\/+$/, '')
const prefix = process.env.PREFIX_TEXT || '大白饭到账'
const instruction = process.env.MIMO_INSTRUCTION || '请自然朗读下面这句话，正常播报语气，不要夸张，不要添加任何其他内容：'
const refBytes = readFileSync(refArg)
const refMime = /\.wav$/i.test(refArg) ? 'audio/wav' : 'audio/mpeg'
const voice = `data:${refMime};base64,${refBytes.toString('base64')}`

const DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九']

function integerText(n) {
  if (n <= 0) return '零'
  const units = [[1000, '千'], [100, '百'], [10, '十'], [1, '']]
  let out = ''
  let zeroPending = false
  for (const [value, unit] of units) {
    const digit = Math.floor(n / value) % 10
    if (digit === 0) {
      if (out.length > 0 && n % value !== 0) zeroPending = true
      continue
    }
    if (zeroPending) { out += '零'; zeroPending = false }
    if (!(value === 10 && digit === 1 && out.length === 0)) out += DIGITS[digit]
    out += unit
  }
  return out
}

export function amountText(amount) {
  const cents = Math.max(1, Math.round(amount * 100))
  const whole = Math.floor(cents / 100)
  const fraction = String(cents % 100).padStart(2, '0').replace(/0+$/, '')
  return fraction ? `${integerText(whole)}点${fraction.split('').map((d) => DIGITS[Number(d)]).join('')}` : integerText(whole)
}

async function render(text) {
  const body = {
    model: 'mimo-v2.5-tts-voiceclone',
    messages: [{ role: 'user', content: instruction }, { role: 'assistant', content: text }],
    audio: { format: 'mp3', voice },
    stream: false,
  }
  const delays = [6_000, 15_000, 30_000, 60_000]
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey.trim()}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    })
    const raw = await response.text()
    if (response.status === 429 && attempt < delays.length) {
      console.error(`429，等待 ${delays[attempt] / 1000}s`)
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]))
      continue
    }
    if (!response.ok) throw new Error(`HTTP ${response.status} ${raw.slice(0, 160)}`)
    const parsed = JSON.parse(raw)
    const data = parsed?.choices?.[0]?.message?.audio?.data
    if (typeof data !== 'string' || !data) throw new Error('没有 audio.data')
    return Buffer.from(data, 'base64')
  }
}

mkdirSync(outDir, { recursive: true })
const gap = Number(process.env.GAP_MS ?? 2200)
const manifest = []
for (let cents = from; cents <= to; cents += 1) {
  const target = join(outDir, `${cents}.mp3`)
  const text = `${prefix}，${amountText(cents / 100)}元`
  if (existsSync(target) && !process.env.FORCE) { manifest.push({ cents, text, skipped: true }); continue }
  try {
    const bytes = await render(text)
    writeFileSync(target, bytes)
    manifest.push({ cents, text, bytes: bytes.length })
    process.stdout.write(`${cents} `)
  } catch (error) {
    manifest.push({ cents, text, error: String(error.message ?? error) })
    console.error(`\n${cents} 失败：${error.message}`)
  }
  await new Promise((resolve) => setTimeout(resolve, gap))
}
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify({ prefix, from, to, clips: manifest }, null, 2))
const ok = manifest.filter((entry) => !entry.error).length
console.log(`\n完成 ${ok}/${manifest.length}，目录 ${outDir}`)
