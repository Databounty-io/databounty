// SPDX-License-Identifier: Apache-2.0

import type { Metadata, Viewport } from "next";
import { Bricolage_Grotesque, Hanken_Grotesk, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { LANDING_URL } from "@/lib/urls";
import { ExtensionErrorShield } from "@/components/extension-error-shield";

// Design system fonts (Hanken Grotesk + JetBrains Mono + Bricolage Grotesque).
const hankenSans = Hanken_Grotesk({
  variable: "--font-geist-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  weight: ["400", "500", "700"],
});

// Display face for hero/headline moments (the wordmark itself is an SVG asset).
const bricolage = Bricolage_Grotesque({
  variable: "--font-display",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
});

const SITE_NAME = "DataBounty";
const TITLE = "DataBounty: open coding datasets, built by the community";
const DESCRIPTION =
  "Claim a dataset spec, submit verified items, earn karma and named credit. Finished datasets publish to Hugging Face. Request the dataset your team needs and the community builds it.";

export const metadata: Metadata = {
  metadataBase: new URL(LANDING_URL),
  title: { default: TITLE, template: `%s · ${SITE_NAME}` },
  description: DESCRIPTION,
  keywords: [
    "coding datasets",
    "training data",
    "dataset bounty",
    "verified code data",
    "LLM training data",
    "dataset marketplace",
  ],
  alternates: {
    canonical: "/",
    types: { "text/markdown": [{ url: "/llms.txt", title: "DataBounty for LLMs" }] },
  },
  robots: { index: true, follow: true },
  icons: {
    icon: [
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
  },
  openGraph: {
    type: "website",
    url: "/",
    siteName: SITE_NAME,
    title: TITLE,
    description: DESCRIPTION,
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0a0c0a",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${hankenSans.variable} ${jetbrainsMono.variable} ${bricolage.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">
        <ExtensionErrorShield />
        {children}
      </body>
    </html>
  );
}
