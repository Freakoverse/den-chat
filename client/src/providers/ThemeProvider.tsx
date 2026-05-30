import { PRIMARY_COLORS, StorageKey, type TPrimaryColor, type TTheme, type TThemeSetting } from '@/lib/constants'
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

interface ThemeProviderState {
  themeSetting: TThemeSetting
  setThemeSetting: (setting: TThemeSetting) => void
  primaryColor: TPrimaryColor
  setPrimaryColor: (color: TPrimaryColor) => void
}

const ThemeProviderContext = createContext<ThemeProviderState | undefined>(undefined)

function updateCSSVariables(color: TPrimaryColor, currentTheme: TTheme) {
  const root = document.documentElement
  const colorConfig = PRIMARY_COLORS[color] ?? PRIMARY_COLORS.DEFAULT
  const config = currentTheme === 'light' ? colorConfig.light : colorConfig.dark

  root.style.setProperty('--primary', config.primary)
  root.style.setProperty('--primary-hover', config['primary-hover'])
  root.style.setProperty('--primary-foreground', config['primary-foreground'])
  root.style.setProperty('--ring', config.ring)
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [themeSetting, setThemeSetting] = useState<TThemeSetting>(
    (localStorage.getItem(StorageKey.THEME_SETTING) as TThemeSetting) ?? 'dark'
  )
  const [theme, setTheme] = useState<TTheme>('dark')
  const [primaryColor, setPrimaryColor] = useState<TPrimaryColor>(
    (localStorage.getItem(StorageKey.PRIMARY_COLOR) as TPrimaryColor) ?? 'DEFAULT'
  )

  // Resolve theme setting → actual theme
  useEffect(() => {
    if (themeSetting !== 'system') {
      setTheme(themeSetting)
      return
    }
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    const handleChange = (e: MediaQueryListEvent) => setTheme(e.matches ? 'dark' : 'light')
    mediaQuery.addEventListener('change', handleChange)
    setTheme(mediaQuery.matches ? 'dark' : 'light')
    return () => mediaQuery.removeEventListener('change', handleChange)
  }, [themeSetting])

  // Apply theme class to <html>
  useEffect(() => {
    const root = document.documentElement
    root.classList.remove('light', 'dark', 'pure-black')
    root.classList.add(theme === 'pure-black' ? 'dark' : theme)
    if (theme === 'pure-black') {
      root.classList.add('pure-black')
    }
  }, [theme])

  // Apply primary color CSS variables
  useEffect(() => {
    updateCSSVariables(primaryColor, theme)
  }, [theme, primaryColor])

  const updateThemeSetting = (setting: TThemeSetting) => {
    localStorage.setItem(StorageKey.THEME_SETTING, setting)
    setThemeSetting(setting)
  }

  const updatePrimaryColor = (color: TPrimaryColor) => {
    localStorage.setItem(StorageKey.PRIMARY_COLOR, color)
    setPrimaryColor(color)
  }

  return (
    <ThemeProviderContext.Provider
      value={{
        themeSetting,
        setThemeSetting: updateThemeSetting,
        primaryColor,
        setPrimaryColor: updatePrimaryColor,
      }}
    >
      {children}
    </ThemeProviderContext.Provider>
  )
}

export function useTheme() {
  const context = useContext(ThemeProviderContext)
  if (!context) throw new Error('useTheme must be used within a ThemeProvider')
  return context
}
