const IMAGE_NAME = /\.(png|jpe?g|gif|webp)$/iu

type ClipboardFileItem = {
  kind: string
  type: string
  getAsFile: () => File | null
}

export type ClipboardImageSource = {
  files: Iterable<File>
  items: Iterable<ClipboardFileItem>
  getData: (type: string) => string
}

const isImageFile = (file: File) => file.type.startsWith('image/') || (!file.type && IMAGE_NAME.test(file.name))

/**
 * An image from a paste or drop, when the clipboard has no text to insert.
 * Screenshots often sit only on `items`, and the editor would otherwise swallow the paste.
 */
export const clipboardImageFile = (data: ClipboardImageSource | null): File | null => {
  if (!data) return null
  let plain = ''
  try {
    plain = data.getData('text/plain')
  } catch {
    plain = ''
  }
  if (plain.trim()) return null
  const fromFiles = [...data.files].find(isImageFile)
  if (fromFiles) return fromFiles
  for (const item of data.items) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue
    const file = item.getAsFile()
    if (file) return file
  }
  return null
}
