// Reference hasher for MEX spec files.
//
// Computes the SHA-256 over an MEX file's canonicalized SIGNED REGION, exactly as defined in MEX-CORE
// (File Format > Canonicalization). Use it to (re)compute `file_sha256` whenever the signed region
// changes, e.g. after inserting the real author npub or a predecessor's signature.
//
// Usage:  node docs/MEX/mex-hash.mjs docs/MEX/MEX-0.md
//
// The signed region is the content strictly between the lines:
//   <!-- MEX-SIGNED-REGION-START -->
//   <!-- MEX-SIGNED-REGION-END -->
// Canonicalization: UTF-8 (BOM dropped), EOLs normalized to LF, trailing spaces/tabs stripped per line,
// trailing blank lines reduced to exactly one LF. The seal (file_sha256 + signature) sits AFTER the end
// marker and is excluded, so writing it never changes the hash.

import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const START = '<!-- MEX-SIGNED-REGION-START -->'
const END = '<!-- MEX-SIGNED-REGION-END -->'

const path = process.argv[2]
if (!path) { console.error('usage: node mex-hash.mjs <file>'); process.exit(2) }

let text = readFileSync(path, 'utf8')
if (text.charCodeAt(0) === 0xfeff) text = text.slice(1) // drop BOM

const lines = text.split(/\r\n|\r|\n/)
const startIdx = lines.findIndex((l) => l.trim() === START)
const endIdx = lines.findIndex((l, i) => i > startIdx && l.trim() === END)
if (startIdx === -1 || endIdx === -1) { console.error('signed-region markers not found'); process.exit(1) }

const inner = lines.slice(startIdx + 1, endIdx).map((l) => l.replace(/[ \t]+$/, ''))
const canon = inner.join('\n').replace(/\n+$/, '') + '\n'

console.log(createHash('sha256').update(Buffer.from(canon, 'utf8')).digest('hex'))
