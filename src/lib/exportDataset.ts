import JSZip from 'jszip'
import type { LabelDefinition, Sample } from '../types'
import type { MathLayoutExample } from './recognition'

const csvCell = (value: string | number) => `"${String(value).replaceAll('"', '""')}"`

const triggerDownload = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
}

export const exportDataset = async (
  samples: Sample[],
  labels: LabelDefinition[],
  writerId: string,
  layoutExamples: MathLayoutExample[],
  onProgress: (progress: number) => void,
) => {
  const zip = new JSZip()
  const imageFolder = zip.folder('images')!

  samples.forEach((sample) => {
    const base64 = sample.imageData.split(',')[1]
    imageFolder.file(`${sample.id}.png`, base64, { base64: true })
  })

  const manifest = samples.map((sample) => ({
    sample_id: sample.id,
    image: `images/${sample.id}.png`,
    label_id: sample.labelId,
    unicode: sample.label,
    label_name: sample.labelName,
    latex: sample.latex,
    category: sample.category,
    writer_id: sample.writerId,
    session_id: sample.sessionId,
    created_at: sample.createdAt,
    source_canvas: sample.sourceCanvas,
    derived_image: { width: sample.imageWidth, height: sample.imageHeight, background: 'white' },
    bbox_normalized: sample.bbox,
    strokes: sample.strokes,
    stroke_count: sample.strokeCount,
    point_count: sample.pointCount,
    schema_version: sample.schemaVersion,
  }))

  zip.file('manifest.jsonl', manifest.map((entry) => JSON.stringify(entry)).join('\n'))
  zip.file(
    'layout_examples.jsonl',
    layoutExamples.map((example) => JSON.stringify({
      ...example,
      writer_id: writerId,
      schema_version: 1,
    })).join('\n'),
  )
  zip.file(
    'labels.json',
    JSON.stringify(
      labels
        .filter((label) => samples.some((sample) => sample.labelId === label.id))
        .map(({ id, char, name, latex, category }) => ({ id, unicode: char, name, latex, category })),
      null,
      2,
    ),
  )

  const csvHeader = [
    'sample_id',
    'image',
    'label_id',
    'unicode',
    'latex',
    'category',
    'writer_id',
    'session_id',
    'created_at',
  ]
  const csvRows = samples.map((sample) =>
    [
      sample.id,
      `images/${sample.id}.png`,
      sample.labelId,
      sample.label,
      sample.latex,
      sample.category,
      sample.writerId,
      sample.sessionId,
      sample.createdAt,
    ]
      .map(csvCell)
      .join(','),
  )
  zip.file('labels.csv', [csvHeader.join(','), ...csvRows].join('\n'))
  zip.file(
    'README.txt',
    [
      'GlyphenWerk Datensatz',
      '======================',
      '',
      `${samples.length} handschriftliche Einzelzeichen von ${writerId}.`,
      '',
      'images/           Normalisierte 256 × 256 PNG-Dateien (schwarz auf weiß)',
      'manifest.jsonl    Vollständige Metadaten und rohe, normalisierte Strichpunkte',
      'labels.csv        Flache Zuordnung für gängige Trainingspipelines',
      'labels.json       Verwendeter Klassenkatalog',
      'layout_examples.jsonl  Bestätigte räumliche Relationen für Grenzen und Indizes',
      '',
      'Hinweis: Train/Validation/Test nach schreibender Person oder mindestens nach Sitzung trennen,',
      'damit sehr ähnliche Beispiele nicht gleichzeitig in Training und Auswertung landen.',
    ].join('\n'),
  )

  const blob = await zip.generateAsync(
    { type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } },
    (metadata) => onProgress(Math.round(metadata.percent)),
  )
  const day = new Date().toISOString().slice(0, 10)
  triggerDownload(blob, `glyphenwerk-datensatz-${day}.zip`)
}
