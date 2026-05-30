/**
 * Ambient module declarations for optional voice dependencies.
 *
 * These packages are dynamically imported at runtime only when the user
 * selects a provider that requires them. They are NOT bundled by default.
 */

// LiveKit client SDK — required for self-hosted LiveKit SFU
declare module 'livekit-client' {
  const Room: any
  const RoomEvent: any
  const Track: any
  export { Room, RoomEvent, Track }
  export default any
}

// jose — JWT library for LiveKit token generation
declare module 'jose' {
  export class SignJWT {
    constructor(payload: Record<string, any>)
    setProtectedHeader(header: Record<string, any>): SignJWT
    sign(secret: Uint8Array): Promise<string>
  }
}
