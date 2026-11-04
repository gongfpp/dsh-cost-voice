// 把金额转成中文读法，并用音频片段拼出一句话。
// 用法：node scripts/assemble.mjs <片段目录> <金额> <输出文件> [前缀片段名]
// 例：  node scripts/assemble.mjs assets/voices/alipay-zh 0.12 dev/samples/a.mp3 prefix-receipt
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九']
const CLIP_OF_DIGIT = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']

/** 0..9999 的整数读法，返回片段名数组。 */
export function integerClips(n) {
  if (n <= 0) return ['0']
  const out = []
  const units = [
    [1000, 'thousand'],
    [100, 'hundred'],
    [10, 'ten'],
    [1, ''],
  ]
  let zeroPending = false
  for (const [value, clip] of units) {
    const d = Math.floor(n / value) % 10
    if (d === 0) {
      if (out.length > 0 && n % value !== 0) zeroPending = true
      continue
    }
    if (zeroPending) {
      out.push('0')
      zeroPending = false
    }
    // 十位上的一读“十”而不是“一十”
    if (!(value === 10 && d === 1 && out.length === 0)) out.push(CLIP_OF_DIGIT[d])
    if (clip) out.push(clip)
  }
  if (n >= 10000) throw new Error('金额超过一万，需要额外片段')
  return out
}

/** 完整金额读法：整数 + 点 + 小数逐位 + 元。 */
export function amountClips(amount) {
  const clamped = Math.max(0.01, Math.round(amount * 100) / 100)
  const [whole, fraction = ''] = clamped.toFixed(2).split('.')
  const clips = integerClips(Number(whole))
  const digits = fraction.replace(/0+$/, '')
  if (digits.length > 0) {
    clips.push('dot', ...digits.split('').map(String))
  }
  clips.push('yuan')
  return clips
}

export function assemble(packDir, clips, output, prefix) {
  const dir = resolve(packDir)
  const list = [...(prefix ? [prefix] : []), ...clips]
  const tmp = mkdtempSync(join(tmpdir(), 'voice-'))
  try {
    // 先逐段裁掉首尾静音，再按每段的平均音量做静态增益，最后拼接。
    // 不用 loudnorm 动态归一：它会在片段之间压/放音量，听感就是"音色不统一"。
    const trim = 'silenceremove=start_periods=1:start_threshold=-38dB:start_silence=0.02,areverse,silenceremove=start_periods=1:start_threshold=-38dB:start_silence=0.02,areverse'
    const targetDb = -18
    const wavs = list.map((name, index) => {
      const source = join(dir, `${name}.mp3`)
      const trimmed = join(tmp, `${String(index).padStart(2, '0')}-${name}-trim.wav`)
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', source,
        '-af', trim, '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', trimmed])
      const probe = spawnSync('ffmpeg', ['-hide_banner', '-i', trimmed, '-af', 'volumedetect', '-f', 'null', 'NUL'], { encoding: 'utf8' })
      const match = /mean_volume:\s*(-?[\d.]+) dB/.exec(String(probe.stderr ?? ''))
      const mean = match ? Number(match[1]) : targetDb
      const gain = Math.max(-12, Math.min(12, Number((targetDb - mean).toFixed(2))))
      const wav = join(tmp, `${String(index).padStart(2, '0')}-${name}.wav`)
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', trimmed, '-af', `volume=${gain}dB`,
        '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', wav])
      return wav
    })
    const listFile = join(tmp, 'list.txt')
    writeFileSync(listFile, wavs.map((wav) => `file '${wav.replaceAll("'", "'\\''")}'`).join('\n'))
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile,
      '-ac', '1', '-ar', '24000', '-c:a', 'libmp3lame', '-b:a', '64k', resolve(output)])
    return list
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

const [packArg, amountArg, outputArg, prefixArg] = process.argv.slice(2)
if (packArg && amountArg && outputArg) {
  const clips = amountClips(Number(amountArg))
  assemble(packArg, clips, outputArg, prefixArg)
  console.log(JSON.stringify({ output: outputArg, amount: Number(amountArg), clips: [prefixArg, ...clips].filter(Boolean) }, null, 2))
}

