import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
// import basicSsl from '@vitejs/plugin-basic-ssl'  // Disabled: self-signed certs break outbound fetch() to blossom/relays

/** Vite dev-server middleware: proxy blossom media requests to bypass CORS */
function blossomProxy(): Plugin {
  return {
    name: 'blossom-proxy',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/__blossom_proxy')) return next()
        const parsed = new URL(req.url, 'http://localhost')
        const targetUrl = parsed.searchParams.get('url')
        if (!targetUrl) { res.writeHead(400); res.end('Missing url'); return }

        try {
          const upstream = await globalThis.fetch(targetUrl)
          if (!upstream.ok) { res.writeHead(upstream.status); res.end(); return }
          const buf = Buffer.from(await upstream.arrayBuffer())
          res.writeHead(200, {
            'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
            'Content-Length': buf.length.toString(),
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=86400',
          })
          res.end(buf)
        } catch {
          res.writeHead(502); res.end('Upstream failed')
        }
      })
    },
  }
}


import pkg from './package.json'

export default defineConfig({
  plugins: [react(), tailwindcss(), blossomProxy()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // @noble/hashes exports use ".js" suffixes that Vite 8 doesn't auto-resolve.
      '@noble/hashes/hmac': path.resolve(__dirname, 'node_modules/@noble/hashes/hmac.js'),
      '@noble/hashes/sha256': path.resolve(__dirname, 'node_modules/@noble/hashes/sha2.js'),
      '@noble/hashes/sha2': path.resolve(__dirname, 'node_modules/@noble/hashes/sha2.js'),
      '@noble/hashes/utils': path.resolve(__dirname, 'node_modules/@noble/hashes/utils.js'),
      '@noble/hashes/hkdf': path.resolve(__dirname, 'node_modules/@noble/hashes/hkdf.js'),
      '@noble/hashes/sha3': path.resolve(__dirname, 'node_modules/@noble/hashes/sha3.js'),
      // @noble/curves exports also use ".js" suffixes
      '@noble/curves/secp256k1': path.resolve(__dirname, 'node_modules/@noble/curves/secp256k1.js'),
      // @scure/bip39 wordlists
      '@scure/bip39/wordlists/english': path.resolve(__dirname, 'node_modules/@scure/bip39/wordlists/english.js'),
    },
  },
  server: {
    port: 5173,
    strictPort: false,
  },
})
