// 调小米 MiMo TTS（voicedesign / 预置音色）生成一句音频。
// 用法：MIMO_API_KEY=... node scripts/mimo-tts.mjs <输出文件> <文本> [音色描述或音色ID] [model]
// model: mimo-v2.5-tts-voicedesign（默认，第二段参数当音色描述） | mimo-v2.5-tts（第二段参数当预置音色ID）
import { readFileSync, writeFileSync } from 'node:fs'

const [output, text, voiceArg, modelArg] = process.argv.slice(2)
const apiKey = process.env.MIMO_API_KEY
if (!output || !text) {
  console.error('用法：MIMO_API_KEY=... node scripts/mimo-tts.mjs <输出文件> <文本> [音色描述/音色ID] [model]')
  process.exit(1)
}
if (!apiKey) {
  console.error('缺少 MIMO_API_KEY')
  process.exit(1)
}

const model = modelArg || 'mimo-v2.5-tts-voicedesign'
const baseURL = (process.env.MIMO_BASE_URL || (apiKey.trim().startsWith('tp-') ? 'https://token-plan-cn.xiaomimimo.com/v1' : 'https://api.xiaomimimo.com/v1')).replace(/\/+$/, '')

const messages = []
const instruction = process.env.MIMO_INSTRUCTION?.trim()
if (instruction) messages.push({ role: 'user', content: instruction })
else if (voiceArg && model === 'mimo-v2.5-tts-voicedesign') messages.push({ role: 'user', content: voiceArg })
messages.push({ role: 'assistant', content: text })

const body = { model, messages, audio: { format: 'mp3' }, stream: false }
if (model === 'mimo-v2.5-tts-voiceclone') {
  // voiceArg 是参考音频文件路径：转成 data URL 传给 audio.voice
  if (!voiceArg) { console.error('voiceclone 需要参考音频文件路径'); process.exit(1) }
  const bytes = readFileSync(voiceArg)
  const mime = /\.wav$/i.test(voiceArg) ? 'audio/wav' : 'audio/mpeg'
  body.audio.voice = `data:${mime};base64,${bytes.toString('base64')}`
} else if (model !== 'mimo-v2.5-tts-voicedesign' && voiceArg) {
  body.audio.voice = voiceArg
}

const response = await fetch(`${baseURL}/chat/completions`, {
  method: 'POST',
  headers: { authorization: `Bearer ${apiKey.trim()}`, 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'dsh-cost-voice' },
  body: JSON.stringify(body),
})

const raw = await response.text()
let parsed
try { parsed = JSON.parse(raw) } catch { parsed = undefined }
if (!response.ok) {
  const detail = parsed?.error?.message || parsed?.error || parsed?.message || raw.slice(0, 500)
  console.error(`HTTP ${response.status}: ${detail}`)
  process.exit(2)
}
const data = parsed?.choices?.[0]?.message?.audio?.data
if (typeof data !== 'string' || !data) {
  console.error('响应里没有 audio.data：' + raw.slice(0, 500))
  process.exit(3)
}
writeFileSync(output, Buffer.from(data, 'base64'))
console.log(JSON.stringify({ output, model, bytes: Buffer.from(data, 'base64').length }))

