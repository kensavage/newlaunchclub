import type { Metadata } from "next";
import { Caveat, Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap"
});

const caveat = Caveat({
  subsets: ["latin"],
  variable: "--font-caveat",
  display: "swap"
});

export const metadata: Metadata = {
  metadataBase: new URL("https://launchclub.ai"),
  title: "AI Search Opportunity Report | Launch Club",
  description:
    "See where your website can get discovered on Reddit and cited in AI search answers.",
  icons: {
    icon: "/favicon.png"
  },
  openGraph: {
    title: "AI Search Opportunity Report | Launch Club",
    description:
      "A browser-rendered report showing keyword, Reddit, and AI-search visibility opportunities.",
    images: ["/og-image.png"]
  }
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" data-scroll-behavior="smooth">
      <body className={`${inter.variable} ${caveat.variable}`}>{children}</body>
    </html>
  );
}
