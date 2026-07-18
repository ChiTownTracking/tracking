'use client';

import { useCallback, useEffect, useState } from 'react';

export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'chitown-dashboard-theme';

// App-wide chrome theme, applied as data-theme on <html> so the token
// overrides in globals.css cascade everywhere. Deliberately independent of
// FleetMap's tile style — light chrome with a dark map is a valid combo.
export function useTheme(): { theme: Theme; toggleTheme: () => void } {
  // Default light; the stored value is read in an effect (not the useState
  // initializer) because this component is prerendered without a window.
  const [theme, setTheme] = useState<Theme>('light');

  useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') {
      setTheme(stored);
    }
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    window.localStorage.setItem(STORAGE_KEY, theme);
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((current) => (current === 'dark' ? 'light' : 'dark'));
  }, []);

  return { theme, toggleTheme };
}
