// 把包内 mp3 压到 32kbps 单声道 24kHz：语音可懂度不变，体积约为原来一半。
// 用法：node scripts/shrink-audio.mjs [--check]
//   --check 只报告会压缩哪些文件，不动磁盘。
// 依赖 ffmpeg：设 FFMPEG 环境变量，或放在 PATH 里。
import { execFileSync } from 'node:child_process'
import { readdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const voices = join(root, 'assets', 'voices')
const ffmpeg = process.env.FFMPEG || 'ffmpeg'
const checkOnly = process.argv.includes('--check')
const TARGET_BPS = 32_000

const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const path = join(dir, entry.name)
  return entry.isDirectory() ? walk(path) : entry.name.endsWith('.mp3') ? [path] : []
})

const prober = ffmpeg.endsWith('ffmpeg') || ffmpeg.endsWith('ffmpeg.exe')
  ? ffmpeg.replace(/ffmpeg(\.exe)?$/, (match) => match.replace('ffmpeg', 'ffprobe'))
  : `${ffmpeg}probe`

const bitrateOf = (file) => {
  const out = execFileSync(prober, ['-v', 'error', '-show_entries', 'stream=bit_rate', '-of', 'default=nw=1:nk=1', file], { encoding: 'utf8' })
  return Number(out.trim()) || 0
}

const files = walk(voices)
let before = 0
let after = 0
let changed = 0
const failures = []
for (const file of files) {
  const size = statSync(file).size
  before += size
  const bitrate = bitrateOf(file)
  if (bitrate > 0 && bitrate <= TARGET_BPS + 8000) { after += size; continue }
  if (checkOnly) { after += Math.round(size * 0.51); changed += 1; continue }
  const temp = `${file}.tmp.mp3`
  try {
    execFileSync(ffmpeg, ['-y', '-v', 'error', '-i', file, '-c:a', 'libmp3lame', '-b:a', '32k', '-ar', '24000', '-ac', '1', '-map_metadata', '-1', temp])
    const next = statSync(temp).size
    if (next <= 0 || next >= size) { unlinkSync(temp); after += size; continue }
    renameSync(temp, file)
    after += next
    changed += 1
  } catch (error) {
    try { unlinkSync(temp) } catch { /* 已经不存在 */ }
    after += size
    failures.push({ file, message: String(error?.message ?? error).slice(0, 160) })
  }
}

const kb = (n) => `${(n / 1024).toFixed(0)} KB`
console.log(JSON.stringify({
  files: files.length,
  changed,
  before: kb(before),
  after: kb(after),
  saved: `${(100 - (after / before) * 100).toFixed(0)}%`,
  checkOnly,
  failures,
}, null, 2))
