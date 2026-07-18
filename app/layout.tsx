import type { Metadata } from "next";
import { Space_Grotesk, Inter, IBM_Plex_Mono, Fraunces } from "next/font/google";
import "./globals.css";

// Staff/dispatch typography.
const spaceGrotesk = Space_Grotesk({
  variable: "--font-space-grotesk",
  subsets: ["latin"],
});

// Body/UI for the dispatch theme, reused as-is for customer body text.
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const ibmPlexMono = IBM_Plex_Mono({
  variable: "--font-ibm-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

// Customer-facing display/heading font — see .customer-heading in globals.css.
const fraunces = Fraunces({
  variable: "--font-customer-heading",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "ChiTown Fleet Tracking",
  description: "Live fleet tracking for ChiTown Tracking",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      // Matches useTheme's light default so the pre-hydration first paint
      // isn't a dark flash (the CSS tokens' no-attribute default is dark);
      // useTheme re-stamps this on mount from the stored preference.
      data-theme="light"
      className={`${spaceGrotesk.variable} ${inter.variable} ${ibmPlexMono.variable} ${fraunces.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
