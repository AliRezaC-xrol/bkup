"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";

/**
 * Class-based theme provider: light is the default, the OS preference is
 * respected until the user explicitly flips the in-panel toggle.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      {children}
    </NextThemesProvider>
  );
}
