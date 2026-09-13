import type { MetadataRoute } from "next";

/**
 * PWA web manifest — makes the panel installable on phones/desktops
 * ("Add to Home Screen"), so the operator gets a native-feeling window
 * with the bkup icon instead of a bare browser tab.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "bkup — Telegram Panel Backups",
    short_name: "bkup",
    description:
      "Automatic backups of 3x-ui, HMPanel, PasarGuard and Rebecca panels to Telegram — with in-panel restore.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait-primary",
    background_color: "#ffffff",
    theme_color: "#ffffff",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
