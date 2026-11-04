// 把一段「逐字朗读」的音频按静音切成多个片段，用于生成可拼接的音色包。
// 用法：node scripts/split-clips.mjs <输入音频> <输出目录> <片段名1,片段名2,...> [噪声阈值dB] [最短静音秒]
import { spawnSync } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [input, outDir, namesArg, noiseArg, gapArg] = process.argv.slice(2)
if (!input || !outDir || !namesArg) {
  console.error('用法：node scripts/split-clips.mjs <输入音频> <输出目录> <名称1,名称2,...> [噪声阈值dB] [最短静音秒]')
  process.exit(1)
}
const names = namesArg.split(',').map((s) => s.trim()).filter(Boolean)
const noise = noiseArg ?? '-32dB'
const minGap = gapArg ?? '0.12'

function detect() {
  const args = ['-hide_banner', '-loglevel', 'info', '-i', input, '-af', `silencedetect=noise=${noise}:d=${minGap}`, '-f', 'null', 'NUL']
  const result = spawnSync('ffmpeg', args, { encoding: 'utf8' })
  const stderr = String(result.stderr ?? '')
  const starts = [...stderr.matchAll(/silence_start: ([\d.]+)/g)].map((m) => Number(m[1]))
  const ends = [...stderr.matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1]))
  return { starts, ends }
}

const duration = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', input], { encoding: 'utf8' }).trim())
const { starts, ends } = detect()
// 语音区间 = 静音区间的补集
const silences = []
for (let index = 0; index < starts.length; index += 1) {
  silences.push([starts[index], ends[index] ?? duration])
}
const speech = []
let cursor = 0
for (const [start, end] of silences) {
  if (start - cursor > 0.05) speech.push([cursor, start])
  cursor = Math.max(cursor, end)
}
if (duration - cursor > 0.05) speech.push([cursor, duration])

if (speech.length !== names.length) {
  console.error(JSON.stringify({ error: '片段数不匹配', expected: names.length, got: speech.length, duration, speech, silences }, null, 2))
  process.exit(2)
}
mkdirSync(outDir, { recursive: true })
const written = []
speech.forEach(([start, end], index) => {
  const pad = 0.04
  const from = Math.max(0, start - pad)
  const to = Math.min(duration, end + pad)
  const target = join(outDir, `${names[index]}.mp3`)
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', from.toFixed(3), '-to', to.toFixed(3), '-i', input,
    '-ac', '1', '-ar', '24000', '-c:a', 'libmp3lame', '-b:a', '64k', target])
  written.push({ name: names[index], from: Number(from.toFixed(2)), to: Number(to.toFixed(2)) })
})
writeFileSync(join(outDir, 'split.json'), JSON.stringify({ input, written }, null, 2))
console.log(JSON.stringify({ outDir, clips: written }, null, 2))
