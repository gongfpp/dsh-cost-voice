// 由 icon.png 生成 docs/social-preview.svg（1280×640），避免图标与分享图两处手工同步漂移。
// 用法：node scripts/build-social-preview.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const iconBase64 = readFileSync(resolve(root, "icon.png")).toString("base64");
const iconHref = `data:image/png;base64,${iconBase64}`;

// 图标在分享图上的位置与尺寸（1280×640 画布）
const ICON = { x: 96, y: 176, size: 288, radius: 60 };

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 640" width="1280" height="640" font-family="'Microsoft YaHei','PingFang SC','Noto Sans SC',system-ui,sans-serif" role="img" aria-label="每轮扣款语音播报 · dsh-cost-voice">
  <title>每轮扣款语音播报 · dsh-cost-voice</title>
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0B1220"/>
      <stop offset="0.55" stop-color="#101C33"/>
      <stop offset="1" stop-color="#0B1220"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#4D6BFE" stop-opacity="0.34"/>
      <stop offset="1" stop-color="#4D6BFE" stop-opacity="0"/>
    </radialGradient>
    <clipPath id="iconClip">
      <rect x="${ICON.x}" y="${ICON.y}" width="${ICON.size}" height="${ICON.size}" rx="${ICON.radius}"/>
    </clipPath>
  </defs>

  <rect width="1280" height="640" fill="url(#bg)"/>
  <circle cx="240" cy="320" r="330" fill="url(#glow)"/>

  <!-- 图标：吃白饭的蓝色大肥鱼（来自 icon.png） -->
  <rect x="${ICON.x - 6}" y="${ICON.y - 6}" width="${ICON.size + 12}" height="${ICON.size + 12}" rx="${ICON.radius + 6}" fill="#FFFFFF" opacity="0.06"/>
  <image href="${iconHref}" x="${ICON.x}" y="${ICON.y}" width="${ICON.size}" height="${ICON.size}" clip-path="url(#iconClip)" preserveAspectRatio="xMidYMid slice"/>

  <!-- 文字 -->
  <text x="470" y="250" font-size="64" font-weight="700" fill="#F8FAFC">每轮扣款语音播报</text>
  <text x="470" y="310" font-size="30" fill="#94A3B8">dsh-cost-voice · DeepSeek Harness 插件</text>
  <text x="470" y="392" font-size="34" fill="#E2E8F0">每轮会话结束，支付宝到账。</text>
  <text x="470" y="440" font-size="34" fill="#E2E8F0">本轮花了多少，用声音告诉你。</text>

  <!-- 标签 -->
  <g font-size="24" fill="#CBD5F5">
    <rect x="470" y="492" width="188" height="52" rx="26" fill="#1E293B" stroke="#334155"/>
    <text x="564" y="526" text-anchor="middle">支付宝音色</text>
    <rect x="678" y="492" width="188" height="52" rx="26" fill="#1E293B" stroke="#334155"/>
    <text x="772" y="526" text-anchor="middle">大白饭音色</text>
    <rect x="886" y="492" width="248" height="52" rx="26" fill="#1E293B" stroke="#334155"/>
    <text x="1010" y="526" text-anchor="middle">音频内置 · 不联网</text>
  </g>

  <!-- 声波装饰 -->
  <g stroke="#38BDF8" stroke-width="6" stroke-linecap="round" opacity="0.5">
    <line x1="1160" y1="268" x2="1160" y2="372"/>
    <line x1="1190" y1="232" x2="1190" y2="408"/>
    <line x1="1220" y1="288" x2="1220" y2="352"/>
    <line x1="1250" y1="252" x2="1250" y2="388"/>
  </g>
</svg>
`;

writeFileSync(resolve(root, "docs/social-preview.svg"), svg);
console.log(`docs/social-preview.svg 已生成（内联 icon.png base64 ${iconBase64.length} 字符）`);
