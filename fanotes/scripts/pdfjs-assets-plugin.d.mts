import type { Plugin } from 'vite'

export const PDFJS_ASSET_DIRECTORIES: readonly string[]
export function pdfjsPackageRoot(appRoot: string): string
export function pdfjsAssetPath(requestUrl: string | undefined, packageRoot: string): string | null
export function copyPdfjsAssets(appRoot: string, outDir: string): void
export function pdfjsAssetsPlugin(): Plugin
