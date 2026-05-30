/**
 * bump-version.mjs — Update the app version across all config files.
 *
 * Usage:
 *   node scripts/bump-version.mjs 0.2.0
 *
 * Files updated:
 *   - client/package.json
 *   - client/package-lock.json (top-level version fields)
 *   - src-tauri/tauri.conf.json
 *   - src-tauri/Cargo.toml
 *   - client/public/version.json
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

const newVersion = process.argv[2]

if (!newVersion || !/^\d+\.\d+\.\d+/.test(newVersion)) {
  console.error('Usage: node scripts/bump-version.mjs <version>')
  console.error('Example: node scripts/bump-version.mjs 0.2.0')
  process.exit(1)
}

const files = []

// 1. client/package.json
const pkgPath = path.join(root, 'client/package.json')
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
const oldVersion = pkg.version
pkg.version = newVersion
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
files.push('client/package.json')

// 2. client/package-lock.json (top-level "version" and packages[""].version)
const lockPath = path.join(root, 'client/package-lock.json')
if (fs.existsSync(lockPath)) {
  let lockContent = fs.readFileSync(lockPath, 'utf-8')
  const lock = JSON.parse(lockContent)
  lock.version = newVersion
  if (lock.packages?.['']) {
    lock.packages[''].version = newVersion
  }
  fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n')
  files.push('client/package-lock.json')
}

// 3. src-tauri/tauri.conf.json
const tauriPath = path.join(root, 'src-tauri/tauri.conf.json')
if (fs.existsSync(tauriPath)) {
  const tauri = JSON.parse(fs.readFileSync(tauriPath, 'utf-8'))
  tauri.version = newVersion
  fs.writeFileSync(tauriPath, JSON.stringify(tauri, null, 2) + '\n')
  files.push('src-tauri/tauri.conf.json')
}

// 4. src-tauri/Cargo.toml
const cargoPath = path.join(root, 'src-tauri/Cargo.toml')
if (fs.existsSync(cargoPath)) {
  let cargo = fs.readFileSync(cargoPath, 'utf-8')
  cargo = cargo.replace(/^version\s*=\s*"[^"]*"/m, `version = "${newVersion}"`)
  fs.writeFileSync(cargoPath, cargo)
  files.push('src-tauri/Cargo.toml')
}

// 5. client/public/version.json
const versionJsonPath = path.join(root, 'client/public/version.json')
fs.writeFileSync(versionJsonPath, JSON.stringify({ version: newVersion }) + '\n')
files.push('client/public/version.json')

console.log(`\n  Version bumped: ${oldVersion} → ${newVersion}\n`)
files.forEach(f => console.log(`  ✓ ${f}`))
console.log()
