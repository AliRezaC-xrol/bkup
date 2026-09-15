"use client"

import * as React from "react"
import * as SwitchPrimitive from "@radix-ui/react-switch"

import { cn } from "@/lib/utils"

/**
 * bkup Switch — RTL-proof by design.
 *
 * ROOT CAUSE (fixed in v4.1.0): the old implementation moved the thumb with
 * `translate-x-[calc(100%-2px)]` inside a direction-aware flex parent.
 * In RTL (Persian) flex places the thumb at the RIGHT edge of the track,
 * while a positive translate still pushes it to the physical RIGHT —
 * so in the checked state the thumb escaped the track entirely and the
 * switch looked broken/ambiguous. CSS transforms are NOT direction-aware;
 * flex layout IS.
 *
 * THE FIX: the thumb is positioned with PHYSICAL `left` offsets inside a
 * `position:relative` track. Physical properties are identical in LTR and
 * RTL, so the geometry can never flip or overflow again.
 *
 * Geometry (track 44×24px, thumb 20px, 2px inner inset on both sides):
 *   OFF → left: 2px                (thumb sits at the physical left)
 *   ON  → left: 44 − 20 − 2 = 22px (thumb sits at the physical right)
 *
 * VARIANTS:
 *   - "default"  — for light cards: muted gray track when OFF, solid
 *                  near-black (primary) track when OFF→ON. White thumb.
 *   - "on-dark"  — for the dashboard hero card, whose surface FLIPS with the
 *                  app theme (near-black `bg-primary` in light, light graphite
 *                  in dark). The switch therefore adapts per theme:
 *                  OFF = frosted track (white frost on the dark surface, soft
 *                  black frost on the light one) with a white thumb,
 *                  ON = solid WHITE track with a FIXED near-black thumb.
 *                  The ON thumb must never be `bg-primary`: primary inverts to
 *                  near-white in the app's dark theme, which painted a white
 *                  knob on the white track — invisible (reported bug).
 *                  Monochrome, unmistakable, same geometry.
 *
 * UX guarantees:
 *   - 44×44px tap target (the Root) — comfortable on iPad / touch
 *   - ON and OFF are visually unmistakable on light AND dark surfaces
 *   - Radix provides role="switch", aria-checked, keyboard & focus support
 */
function Switch({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root> & {
  /** "on-dark" = placed on a dark/primary surface (e.g. the dashboard hero). */
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
              // OFF on the hero surface: frosted track. The hero surface itself
              // flips with the app theme (near-black in light, light graphite
              // in dark), so the frost flips with it: white frost on the dark
              // surface, soft black frost on the light one. Scoped to the
              // unchecked state so it can never out-compete the checked style
              // (equal-specificity variants resolve by stylesheet order — that
              // is exactly how dark mode ended up painting ON toggles with the
              // dark OFF track).
              "group-data-[state=unchecked]:bg-white/25 group-data-[state=unchecked]:dark:bg-black/20",
              // ON on the hero surface: solid white track — full inversion
              "group-data-[state=checked]:bg-white group-data-[state=checked]:shadow-[0_1px_6px_rgba(0,0,0,0.35)]"
            )
          ) : (
            cn(
              // OFF on light: unmistakably muted — unchecked-only for the same
              // reason: OFF and ON styles must never fight each other.
              "group-data-[state=unchecked]:bg-input group-data-[state=unchecked]:dark:bg-input/80",
              // ON on light: unmistakably primary (near-black / near-white in dark)
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
                "bg-white shadow-md",
                // ON: FIXED near-black thumb on the white track. Deliberately
                // NOT bg-primary — primary flips to near-white in the app's
                // dark theme, which produced a white knob on a white track
                // (invisible switch, the exact reported dark-mode bug).
                "group-data-[state=checked]:bg-black"
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
