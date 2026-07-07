import type { Metadata } from "next";
import "./globals.css";

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
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
