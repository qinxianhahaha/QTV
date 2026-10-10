import type { Metadata } from "next";

import "./globals.css";
import { Providers } from "@/components/providers/Providers";
import { AppShell } from "@/components/shell/AppShell";
import { MotionProvider } from "@/components/motion/MotionProvider";
import { TauriIndexHtmlFix } from "@/components/app/TauriIndexHtmlFix";

export const metadata: Metadata = {
  title: "QTV",
  description: "QTV · 打开就是你关注的直播",
  icons: { icon: "/icon.png" }
};

const themeBootScript = `try{var p=localStorage.getItem("theme_preference");var d=p==="dark"||((!p||p==="system")&&matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.setAttribute("data-theme",d?"dark":"light");if(/Mac/i.test(navigator.platform||navigator.userAgent))document.documentElement.setAttribute("data-os","mac")}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        {/* Apply the stored theme before first paint to avoid a light flash in dark mode. */}
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
      </head>
      <body>
        <TauriIndexHtmlFix />
        <Providers>
          <MotionProvider>
            <AppShell>{children}</AppShell>
          </MotionProvider>
        </Providers>
      </body>
    </html>
  );
}
