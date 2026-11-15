import { useEffect, useState, type ImgHTMLAttributes } from 'react'
import { resolveStudyImage } from '../../lib/study/imageTools'

/** An <img> for a stored picture reference: a vault file path or a legacy data URL. */
export function VaultImg({ src, alt = '', ...props }: { src: string } & ImgHTMLAttributes<HTMLImageElement>) {
  const [url, setUrl] = useState('')
  useEffect(() => {
    let live = true
    setUrl('')
    void resolveStudyImage(src).then((value) => { if (live) setUrl(value) }).catch(() => undefined)
    return () => { live = false }
  }, [src])
  return url ? <img {...props} alt={alt} src={url} /> : <div className={`${props.className ?? ''} study-plate-empty`.trim()} role="img" aria-label={alt} />
}
