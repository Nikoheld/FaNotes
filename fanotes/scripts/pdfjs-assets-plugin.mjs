import { cpSync, createReadStream, existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const PDFJS_ASSET_DIRECTORIES = ['cmaps', 'standard_fonts', 'wasm', 'iccs']

const MIME = {
  '.bcmap': 'application/octet-stream',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.pfb': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.icc': 'application/vnd.iccprofile',
  '.js': 'text/javascript; charset=utf-8',
}

export const pdfjsPackageRoot = (appRoot) => path.resolve(appRoot, 'node_modules/pdfjs-dist')

/** A single file under pdfjs/<directory>/<name>, or null when the request is not an asset. */
export const pdfjsAssetPath = (requestUrl, packageRoot) => {
  const pathname = decodeURIComponent(String(requestUrl || '').split('?')[0])
  if (!pathname.startsWith('/pdfjs/')) return null
  const parts = pathname.slice('/pdfjs/'.length).split('/')
  if (parts.length !== 2) return null
  const [directory, name] = parts
  if (!PDFJS_ASSET_DIRECTORIES.includes(directory)) return null
  if (!/^[A-Za-z0-9._-]+$/u.test(name) || name === '.' || name === '..') return null
  const root = path.resolve(packageRoot, directory)
  const file = path.resolve(root, name)
  if (!file.startsWith(`${root}${path.sep}`)) return null
  return file
}

export const copyPdfjsAssets = (appRoot, outDir) => {
  const packageRoot = pdfjsPackageRoot(appRoot)
  const destination = path.resolve(outDir, 'pdfjs')
  for (const directory of PDFJS_ASSET_DIRECTORIES) {
    const source = path.join(packageRoot, directory)
    if (!existsSync(source)) throw new Error(`pdf.js asset directory is missing: ${source}`)
    cpSync(source, path.join(destination, directory), { recursive: true })
  }
}

export const pdfjsAssetsPlugin = () => {
  let appRoot = path.dirname(fileURLToPath(import.meta.url))
  let outDir = path.resolve(appRoot, '..', 'dist')
  return {
    name: 'fanotes-pdfjs-assets',
    configResolved(config) {
      appRoot = config.root
      outDir = path.resolve(config.root, config.build.outDir)
    },
    configureServer(server) {
      const packageRoot = pdfjsPackageRoot(appRoot)
      server.middlewares.use((request, response, next) => {
        const file = pdfjsAssetPath(request.url, packageRoot)
        if (!file) {
          next()
          return
        }
        if (!existsSync(file) || !statSync(file).isFile()) {
          response.statusCode = 404
          response.end()
          return
        }
        const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
        response.setHeader('Content-Type', type)
        response.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
        createReadStream(file).pipe(response)
      })
    },
    closeBundle() {
      copyPdfjsAssets(appRoot, outDir)
    },
  }
}
