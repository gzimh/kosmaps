import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Marigona — live",
  description: "Marigona, illustrated, with live sun, weather and traffic.",
  // Private prototype built on Google-derived imagery: keep it out of search engines.
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
