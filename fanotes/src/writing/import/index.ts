// The import API: `importStory(bytes, fileName)` makes a new story
// ({ manifest, scenes }) from a DOCX, Markdown or text file.
import { writerId } from '../model/ids'
import type { StoryLanguage } from '../model/types'
import { StoryBuilder, type ImportedStory } from './build'

export type ImportFormat = 'docx' | 'md' | 'txt'
export type ImportOptions = { deviceId?: string; language?: StoryLanguage; now?: Date }
export type { ImportedStory }

export const IMPORT_ACCEPT = '.docx,.md,.markdown,.txt,.text'

export const importFormatOf = (bytes: Uint8Array, fileName: string): ImportFormat => {
  const extension = fileName.toLowerCase().split('.').pop() ?? ''
  if (extension === 'docx' || (bytes[0] === 0x50 && bytes[1] === 0x4b)) return 'docx'
  if (extension === 'md' || extension === 'markdown') return 'md'
  return 'txt'
}

export const importStory = async (bytes: Uint8Array, fileName: string, options: ImportOptions = {}): Promise<ImportedStory> => {
  const builder = new StoryBuilder()
  const format = importFormatOf(bytes, fileName)
  if (options.language) builder.language = options.language
  if (format === 'docx') {
    const { importDocx } = await import('./docx')
    await importDocx(bytes, builder)
    if (options.language) builder.language = options.language
  } else {
    const { decodeText, importMarkdown, importText } = await import('./text')
    const text = decodeText(bytes)
    if (format === 'md') importMarkdown(text, builder)
    else importText(text, builder)
  }
  const fallbackTitle = fileName.replace(/^.*[\\/]/u, '').replace(/\.[^.]+$/u, '') || 'Import'
  return builder.build({ deviceId: options.deviceId ?? writerId(), fallbackTitle, now: options.now })
}
