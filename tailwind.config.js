import typography from '@tailwindcss/typography'

// Tokens are defined as CSS custom properties in src/styles/tokens.css.
// That file is the canonical source of truth so MapLibre styles and
// (eventually) R3F materials can read the same values. This config only
// re-exports those variables so Tailwind utilities resolve to the same
// colors and fonts.
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: 'var(--color-ink)',
        graphite: 'var(--color-graphite)',
        slate: 'var(--color-slate)',
        mist: 'var(--color-mist)',
        fog: 'var(--color-fog)',
        paper: 'var(--color-paper)',
        canvas: 'var(--color-canvas)',
        white: 'var(--color-white)',
        accent: {
          DEFAULT: 'var(--color-accent)',
          soft: 'var(--color-accent-soft)',
          wash: 'var(--color-accent-wash)',
        },
      },
      fontFamily: {
        serif: ['var(--font-serif)'],
        sans: ['var(--font-sans)'],
        mono: ['var(--font-mono)'],
      },
      typography: () => ({
        DEFAULT: {
          css: {
            '--tw-prose-body': 'var(--color-graphite)',
            '--tw-prose-headings': 'var(--color-ink)',
            '--tw-prose-lead': 'var(--color-graphite)',
            '--tw-prose-links': 'var(--color-accent)',
            '--tw-prose-bold': 'var(--color-ink)',
            '--tw-prose-counters': 'var(--color-slate)',
            '--tw-prose-bullets': 'var(--color-mist)',
            '--tw-prose-hr': 'var(--color-fog)',
            '--tw-prose-quotes': 'var(--color-graphite)',
            '--tw-prose-quote-borders': 'var(--color-fog)',
            '--tw-prose-captions': 'var(--color-slate)',
            '--tw-prose-code': 'var(--color-ink)',
            '--tw-prose-pre-code': 'var(--color-ink)',
            '--tw-prose-pre-bg': 'var(--color-canvas)',
            '--tw-prose-th-borders': 'var(--color-fog)',
            '--tw-prose-td-borders': 'var(--color-fog)',
            fontFamily: 'var(--font-sans)',
            'h1, h2, h3, h4': {
              fontFamily: 'var(--font-serif)',
              fontWeight: '500',
            },
            code: { fontFamily: 'var(--font-mono)', fontWeight: '400' },
            'code::before': { content: '""' },
            'code::after': { content: '""' },
          },
        },
      }),
    },
  },
  plugins: [typography],
}
