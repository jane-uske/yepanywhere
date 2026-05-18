import { useCallback, useEffect, useState } from "react";
import { UI_KEYS } from "../lib/storageKeys";

export type Theme = "auto" | "light" | "dark" | "verydark";

const themeLabels: Record<Theme, string> = {
  auto: "Auto",
  light: "Light",
  dark: "Dark",
  verydark: "Very Dark",
};

export const THEMES: Theme[] = ["auto", "light", "dark", "verydark"];

export function getThemeLabel(theme: Theme): string {
  return themeLabels[theme];
}

const THEME_COLORS = {
  verydark: "#000000",
  dark: "#161617",
  light: "#f5f5f7",
  auto: "#161617",
} satisfies Record<Theme, string>;

function getThemeColor(theme: Theme): string {
  if (theme === "auto") {
    return window.matchMedia("(prefers-color-scheme: light)").matches
      ? THEME_COLORS.light
      : THEME_COLORS.dark;
  }
  return THEME_COLORS[theme];
}

function updateThemeColorMeta(theme: Theme) {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    meta.setAttribute("content", getThemeColor(theme));
  }
}

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.setAttribute("data-theme", theme);
  updateThemeColorMeta(theme);
}

function loadTheme(): Theme {
  const stored = localStorage.getItem(UI_KEYS.theme);
  if (stored && THEMES.includes(stored as Theme)) {
    return stored as Theme;
  }
  return "auto";
}

function saveTheme(theme: Theme) {
  localStorage.setItem(UI_KEYS.theme, theme);
}

/**
 * Hook to manage theme preference.
 * Persists to localStorage and applies data-theme attribute.
 */
export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(loadTheme);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const setTheme = useCallback((newTheme: Theme) => {
    setThemeState(newTheme);
    saveTheme(newTheme);
  }, []);

  return { theme, setTheme };
}

/**
 * Initialize theme on app load (call once at startup).
 * This runs before React renders to avoid flash of wrong theme.
 */
export function initializeTheme() {
  const theme = loadTheme();
  applyTheme(theme);
}

/**
 * Get current resolved theme (useful for components that need
 * to know if we're actually in light or dark mode when auto)
 */
export function getResolvedTheme(): "light" | "dark" {
  const stored = loadTheme();
  if (stored === "auto") {
    return window.matchMedia("(prefers-color-scheme: light)").matches
      ? "light"
      : "dark";
  }
  return stored === "light" ? "light" : "dark";
}

/**
 * Hook to reactively get the resolved theme (light or dark).
 * Listens for both localStorage changes and system preference changes.
 */
export function useResolvedTheme(): "light" | "dark" {
  const [resolved, setResolved] = useState<"light" | "dark">(getResolvedTheme);

  useEffect(() => {
    const update = () => setResolved(getResolvedTheme());

    // Listen for system preference changes
    const mediaQuery = window.matchMedia("(prefers-color-scheme: light)");
    mediaQuery.addEventListener("change", update);

    // Listen for storage changes (theme changed in another tab or by useTheme)
    window.addEventListener("storage", update);

    // Also listen for attribute changes on documentElement (for same-tab updates)
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (
          mutation.type === "attributes" &&
          mutation.attributeName === "data-theme"
        ) {
          update();
          break;
        }
      }
    });
    observer.observe(document.documentElement, { attributes: true });

    return () => {
      mediaQuery.removeEventListener("change", update);
      window.removeEventListener("storage", update);
      observer.disconnect();
    };
  }, []);

  return resolved;
}
