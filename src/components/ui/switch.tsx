"use client"

import * as React from "react"
import * as SwitchPrimitive from "@radix-ui/react-switch"

import { cn } from "@/lib/utils"

/**
 * bkup Switch — RTL-proof by design, and theme-inversion-safe on the hero.
 *
 * GEOMETRY / RTL: the thumb is positioned with PHYSICAL `left` offsets inside
 * a `position:relative` track — physical properties are identical in LTR and
 * RTL, so the geometry can never flip or overflow.
 *   OFF → left: 2px                (thumb sits at the physical left)
 *   ON  → left: 44 − 20 − 2 = 22px (thumb sits at the physical right)
 *
 * VARIANTS:
 *   - "default"  — for regular cards: muted gray track when OFF, primary
 *                  track when ON; thumb follows the card surface.
 *   - "on-dark"  — for the dashboard hero card, whose surface FLIPS with the
 *                  app theme (near-black `bg-primary` in light, light graphite
 *                  #dcdce1 in dark). The switch mirrors that flip, so the DARK
 *                  theme is the exact INVERSE of the light one — same look,
 *                  colors swapped:
 *                    LIGHT theme  ON: white track + near-black knob
 *                    DARK  theme  ON: near-black track + white knob
 *                  This is built purely from the theme's own opposite pair:
 *                  ON track = `primary-foreground`, ON knob = `primary`.
 *                  `primary` and `primary-foreground` are definitionally
 *                  opposite in EVERY theme, so the knob can never blend into
 *                  its track — the old bug (fixed-white track painted over the
 *                  light hero in dark mode, with a knob of the same color)
 *                  is structurally impossible now.
 *                  OFF stays neutral: a frosted track (white frost on the dark
 *                  hero in light theme, black frost on the light hero in dark
 *                  theme) with the knob = `primary-foreground`, which flips in
 *                  lockstep with the hero surface.
 *                  OFF and ON styles are scoped to their own data-state so
 *                  they can never out-compete each other by stylesheet order
 *                  (equal-specificity variants resolve by order — that is
 *                  exactly how dark mode once painted ON toggles with the OFF
 *                  track).
 *
 * UX guarantees:
 *   - 44×44px tap target (the Root) — comfortable on touch devices
 *   - ON and OFF are unmistakable on light AND dark surfaces, in BOTH themes
 *   - Radix provides role="switch", aria-checked, keyboard & focus support
 */
function Switch({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root> & {
  /** "on-dark" = placed on the dashboard hero, whose surface flips with the theme. */
  variant?: "default" | "on-dark";
}) {
  const dark = variant === "on-dark";
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        // 44×44 tap target — the visible track is the inner span below
        "group inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full",
        "outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    >
      <span
        aria-hidden="true"
        data-slot="switch-track"
        className={cn(
          "relative block h-6 w-11 shrink-0 rounded-full transition-colors duration-200 ease-out",
          "shadow-[inset_0_1px_2px_rgba(0,0,0,0.08)]",
          dark ? (
            cn(
              // OFF on the hero surface: frosted track — white frost on the
              // dark hero (light theme), black frost on the light hero (dark
              // theme). Scoped to unchecked so it can never fight the ON
              // styles.
              "group-data-[state=unchecked]:bg-white/25 group-data-[state=unchecked]:dark:bg-black/20",
              // ON: primary-foreground — WHITE track on the dark hero (light
              // theme), near-BLACK track on the light hero (dark theme): the
              // dark theme is the exact inverse of the light one.
              "group-data-[state=checked]:bg-primary-foreground group-data-[state=checked]:shadow-[0_1px_6px_rgba(0,0,0,0.35)]"
            )
          ) : (
            cn(
              // OFF on light cards: muted — unchecked-only for the same
              // reason: OFF and ON styles must never fight each other.
              "group-data-[state=unchecked]:bg-input group-data-[state=unchecked]:dark:bg-input/80",
              // ON on light cards: primary (near-black / near-white in dark)
              "group-data-[state=checked]:bg-primary"
            )
          )
        )}
      >
        <SwitchPrimitive.Thumb
          data-slot="switch-thumb"
          className={cn(
            "pointer-events-none absolute left-[2px] top-1/2 block size-5 -translate-y-1/2 rounded-full",
            "transition-[left,background-color] duration-200 ease-out",
            "data-[state=checked]:left-[calc(100%-1.375rem)]",
            dark ? (
              cn(
                "bg-primary-foreground shadow-md",
                // ON knob = primary — always the opposite of its track
                // (near-black knob on the white track in light theme, white
                // knob on the near-black track in dark theme).
                "group-data-[state=checked]:bg-primary"
              )
            ) : (
              cn(
                "bg-background ring-1 ring-black/10 shadow-md dark:bg-foreground dark:data-[state=checked]:bg-primary-foreground"
              )
            )
          )}
        />
      </span>
    </SwitchPrimitive.Root>
  )
}

export { Switch }
