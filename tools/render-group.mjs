// 渲染一段“逐字朗读”的音频并用 ASR 校验内容；校验不过就重试。
// 用法：MIMO_API_KEY=... node tools/render-group.mjs <输出mp3> <要朗读的文本> <期望包含的字，如 五六七八九> <参考音频|音色描述|音色ID> <clone|voicedesign|preset> [最多尝试次数]
import { readFileSync, writeFileSync } from 'node:fs'

const [output, text, expected, voiceArg, mode = 'clone', attemptsArg] = process.argv.slice(2)
const apiKey = process.env.MIMO_API_KEY
const attempts = Number(attemptsArg ?? 5)
if (!output || !text || !expected || !voiceArg || !apiKey) {
  console.error('用法：MIMO_API_KEY=... node tools/render-group.mjs <输出mp3> <文本> <期望字> <音色来源> <clone|voicedesign|preset> [尝试次数]')
  process.exit(1)
}
const baseURL = (process.env.MIMO_BASE_URL || (apiKey.trim().startsWith('tp-') ? 'https://token-plan-cn.xiaomimimo.com/v1' : 'https://api.xiaomimimo.com/v1')).replace(/\/+$/, '')
const model = mode === 'clone' ? 'mimo-v2.5-tts-voiceclone' : mode === 'voicedesign' ? 'mimo-v2.5-tts-voicedesign' : 'mimo-v2.5-tts'
const INSTRUCTION = process.env.MIMO_INSTRUCTION || '请逐字朗读下面这句话，原样读出，字与字之间稍作停顿，不要添加任何其他内容：'

function voiceField() {
  if (mode !== 'clone') return voiceArg
  const bytes = readFileSync(voiceArg)
  const mime = /\.wav$/i.test(voiceArg) ? 'audio/wav' : 'audio/mpeg'
  return `data:${mime};base64,${bytes.toString('base64')}`
}

async function post(body) {
  const response = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey.trim()}`, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  })
  const raw = await response.text()
  if (!response.ok) throw new Error(`HTTP ${response.status} ${raw.slice(0, 160)}`)
  const parsed = JSON.parse(raw)
  const data = parsed?.choices?.[0]?.message?.audio?.data
  if (typeof data !== 'string' || !data) throw new Error('没有 audio.data')
  return Buffer.from(data, 'base64')
}

async function transcribe(bytes) {
  const data = `data:audio/mpeg;base64,${bytes.toString('base64')}`
  const response = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey.trim()}`, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ model: 'mimo-v2.5-asr', messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data } }] }] }),
  })
  const raw = await response.text()
  if (!response.ok) return { text: '', error: `HTTP ${response.status}` }
  const parsed = JSON.parse(raw)
  const message = parsed?.choices?.[0]?.message
  return { text: message?.content || message?.reasoning_content || '' }
}

for (let attempt = 1; attempt <= attempts; attempt += 1) {
  const body = { model, messages: [{ role: 'user', content: INSTRUCTION }, { role: 'assistant', content: text }], audio: { format: 'mp3' }, stream: false }
  if (mode !== 'voicedesign') body.audio.voice = voiceField()
  let bytes
  try { bytes = await post(body) } catch (error) {
    console.error(`尝试 ${attempt}: 合成失败 ${error.message}`)
    await new Promise((resolve) => setTimeout(resolve, 5000))
    continue
  }
  const asr = await transcribe(bytes)
  const normalize = (value) => value.replace(/[，。、,.\s！!？?；;：:]/g, '')
  const spoken = normalize(asr.text)
  const wanted = normalize(expected)
  const ok = spoken === wanted
  console.error(`尝试 ${attempt}: ASR="${asr.text}" ${ok ? '✓' : '✗'}`)
  if (ok) {
    writeFileSync(output, bytes)
    console.log(JSON.stringify({ output, attempt, asr: asr.text, bytes: bytes.length }))
    process.exit(0)
  }
  await new Promise((resolve) => setTimeout(resolve, 2500))
}
console.error('重试次数用尽，未得到校验通过的音频')
process.exit(2)
