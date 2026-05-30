/**
 * rnnoise — Helper to load and create an RNNoise AudioWorklet node
 *
 * Uses @sapphi-red/web-noise-suppressor which provides a ready-to-use
 * RnnoiseWorkletNode backed by the xiph/rnnoise WASM port.
 *
 * RNNoise requires 48kHz sample rate. The AudioContext must be created
 * with { sampleRate: 48000 } for proper operation.
 */

import { RnnoiseWorkletNode, loadRnnoise } from '@sapphi-red/web-noise-suppressor'
// Vite ?url imports — gets the URL to the worklet JS and WASM files
// so they can be loaded at runtime from the correct path.
import rnnoiseWorkletPath from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url'
import rnnoiseWasmPath from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url'
import rnnoiseWasmSimdPath from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url'

let wasmBinaryCache: ArrayBuffer | null = null

/**
 * Create an RNNoise noise suppression AudioWorkletNode.
 *
 * Must be called AFTER the AudioContext is created.
 * The AudioContext should use sampleRate: 48000.
 *
 * @returns The RnnoiseWorkletNode (connect source → node → destination)
 */
export async function createRnnoiseNode(ctx: AudioContext): Promise<RnnoiseWorkletNode> {
  // Load WASM binary (cached after first load — ~150KB)
  if (!wasmBinaryCache) {
    wasmBinaryCache = await loadRnnoise({
      url: rnnoiseWasmPath,
      simdUrl: rnnoiseWasmSimdPath,
    })
  }

  // Register the AudioWorklet processor
  await ctx.audioWorklet.addModule(rnnoiseWorkletPath)

  // Create and return the node
  return new RnnoiseWorkletNode(ctx, {
    maxChannels: 1,
    wasmBinary: wasmBinaryCache,
  })
}
