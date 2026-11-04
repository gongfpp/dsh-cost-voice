// 批量渲染一个音色包：每段文本 -> 一个 mp3 片段。
// 用法：MIMO_API_KEY=... node scripts/build-pack.mjs <输出目录> <模式> <音色参数文件或值>
// 模式：clone（参考音频路径） | voicedesign（音色描述文本） | preset（预置音色 ID）
// 片段清单写在本文件 CLIPS 里，可按音色包调整。
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export const CLIPS = [
  ['prefix-token', 'token到账'],
  ['0', '零'], ['1', '一'], ['2', '二'], ['3', '三'], ['4', '四'],
  ['5', '五'], ['6', '六'], ['7', '七'], ['8', '八'], ['9', '九'],
  ['dot', '点'], ['yuan', '元'],
  ['ten', '十'], ['hundred', '百'], ['thousand', '千'], ['ten-thousand', '万'],
]

const [outDir, mode, voiceArg] = process.argv.slice(2)
const apiKey = process.env.MIMO_API_KEY
if (!outDir || !mode || !voiceArg) {
  console.error('用法：MIMO_API_KEY=... node scripts/build-pack.mjs <输出目录> <clone|voicedesign|preset> <参考音频|音色描述|音色ID>')
  process.exit(1)
}
if (!apiKey) {
  console.error('缺少 MIMO_API_KEY')
  process.exit(1)
}

const baseURL = (process.env.MIMO_BASE_URL || (apiKey.trim().startsWith('tp-') ? 'https://token-plan-cn.xiaomimimo.com/v1' : 'https://api.xiaomimimo.com/v1')).replace(/\/+$/, '')
const model = mode === 'clone' ? 'mimo-v2.5-tts-voiceclone' : mode === 'voicedesign' ? 'mimo-v2.5-tts-voicedesign' : 'mimo-v2.5-tts'

function voiceField() {
  if (mode === 'clone') {
    const bytes = readFileSync(voiceArg)
    const mime = /\.wav$/i.test(voiceArg) ? 'audio/wav' : 'audio/mpeg'
    return `data:${mime};base64,${bytes.toString('base64')}`
  }
  return voiceArg
}

async function render(tag, text) {
  const voice = voiceField()
  const messages = []
  if (mode === 'voicedesign') messages.push({ role: 'user', content: voiceArg })
  messages.push({ role: 'assistant', content: text })
  const body = { model, messages, audio: { format: 'mp3' }, stream: false }
  if (mode !== 'voicedesign') body.audio.voice = voice
  const delays = [8_000, 20_000, 40_000, 60_000]
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey.trim()}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    })
    const raw = await response.text()
    let parsed
    try { parsed = JSON.parse(raw) } catch { parsed = undefined }
    if (response.status === 429 && attempt < delays.length) {
      console.error(`${tag}: 429，${delays[attempt] / 1000}s 后重试`)
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]))
      continue
    }
    if (!response.ok) throw new Error(`${tag}: HTTP ${response.status} ${raw.slice(0, 200)}`)
    const data = parsed?.choices?.[0]?.message?.audio?.data
    if (typeof data !== 'string' || !data) throw new Error(`${tag}: 没有 audio.data`)
    const target = join(outDir, `${tag}.mp3`)
    writeFileSync(target, Buffer.from(data, 'base64'))
    return { tag, text, target: target.replaceAll('\\', '/') }
  }
}

mkdirSync(outDir, { recursive: true })
const manifest = []
const queue = [...CLIPS]
const failures = []
const gapMs = Number(process.env.GAP_MS ?? 2500)
const workers = Number(process.env.WORKERS ?? 1)
async function worker() {
  for (;;) {
    const item = queue.shift()
    if (!item) return
    const [tag, text] = item
    if (existsSync(join(outDir, `${tag}.mp3`)) && !process.env.FORCE) { manifest.push({ tag, text, skipped: true }); continue }
    try { manifest.push(await render(tag, text)) } catch (error) { failures.push({ tag, error: String(error.message ?? error) }) }
    await new Promise((resolve) => setTimeout(resolve, gapMs))
  }
}
await Promise.all(Array.from({ length: workers }, worker))
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify({ mode, clips: manifest, failures }, null, 2))
console.log(JSON.stringify({ outDir, clips: manifest.length, failures }, null, 2))
if (failures.length > 0) process.exit(3)
