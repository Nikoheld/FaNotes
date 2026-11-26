// Builds the stand-alone writing mode and the headless handwriting recognition
// host (recognition.html) and copies them with its fonts,
// thesaurus and spelling data into the Android app's assets
// (android/app/src/main/assets/writing/). Run before assembling the app.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const app = fileURLToPath(new URL('..', import.meta.url))
const out = path.join(app, 'dist-writing')
const target = path.resolve(app, '../android/app/src/main/assets/writing')
execFileSync(process.execPath, [path.join(app, 'node_modules/vite/bin/vite.js'), 'build', '--config', 'vite.writing.config.ts', '--logLevel', 'warn'], { cwd: app, stdio: 'inherit' })
fs.rmSync(target, { recursive: true, force: true })
fs.mkdirSync(target, { recursive: true })
fs.cpSync(out, target, { recursive: true })
fs.cpSync(path.join(app, 'public', 'writing'), path.join(target, 'writing'), { recursive: true })
// The spelling data, French included: fr.bloom (about 0.7 MB) loads with the others and fr.words (about 5 MB, 1.1 MB
// compressed) is read only when a French passage needs suggestions, so the writing mode detects French like the desktop.
fs.cpSync(path.join(app, 'public', 'spell'), path.join(target, 'spell'), { recursive: true })
let bytes = 0
let files = 0
const walk = (dir) => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name); if (entry.isDirectory()) walk(full); else { files += 1; bytes += fs.statSync(full).size } } }
walk(target)
if (!fs.existsSync(path.join(target, 'writing.html')) || !fs.existsSync(path.join(target, 'recognition.html')) || !fs.existsSync(path.join(target, 'spell/manifest.json'))) throw new Error('Android writing bundle is incomplete')
console.log(`Android writing bundle: ${files} files, ${(bytes / 1048576).toFixed(1)} MB → ${path.relative(path.resolve(app, '..'), target)}`)
