import { Globe, Monitor } from 'lucide-react'
import { isTauri } from '@/lib/utils'

/**
 * Sites — in-client DNN browser. Placeholder "coming soon" surface.
 * On web/PWA it additionally notes the feature is desktop-only.
 */
export function SitesPage() {
  const isDesktop = isTauri()

  return (
    <div className="flex-1 flex flex-col items-center justify-center min-h-0 overflow-y-auto bg-background p-6 text-center">
      <div className="w-full max-w-md flex flex-col items-center gap-4">
        <div className="h-16 w-16 rounded-2xl bg-primary/10 flex items-center justify-center">
          <Globe size={30} className="text-primary" />
        </div>

        <div className="space-y-1.5">
          <h1 className="text-2xl font-bold text-foreground">Sites</h1>
          <span className="inline-block px-2.5 py-1 rounded-full text-[11px] font-semibold uppercase tracking-wider bg-primary/15 text-primary">
            Coming soon
          </span>
        </div>

        <p className="text-sm text-muted-foreground leading-relaxed">
          A built-in browser for opening DNN sites — decentralized domains with their own
          self-verified certificates — right inside DEN Chat.
        </p>

        {!isDesktop && (
          <div className="mt-2 w-full flex items-start gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-left">
            <Monitor size={16} className="text-amber-500 shrink-0 mt-0.5" />
            <p className="text-xs text-amber-500/90 leading-relaxed">
              This view is only available in the installed desktop app. Download DEN Chat for
              your computer to browse DNN sites once it's ready.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
