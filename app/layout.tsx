import type { Metadata } from "next";
import { Providers } from "@/components/studio";
import "./globals.css";
export const metadata: Metadata = {
  title: "Forma — A little help. A bigger business.",
  description:
    "Your small-business creative studio. Websites, videos, flyers, and market insights, from one thoughtful brief.",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a href="#main-content" className="skip-link">
          Skip to content
        </a>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
