/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{js,jsx,ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#e6eaff",
          100: "#c0caff",
          200: "#96a8ff",
          300: "#6b86ff",
          400: "#4a69ff",
          500: "#2e52ff",
          600: "#001E96",
          700: "#001680",
          800: "#000e6a",
          900: "#000654",
        },
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};
