import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

export const metadata: Metadata = {
  title: "bkup",
  description:
    "bkup — automatic backups of 3x-ui, HM Panel and PasarGuard panels delivered to Telegram. Scheduler, password-protected web panel, CLI and one-command updates.",
  icons: {
    icon: "/logo-mark.png",
  },
};

export const viewport: Viewport = {
  themeColor: "#ffffff",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" dir="ltr" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://cdn.jsdelivr.net" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://cdn.jsdelivr.net/npm/@fontsource/inter@5.2.5/index.min.css"
        />
      </head>
      <body className="antialiased bg-background text-foreground min-h-screen font-en">
        {children}
        <Toaster />
      </body>
    </html>
  );
}
