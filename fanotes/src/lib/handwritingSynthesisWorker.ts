import { synthesizeHandwriting, synthesizeHandwritingToFit } from './textToHandwriting'
import { personalStyle, type PersonalModel } from './personalHandwriting.mjs'
import type { Sample } from '../../../src/types'
let samples: Sample[] = []
let model: PersonalModel | undefined
let style = personalStyle()
self.onmessage = ({ data }) => {
  if (data.op === 'model') { samples = data.samples; model = data.model; style = personalStyle(model, model?.desktop?.motions ?? 128);
    const seen=new Set<string>(); style.units=[...(data.units ?? []),...style.units].filter(unit=>{const key=unit.label+':'+unit.id;if(seen.has(key))return false;seen.add(key);return true}); return }
  try {
    const options = { ...data.options, model }
    const result = data.fit ? synthesizeHandwritingToFit(data.text, samples, options, data.page, 18, style)
      : synthesizeHandwriting(data.text, samples, options, data.page, style)
    self.postMessage({ id: data.id, result })
  } catch { self.postMessage({ id: data.id, error: 'The handwriting preview could not be generated.' }) }
}
