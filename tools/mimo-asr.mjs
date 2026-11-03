// 用小米 MiMo ASR 转写一段音频，用来验证拼接/合成结果的实际内容。
// 用法：MIMO_API_KEY=... node tools/mimo-asr.mjs <音频文件> [...更多文件]
import { readFileSync } from 'node:fs'

const apiKey = process.env.MIMO_API_KEY
const files = process.argv.slice(2)
if (!apiKey || files.length === 0) {
  console.error('用法：MIMO_API_KEY=... node tools/mimo-asr.mjs <音频文件> [...]')
  process.exit(1)
}
const baseURL = (process.env.MIMO_BASE_URL || 'https://api.xiaomimimo.com/v1').replace(/\/+$/, '')
const mimeOf = (file) => (/\.wav$/i.test(file) ? 'audio/wav' : 'audio/mpeg')

for (const file of files) {
  const data = `data:${mimeOf(file)};base64,${readFileSync(file).toString('base64')}`
  const response = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey.trim()}`, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      model: 'mimo-v2.5-asr',
      messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data } }] }],
    }),
  })
  const raw = await response.text()
  let parsed
  try { parsed = JSON.parse(raw) } catch { parsed = undefined }
  if (!response.ok) {
    console.log(JSON.stringify({ file, error: `HTTP ${response.status}: ${raw.slice(0, 300)}` }))
    continue
  }
  const message = parsed?.choices?.[0]?.message
  console.log(JSON.stringify({ file, text: message?.content || message?.reasoning_content || '' }))
}
