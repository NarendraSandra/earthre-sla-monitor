import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "EarthRe SLA Monitor",
  description: "Operational availability and data-quality monitoring for service health checks.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
