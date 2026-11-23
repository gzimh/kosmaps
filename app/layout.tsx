import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Small Prishtinë — live prototype",
  description: "An illustrated, live miniature map of Prishtinë.",
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
