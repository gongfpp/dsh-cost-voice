// 离线冒烟：用假的浏览器环境加载客户端半，验证模块格式、插槽注册与页面组件可渲染。
// 用法：node tools/smoke-client.mjs
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const registered = []
const rendered = []

globalThis.window = {}
globalThis.document = {
  visibilityState: 'visible',
  addEventListener() {},
  removeEventListener() {},
}
globalThis.localStorage = { getItem: () => null, setItem() {} }
globalThis.fetch = async () => ({ ok: true, json: async () => ({ costMeter: false, seq: 0, events: [] }) })

const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (initial) => [initial, () => {}],
  useEffect() {},
  useRef: (value) => ({ current: value }),
  useCallback: (fn) => fn,
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
}
let definition = null
globalThis.window.__ModuleLoader__ = { load: (value) => { definition = value } }
await import(pathToFileURL(join(root, 'client.js')).href)

const plugin = definition.factory((name) => {
  if (name === 'react') return react
  throw new Error(`unexpected require: ${name}`)
})

const ctx = {
  effect(fn) { const cleanup = fn(); return cleanup },
  slots: {
    inject(slot, callback) { callback() },
    register(spec, component) { registered.push({ spec, component }); rendered.push(component); return () => {} },
  },
}
plugin.apply(ctx)

const overlay = registered.find((entry) => entry.spec.name === 'shell.overlay')
const page = registered.find((entry) => entry.spec.name === 'plugins.bundle.config')
const checks = {
  moduleId: definition.id,
  inject: plugin.inject,
  overlayId: overlay?.spec.id,
  pageKey: page?.spec.key,
  registrations: registered.length,
}

// 渲染覆盖层与配置页，确认组件本身不抛错
const calls = {}
let overlayTree = null
let pageTree = null
try {
  const element = overlay.component({ useSessions: (selector) => selector({ byId: {} }) })
  calls.overlayElementType = typeof element?.type
  overlayTree = typeof element?.type === 'function' ? element.type(element.props) : element
} catch (error) { calls.overlayError = String(error.message ?? error) }
try {
  const element = page.component({ view: 'page' })
  calls.pageElementType = typeof element?.type
  pageTree = typeof element?.type === 'function' ? element.type(element.props) : element
} catch (error) { calls.pageError = String(error.message ?? error) }
checks.overlayRendersNull = overlayTree === null
checks.pageRendersTree = Boolean(pageTree && pageTree.type === 'div')
checks.overlayElementType = calls.overlayElementType
checks.pageElementType = calls.pageElementType
if (calls.overlayError) checks.overlayError = calls.overlayError
if (calls.pageError) checks.pageError = calls.pageError

const fail = []
if (checks.moduleId !== 'dsh-cost-voice') fail.push('module id')
if (checks.overlayId !== 'cost-voice') fail.push('overlay id')
if (checks.pageKey !== 'dsh-cost-voice') fail.push('page key')
if (checks.overlayError) fail.push('overlay threw')
if (checks.pageError) fail.push('page threw')
if (!checks.pageRendersTree) fail.push('page tree')

console.log(JSON.stringify({ checks, pass: fail.length === 0, fail }, null, 2))
process.exit(fail.length === 0 ? 0 : 1)
