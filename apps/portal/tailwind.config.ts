import type { Config } from "tailwindcss";

// Egen färgpalett i stället för Tailwinds standard-slate, så portalen inte
// ser ut som vilken default-Tailwind-app som helst: djupblå "ink" (rubriker,
// primära knappar, header/sidomeny), blågrå "mist" (sekundär text/
// kantlinjer) och en varm "sienna"-accent (bränd terrakotta) som används
// sparsamt (aktiv navigering, hover, positiva statusar). "cream" är
// sidbakgrunden — varmare än ett rent grått.
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          50: "#eef2f7",
          100: "#dce6f0",
          200: "#b7c9dc",
          300: "#8fa8c4",
          400: "#5f80a3",
          500: "#3f6084",
          600: "#2d4a68",
          700: "#213a53",
          800: "#17293c",
          900: "#101d2b",
          950: "#0a1420",
        },
        mist: {
          50: "#f4f6f8",
          100: "#e6ebf0",
          200: "#cdd7e0",
          300: "#a9b8c6",
          400: "#7e91a3",
          500: "#5f7286",
          600: "#4a5a6c",
          700: "#3a4756",
          800: "#2b3542",
          900: "#1f2730",
        },
        sienna: {
          50: "#fbf1ec",
          100: "#f4ded2",
          200: "#e6b99e",
          300: "#d6926a",
          400: "#c37142",
          500: "#a0522d",
          600: "#82401f",
          700: "#66331a",
          800: "#4d2715",
          900: "#331a0e",
        },
        cream: {
          50: "#faf9f5",
          100: "#f3f0e8",
          200: "#e8e3d6",
        },
      },
      fontFamily: {
        sans: ["Manrope", "ui-sans-serif", "system-ui", "-apple-system", "sans-serif"],
      },
    },
  },
  plugins: [],
} satisfies Config;
