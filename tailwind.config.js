/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: 'rgba(163, 230, 53, 0.12)',
          100: 'rgba(163, 230, 53, 0.22)',
          200: '#d9f99d',
          300: '#bef264',
          400: '#a3e635',
          500: '#84cc16',
          600: '#a3e635',
          700: '#bef264',
          800: '#d9f99d',
          900: '#ecfccb',
          950: '#0d1f02',
        },
        accent: '#2dd4bf',
        warning: '#fbbf24',
      },
      boxShadow: {
        glow: '0 0 0 1px rgba(163, 230, 53, 0.25), 0 20px 45px rgba(0, 0, 0, 0.65)',
        lime: '0 0 25px -5px rgba(163, 230, 53, 0.45)',
      },
    },
  },
  plugins: [],
};
