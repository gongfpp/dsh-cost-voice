# dsh-cost-voice

[![npm](https://img.shields.io/npm/v/dsh-cost-voice.svg)](https://www.npmjs.com/package/dsh-cost-voice)
[![license](https://img.shields.io/npm/l/dsh-cost-voice.svg)](LICENSE)
[![dsh](https://img.shields.io/badge/dsh-0.2.1%2B-4D6BFE)](https://github.com/deepseek-ai/deepseek-harness)

每轮会话结束，用**支付宝**或「**大白饭**」的声音报一句本轮花了多少钱。

语音是打包在插件里的音频片段，运行时不联网、不调用系统语音、不需要任何 TTS Key——装上就能播。

![插件设置页](docs/preview-settings.png)

## 功能

- **每轮结束自动播报**：「支付宝到账，零点一二元」/「大白饭到账，零点一二元」
- **两种音色**：支付宝（开源收款语音包拼接）与大白饭（MiMo 音色克隆）
- **金额优先取 `dsh-cost-meter`**：装了费用插件就用它的每轮费用；没装或取不到时按**该轮模型**的单价估算
- **按模型的价格表**：直接读 `dsh-cost-meter` 随包价格目录（354 个模型，USD/百万 token → 人民币），插件页可按模型覆盖单价
- **完整设置页**：音色、金额来源、模型价格、最小播报金额、音量、片段间隔、静音时段、试听、最近播报记录
- **去重与补播**：同一轮只播一次，刷新页面不重播；后台标签页错过的只补最近一条

## 安装

```sh
# 从 npm
dsh plugin --profile web add dsh-cost-voice

# 或本地目录（开发）
dsh plugin --profile web add D:\path\to\dsh-cost-voice
```

装好后重启一次 `dsh web`，刷新页面，在**设置 → 插件 → 每轮扣款语音播报**里点一次「试听」（同时解锁浏览器音频），之后每轮结束就会播报。

## 设置说明

| 设置 | 说明 |
|---|---|
| 音色 | 支付宝 / 大白饭 |
| 金额来源 | 费用插件（优先 `dsh-cost-meter`）/ 按单价估算 |
| 模型价格 | 按模型列出输入/输出单价（元/百万 token），留空用价格表、填写即覆盖；「其他模型」是表外兜底 |
| 低于此金额不播 | 默认 0，即任何金额都播 |
| 片段间隔 | 拼接时每段之间的停顿（毫秒），默认 40 |
| 音量 | 0–1 |
| 只在正常完成的轮次播报 | 关掉后中断/报错的轮次也会播 |
| 静音时段 | 例如 00:00–08:00 不播 |

## 金额怎么算

1. `dsh-cost-meter` 可用时：直接用它记录的该轮费用（人民币），与费用面板口径一致。
2. 否则按该轮实际使用的模型算：
   `输入 × 输入价 + 输出 × 输出价 + 缓存读 × 缓存读价 + 缓存写 × 缓存写价`（元/百万 token）。
3. 单价来源：`dsh-cost-meter` 随包的 `docs/provider-pricing.json`（USD/百万 token，折算汇率 7.2）→ 插件页可按模型覆盖 → 表外模型用兜底单价。

价格表随 `dsh-cost-meter` 更新而更新；插件包里也带了一份 `assets/pricing.json` 快照，费用插件不在时仍能估算。

## 音色与素材

| 音色 | 内容 | 来源 |
|---|---|---|
| 支付宝 | 18 段片段拼接（`0`–`9`、点、元、十百千万 + `支付宝到账` 前缀） | 开源项目 [Reathin/XVoice](https://github.com/Reathin/XVoice) 的收款语音片段 |
| 大白饭 | 0.01–1.00 元共 100 句**整句**预渲染；超出范围回落到 17 段拼接 | 小米 MiMo TTS 音色克隆生成 |

体积约 2.8 MB，全部随包分发，运行时不产生网络请求。

## 隐私

- 不联网、无遥测；音频文件只从本机插件目录经同源接口下发给页面。
- 插件只读会话事件里的用量与轮次信息，不读写对话正文，不上传任何内容。
- 浏览器侧设置保存在 `localStorage`，不离开本机。

## 兼容性

- DeepSeek Harness `>=0.2.1-0 <0.3.0-0`（Web GUI）
- Node.js `>=22`
- 与 `dsh-cost-meter` 搭配最佳；未安装时自动用单价估算

## 已知限制

- 页面需要开着且标签页在前台才会及时播报（后台标签页浏览器会压低定时器）。
- Chrome 需要一次点击（插件页的「试听」即可）才允许页面出声。
- 大白饭 1 元以上金额仍是片段拼接，会有一点机器感；0.01–1.00 元是整句。

## 开发

```
index.js                 宿主半：轮次事实（turn/end + 用量 + 费用）、价格目录、音频下发
client.js                客户端半：轮询、金额计算、音频拼接播放、插件页
assets/                  随包分发：音色片段、价格表快照
  voices/alipay-zh       支付宝片段
  voices/dabaifan-clone  大白饭片段
  voices/dabaifan-amounts  大白饭整句（1.mp3–100.mp3 = 0.01–1.00 元）
  pricing.json           价格表快照
scripts/                 开发脚本（不随包）：音色渲染、ASR 校验、响度统一、离线冒烟
dev/                     本地素材（不进仓库、不随包）：dev/samples/ 试听音频、dev/screenshots/ 原始截图
docs/                    仓库文档：preview-settings.png（随包，README 引用）、catalog-entry.yml（仅仓库用，不随包）
```

```sh
node scripts/smoke-host.mjs     # 宿主半离线冒烟
node scripts/smoke-client.mjs   # 客户端半离线冒烟
```

## 致谢与声明

- 支付宝播报片段来自开源项目 [Reathin/XVoice](https://github.com/Reathin/XVoice)（其 README 注明仅供娱乐）。
- 大白饭音色由小米 MiMo TTS 克隆生成；播报文案「大白饭到账」为二创梗，非真实支付语音。
- 本插件为娱乐用途，播报的金额是估算值，**不能作为账单依据**；真实费用请以 `dsh-cost-meter` 与各厂商账单为准。

## License

[MIT](LICENSE)

---

## English

Per-turn spend announcements for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): after each turn, the Web GUI plays a short voice clip in an Alipay or "Dabaifan" voice, e.g. "支付宝到账 0.12 元".

- Amount comes from `dsh-cost-meter` when available, otherwise estimated per-model from its bundled price catalog (354 models, USD→CNY at 7.2), with per-model overrides in the plugin page.
- All audio is bundled (≈2.8 MB); no network, no TTS service, no API key at runtime.
- Settings: voice, amount source, per-model prices, minimum amount, volume, clip gap, quiet hours, preview, recent announcements.

```sh
dsh plugin --profile web add dsh-cost-voice
```

Requires dsh `>=0.2.1-0 <0.3.0-0` and Node `>=22`. Entertainment only; amounts are estimates, not billing records.
