// SPDX-License-Identifier: Apache-2.0

import type { Metadata } from "next";
import { Hanken_Grotesk, JetBrains_Mono } from "next/font/google";
import Script from "next/script";
import "./globals.css";
import { AdminAuthProvider } from "@/lib/admin-auth";
import { AdminToastProvider } from "@/lib/admin-toast";
import { AdminGlobalToaster } from "@/components/admin-shell";

// Design system fonts. Variable names kept so every downstream
// font-sans/font-mono reference picks them up unchanged.
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
  title: "Admin Console · DataBounty",
  description:
    "DataBounty community admin console — manage datasets, activity, open programs, leaderboard, issues, health, and audit logs.",
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
        <Script src="https://accounts.google.com/gsi/client" strategy="afterInteractive" />
        <AdminAuthProvider>
          <AdminToastProvider>
            {children}
            <AdminGlobalToaster />
          </AdminToastProvider>
        </AdminAuthProvider>
      </body>
    </html>
  );
}
