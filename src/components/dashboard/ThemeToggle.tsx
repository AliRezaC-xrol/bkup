"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLang } from "@/components/dashboard/lang";

/**
 * Light/dark switch — renders an inert placeholder until mounted so the
 * server HTML and the first client render always agree.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const { t } = useLang();

  useEffect(() => {
    // mark hydration done after paint — avoids the SSR/CSR mismatch when
    // next-themes resolves the stored/system theme
    const raf = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  const dark = mounted && resolvedTheme === "dark";
  const label = mounted ? (dark ? t("theme_to_light") : t("theme_to_dark")) : "";

  return (
    <Button
      variant="outline"
      size="icon"
      className={className}
      aria-label={label}
      title={label}
      onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
    >
      {/* both icons occupy the same spot; scale/rotate crossfades between them
          so there is no layout shift when the stored theme resolves */}
      <span className="relative hidden h-4 w-4 sm:flex">
        <Sun className={`absolute inset-0 m-auto h-4 w-4 transition-all duration-300 ${dark ? "scale-0 -rotate-90" : "scale-100 rotate-0"}`} />
        <Moon className={`absolute inset-0 m-auto h-4 w-4 transition-all duration-300 ${dark ? "scale-100 rotate-0" : "scale-0 rotate-90"}`} />
      </span>
      <span className="sr-only">{label}</span>
    </Button>
  );
}
