/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        forest: "#12372A",
        emerald: "#1E6F5C",
        cream: "#F7F5EF",
        charcoal: "#1B211E",
      },
    },
  },
  plugins: [],
};
