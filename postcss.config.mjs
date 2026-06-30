// Tailwind v4 via PostCSS. Only the (console) route group imports the Tailwind
// stylesheet, so Payload's admin styling is untouched.
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;
