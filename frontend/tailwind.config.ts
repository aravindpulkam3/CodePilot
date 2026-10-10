import type { Config } from "tailwindcss";

// Design tokens for AI Engineering Workspace.
// Palette avoids generic "AI product" defaults (no cream+terracotta, no
// black+neon-violet). Instead: graphite/paper neutrals with a signal-teal
// accent — evokes a terminal / developer-tool aesthetic appropriate to a
// platform built for reading and reasoning about code.
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        canvas: {
          light: "#F7F8FA",
          dark: "#0B0E14",
        },
        surface: {
          light: "#FFFFFF",
          dark: "#12161F",
        },
        border: {
          light: "#E2E5EA",
          dark: "#232838",
        },
        ink: {
          light: "#12161F",
          dark: "#E6E8EC",
        },
        muted: {
          light: "#6B7280",
          dark: "#8B93A7",
        },
        signal: {
          50: "#EFFDFA",
          100: "#CCFBF1",
          300: "#5EEAD4",
          500: "#14B8A6",
          600: "#0D9488",
          700: "#0F766E",
        },
        amber: {
          400: "#F5A524",
        },
        // PR Review workspace surfaces. Values live as CSS variables on
        // `.review-ws` (globals.css) so one class serves both themes; the
        // code area is the lit surface, chrome sits darker around it.
        rv: {
          chrome: "var(--rv-chrome)",
          code: "var(--rv-code)",
          rec: "var(--rv-rec)",
          raised: "var(--rv-raised)",
          hair: "var(--rv-hair)",
          bd: "var(--rv-bd)",
          ink: "var(--rv-ink)",
          ink2: "var(--rv-ink2)",
          mute: "var(--rv-mute)",
          lnc: "var(--rv-lnc)",
          hover: "var(--rv-hover)",
          sel: "var(--rv-sel)",
          teal: "var(--rv-teal)",
          tealbd: "var(--rv-tealbd)",
          add: "var(--rv-add)",
          addg: "var(--rv-addg)",
          del: "var(--rv-del)",
          delg: "var(--rv-delg)",
          crit: "var(--rv-crit)",
          major: "var(--rv-major)",
          minor: "var(--rv-minor)",
          info: "var(--rv-info)",
          open: "var(--rv-open)",
          merged: "var(--rv-merged)",
          warn: "var(--rv-warn)",
        },
      },
      fontFamily: {
        display: ["'Space Grotesk'", "sans-serif"],
        sans: ["'Geist'", "'Inter'", "sans-serif"],
        mono: ["'JetBrains Mono'", "monospace"],
      },
      borderRadius: {
        sm: "6px",
        md: "8px",
        lg: "12px",
      },
      boxShadow: {
        subtle: "0 1px 2px 0 rgb(0 0 0 / 0.04)",
        panel: "0 4px 24px -8px rgb(0 0 0 / 0.12)",
      },
    },
  },
  plugins: [],
} satisfies Config;
