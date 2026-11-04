// 把音色包片段就地规范化：裁掉首尾静音 + 静态增益到统一响度，运行时才能直接拼接。
// 用法：node scripts/normalize-pack.mjs <包目录> [目标平均音量dB，默认 -18]
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const [packDir, targetArg] = process.argv.slice(2)
if (!packDir) {
  console.error('用法：node scripts/normalize-pack.mjs <包目录> [目标平均音量dB]')
  process.exit(1)
}
const targetDb = Number(targetArg ?? -18)
const trim = 'silenceremove=start_periods=1:start_threshold=-38dB:start_silence=0.02,areverse,silenceremove=start_periods=1:start_threshold=-38dB:start_silence=0.02,areverse'
const tmp = mkdtempSync(join(tmpdir(), 'pack-'))
const results = []
try {
  for (const file of readdirSync(packDir).filter((name) => name.endsWith('.mp3'))) {
    const source = join(packDir, file)
    const trimmed = join(tmp, `${file}.trim.wav`)
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', source, '-af', trim, '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', trimmed])
    const probe = spawnSync('ffmpeg', ['-hide_banner', '-i', trimmed, '-af', 'volumedetect', '-f', 'null', 'NUL'], { encoding: 'utf8' })
    const match = /mean_volume:\s*(-?[\d.]+) dB/.exec(String(probe.stderr ?? ''))
    const mean = match ? Number(match[1]) : targetDb
    const gain = Math.max(-15, Math.min(15, Number((targetDb - mean).toFixed(2))))
    const output = join(tmp, `${file}.out.mp3`)
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', trimmed, '-af', `volume=${gain}dB`, '-ac', '1', '-ar', '24000', '-c:a', 'libmp3lame', '-b:a', '64k', output])
    copyFileSync(output, source)
    const duration = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', source], { encoding: 'utf8' }).trim())
    results.push({ file, gain, duration: Number(duration.toFixed(2)) })
  }
  writeFileSync(join(packDir, 'normalized.json'), JSON.stringify({ targetDb, clips: results }, null, 2))
  console.log(JSON.stringify({ packDir, targetDb, clips: results.length, maxDuration: Math.max(...results.map((r) => r.duration)), totalDuration: Number(results.reduce((sum, r) => sum + r.duration, 0).toFixed(2)) }, null, 2))
} finally {
  rmSync(tmp, { recursive: true, force: true })
}


