import { create } from 'zustand'

export type AuthMethod = 'upv2' | 'pc55' | 'nip46' | 'nsec' | 'seed' | null

/**
 * Generic signer interface — any auth method that can sign events
 */
export interface ISigner {
  getPublicKey(): Promise<string>
  signEvent(draftEvent: Record<string, unknown>): Promise<Record<string, unknown>>
  nip04Encrypt?(pubkey: string, plainText: string): Promise<string>
  nip04Decrypt?(pubkey: string, cipherText: string): Promise<string>
  nip04?: {
    encrypt(pubkey: string, plaintext: string): Promise<string>
    decrypt(pubkey: string, ciphertext: string): Promise<string>
  }
  nip44?: {
    encrypt(pubkey: string, plaintext: string): Promise<string>
    decrypt(pubkey: string, ciphertext: string): Promise<string>
  }
  close?(): void
}

export interface UserState {
  isAuthenticated: boolean
  pubkey: string | null
  privateKey: string | null
  displayName: string | null
  dnnId: string | null
  avatar: string | null
  authMethod: AuthMethod
  localSignerName: string | null
  /** Active signer instance (PC55, Bunker, NostrConnect, UPV2) */
  signer: ISigner | null
  seedPhrase: string | null
  accountIndex: number

  login: (pubkey: string, method: AuthMethod, privateKey?: string | null) => void
  logout: () => void
  setProfile: (profile: { displayName?: string; avatar?: string; dnnId?: string }) => void
  setLocalSigner: (name: string | null) => void
  setSigner: (signer: ISigner | null) => void
  setSeedPhrase: (phrase: string | null) => void
  setAccountIndex: (index: number) => void
}

export const useUserStore = create<UserState>((set) => ({
  isAuthenticated: false,
  pubkey: null,
  privateKey: null,
  displayName: null,
  dnnId: null,
  avatar: null,
  authMethod: null,
  localSignerName: null,
  signer: null,
  seedPhrase: null,
  accountIndex: 0,

  login: (pubkey, method, privateKey = null) =>
    set({ isAuthenticated: true, pubkey, authMethod: method, privateKey }),

  logout: () => {
    const currentState = useUserStore.getState()
    if (currentState.signer?.close) {
      currentState.signer.close()
    }

    set({
      isAuthenticated: false,
      pubkey: null,
      privateKey: null,
      displayName: null,
      dnnId: null,
      avatar: null,
      authMethod: null,
      signer: null,
      seedPhrase: null,
      accountIndex: 0,
    })
  },

  setProfile: (profile) =>
    set((state) => ({
      displayName: profile.displayName ?? state.displayName,
      avatar: profile.avatar ?? state.avatar,
      dnnId: profile.dnnId ?? state.dnnId,
    })),

  setLocalSigner: (name) => set({ localSignerName: name }),
  setSigner: (signer) => set({ signer }),
  setSeedPhrase: (phrase) => set({ seedPhrase: phrase }),
  setAccountIndex: (index) => set({ accountIndex: index }),
}))
