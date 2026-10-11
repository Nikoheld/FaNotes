/**
 * Thin calls into the Rust paper reducer (`fanotes-wasm`).
 * Grow and the keep-on-page remap go through this module.
 */
import {
  initSync,
  applyStayPutOp as applyStayPutOpWasm,
  growPageFromMark as growPageFromMarkWasm,
  keepMarkOnPage as keepMarkOnPageWasm,
} from './paperWasm/fanotes_wasm.js'
import { PAPER_WASM_BASE64 } from './paperWasm/bytes'

let ready = false

const wasmBytes = () => {
  const binary = atob(PAPER_WASM_BASE64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

export const ensurePaperWasm = () => {
  if (ready) return
  initSync({ module: wasmBytes() })
  ready = true
}

const definedRecord = (value: object): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue
    out[key] = item !== null && typeof item === 'object' && !Array.isArray(item)
      ? definedRecord(item)
      : item
  }
  return out
}

export const keepMarkOnPage = (
  value: number,
  prevExtent: number,
  nextExtent: number,
  minPad = 0,
) => {
  ensurePaperWasm()
  return keepMarkOnPageWasm(value, prevExtent, nextExtent, minPad)
}

export const growPageFromMark = (
  extent: { width: number; height: number; originX?: number; originY?: number },
  mark: { x?: number; y?: number },
  painted: { width?: number; height?: number } = {},
) => {
  ensurePaperWasm()
  return growPageFromMarkWasm(
    definedRecord(extent),
    definedRecord(mark),
    definedRecord(painted),
  ) as { width: number; height: number; padX: number; padY: number }
}

export const applyStayPutOp = <State>(state: State, op: object): State => {
  ensurePaperWasm()
  return applyStayPutOpWasm(definedRecord(state as object), definedRecord(op)) as State
}

ensurePaperWasm()
