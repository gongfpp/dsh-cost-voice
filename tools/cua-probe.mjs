import { CuaDriver, GetDesktopStateInput, StartSessionInput, EndSessionInput } from "@trycua/cua-driver"

const out = {}
try {
  const driver = CuaDriver.create(undefined)
  out.created = true
  try {
    const d = await driver.getDesktopState(GetDesktopStateInput.new({}))
    out.stateOk = true
    out.text = String(d?.text ?? "").slice(0, 500)
    out.images = (d?.images ?? []).length
  } catch (e) {
    out.stateError = { name: e?.name, message: e?.message, code: e?.code, cause: String(e?.cause ?? ""), stack: String(e?.stack ?? "").slice(0, 1200) }
  }
  try { await driver.shutdown() } catch (e) { out.shutdownError = String(e?.message ?? e) }
  try { driver.uniffiDestroy?.() } catch {}
} catch (e) {
  out.createError = { name: e?.name, message: e?.message, cause: String(e?.cause ?? ""), stack: String(e?.stack ?? "").slice(0, 1500) }
}
console.log(JSON.stringify(out, null, 2))
