// SPDX-License-Identifier: Apache-2.0

import type { Metadata } from "next";
import { Hanken_Grotesk, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { DemoProvider } from "@/lib/store";
import { GlobalToaster } from "@/components/app-shell";

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

export const metadata: Metadata = {
  title: "Dashboard · DataBounty Community",
  description:
    "Your DataBounty Community dashboard — create requests, claim task batches, audit submissions, and build karma.",
  alternates: {
    types: { "text/markdown": [{ url: "/llms.txt", title: "DataBounty for LLMs" }] },
  },
  icons: {
    icon: [
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${hankenSans.variable} ${jetbrainsMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">
        <DemoProvider>
          {children}
          <GlobalToaster />
        </DemoProvider>
      </body>
    </html>
  );
}
