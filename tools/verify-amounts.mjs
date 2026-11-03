// 校验预渲染的金额整句：ASR 文不对题或时长异常就重渲染。
// 用法：MIMO_API_KEY=... node tools/verify-amounts.mjs <目录> <声线参考音频> [最低分] [最高分]
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const [outDir, refArg, minArg, maxArg] = process.argv.slice(2)
const apiKey = process.env.MIMO_API_KEY
if (!outDir || !refArg || !apiKey) {
  console.error('用法：MIMO_API_KEY=... node tools/verify-amounts.mjs <目录> <声线参考音频> [最低分] [最高分]')
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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
function amountText(amount) {
  const cents = Math.max(1, Math.round(amount * 100))
  const whole = Math.floor(cents / 100)
  const fraction = String(cents % 100).padStart(2, '0').replace(/0+$/, '')
  return fraction ? `${integerText(whole)}点${fraction.split('').map((d) => DIGITS[Number(d)]).join('')}` : integerText(whole)
}
const normalize = (value) => String(value ?? '').replace(/[，。、,.\s！!？?；;：:]/g, '')

async function call(body, retries = 4) {
  const delays = [6000, 15000, 30000, 60000]
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey.trim()}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    })
    const raw = await response.text()
    if (response.status === 429 && attempt < Math.min(retries, delays.length)) { await sleep(delays[attempt]); continue }
    if (!response.ok) throw new Error(`HTTP ${response.status} ${raw.slice(0, 140)}`)
    return JSON.parse(raw)
  }
}

async function render(text) {
  const parsed = await call({
    model: 'mimo-v2.5-tts-voiceclone',
    messages: [{ role: 'user', content: instruction }, { role: 'assistant', content: text }],
    audio: { format: 'mp3', voice }, stream: false,
  })
  const data = parsed?.choices?.[0]?.message?.audio?.data
  if (typeof data !== 'string' || !data) throw new Error('没有 audio.data')
  return Buffer.from(data, 'base64')
}

async function transcribe(bytes) {
  const parsed = await call({
    model: 'mimo-v2.5-asr',
    messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: `data:audio/mpeg;base64,${bytes.toString('base64')}` } }] }],
  })
  const message = parsed?.choices?.[0]?.message
  return message?.content || message?.reasoning_content || ''
}

function durationOf(file) {
  return Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim())
}

const summary = []
for (let cents = from; cents <= to; cents += 1) {
  const file = join(outDir, `${cents}.mp3`)
  const expected = `${prefix}${amountText(cents / 100)}元`
  const wanted = normalize(expected)
  if (!existsSync(file)) { summary.push({ cents, status: 'missing' }); continue }
  let ok = false
  let lastReason = ''
  for (let attempt = 1; attempt <= 4 && !ok; attempt += 1) {
    const bytes = attempt === 1 ? readFileSync(file) : await render(expected)
    const spoken = normalize(await transcribe(bytes))
    const duration = attempt === 1 && existsSync(file) ? durationOf(file) : (writeFileSync(file, bytes), durationOf(file))
    const amountOk = spoken.includes(normalize(`${amountText(cents / 100)}元`))
    const greetingOk = spoken.includes('到账')
    const durationOk = duration >= 1.4 && duration <= 5.6
    ok = amountOk && greetingOk && durationOk
    lastReason = `ASR="${spoken.slice(0, 40)}" dur=${duration.toFixed(2)}`
    if (!ok && attempt === 1) continue
    if (!ok) { writeFileSync(file, bytes); await sleep(1800) }
  }
  summary.push({ cents, status: ok ? 'ok' : 'bad', detail: lastReason })
  if (!ok) console.error(`${cents}: ${lastReason}`)
}
const bad = summary.filter((entry) => entry.status !== 'ok')
writeFileSync(join(outDir, 'verify.json'), JSON.stringify(summary, null, 2))
console.log(JSON.stringify({ checked: summary.length, ok: summary.length - bad.length, bad: bad.map((entry) => entry.cents) }, null, 2))
