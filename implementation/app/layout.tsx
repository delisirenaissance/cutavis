import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "cutavis — pattern prototype",
  description: "Parse measurement formulas and render the pattern as SVG.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
