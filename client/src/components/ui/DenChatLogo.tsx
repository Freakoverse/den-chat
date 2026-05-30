/**
 * DEN Chat Logo component — auto-switches between dark/light variants.
 * Uses Tailwind's `dark:` prefix to show the correct logo.
 */

interface DenChatLogoProps {
  /** Width and height in pixels */
  size?: number
  className?: string
}

export function DenChatLogo({ size = 64, className = '' }: DenChatLogoProps) {
  return (
    <div className={`relative ${className}`} style={{ width: size, height: size }}>
      {/* Dark mode: logo a (lighter logo on dark backgrounds) */}
      <img
        src="/logo-dark.png"
        alt="DEN Chat"
        className="hidden dark:block w-full h-full object-contain"
        width={size}
        height={size}
      />
      {/* Light mode: logo b (darker logo on light backgrounds) */}
      <img
        src="/logo-light.png"
        alt="DEN Chat"
        className="block dark:hidden w-full h-full object-contain"
        width={size}
        height={size}
      />
    </div>
  )
}
