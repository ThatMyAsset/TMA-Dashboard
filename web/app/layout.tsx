import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "TMA Control Center", template: "%s · TMA Control Center" },
  description: "Administer AI data-loss-prevention devices, policies, and metadata-only security activity."
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, colorScheme: "light", themeColor: "#f6f8fa" };

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <html lang="en" data-type="software"><head><meta name="page-type" content="software" /><meta name="site-kind" content="software" /></head><body>{children}</body></html>;
}
