import { useEffect, useState } from "react"

export type Theme = "dark" | "light"

function stored(): Theme {
  try {
    return localStorage.getItem("theme") === "light" ? "light" : "dark"
  } catch {
    return "dark"
  }
}

/** Dark by default; the choice is remembered per browser. */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(stored)
  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark")
    try {
      localStorage.setItem("theme", theme)
    } catch {
      // Private mode: the theme just isn't remembered.
    }
  }, [theme])
  return { theme, toggle: () => setTheme((t) => (t === "dark" ? "light" : "dark")) }
}
