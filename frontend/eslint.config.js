import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'

// Lint rules, chosen for what they catch rather than for how they look.
//
// There was no configuration here at all, which meant ESLint 10 refused to
// run and `npm run build` was doing duty as the only gate. A build catches a
// syntax error and nothing else: an unused state setter, a hook called in a
// branch, a variable referenced before it exists and a promise nobody awaits
// all compile perfectly and all misbehave at runtime.
//
// Two decisions worth stating, because a config that nobody can satisfy gets
// switched off within a week:
//
//   1. Nothing here is about formatting. No quote style, no semicolons, no
//      indentation. This codebase is consistent already, and a formatting
//      gate turns every future diff into noise around the actual change.
//   2. Everything that IS here is an error, not a warning. A warning in CI
//      is a thing people learn to scroll past.
//
// The rules of hooks are the exception worth paying attention to: React's
// own linter is the only thing that catches a conditional hook, and that
// class of bug shows up as a screen that works until a state changes.

export default [
  {
    // Build output, dependencies and the generated smoke bundle. Linting
    // generated code tells you about the generator, not the source.
    ignores: ['dist/**', 'node_modules/**', 'smoke/**', '**/*.min.js'],
  },

  // Browser code: every screen, hook and component.
  {
    files: ['src/**/*.{js,jsx}'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      // __BUILD_STAMP__ is injected by Vite's define at build time.
      globals: { ...globals.browser, __BUILD_STAMP__: 'readonly' },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...js.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      // An unused argument is often deliberate (a signature being matched),
      // so those are allowed with a leading underscore. An unused local is
      // usually a leftover from an edit that was not finished.
      'no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        // React itself: these files predate the automatic JSX runtime and
        // the import is harmless. Deleting fifty of them is churn with a
        // non-zero chance of breaking a file that still needs it.
        varsIgnorePattern: '^(_|React$)',
        caughtErrors: 'none',
      }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': ['error', { destructuring: 'all' }],
      // `catch { }` around a localStorage write or a best-effort fetch is
      // the intent, not an oversight, and this codebase comments them.
      'no-empty': ['error', { allowEmptyCatch: true }],

      // The React Compiler rules that ship as errors in the recommended set
      // are off here, deliberately and with the reason recorded:
      //
      //   set-state-in-effect  43 hits. Syncing state from a prop or from
      //                        storage on mount is the pattern this app is
      //                        built on. Rewriting those to the compiler's
      //                        liking is a refactor, not a lint fix.
      //   static-components    26 hits. Components defined inside a render
      //                        remount on every parent render. Worth fixing
      //                        where it costs something; not worth a gate
      //                        that blocks every unrelated change today.
      //   immutability/purity  Flags render-time reads this app does on
      //                        purpose, such as reading localStorage for the
      //                        first paint.
      //
      // They are listed here rather than deleted so the next person can turn
      // one on and work through it.
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/static-components': 'off',
      'react-hooks/immutability': 'off',
      'react-hooks/purity': 'off',
      // A missing dependency is sometimes the correct answer (run once on
      // mount). A warning keeps it visible without failing the build.
      'react-hooks/exhaustive-deps': 'warn',
    },
  },

  // Node code: the serverless API handlers and the build scripts. Different
  // globals entirely, and console output is the point rather than a mistake.
  {
    // src/lib/db.js is Node code that happens to live under src: it imports
    // fs and reads process.env, and linting it as browser code reports
    // every one of those as undefined.
    files: ['api/**/*.js', 'scripts/**/*.{js,mjs}', 'src/lib/db.js', '*.config.js', '*.config.mjs'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'none',
      }],
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
      // `[^\/]` inside a character class is a redundant escape and also the
      // house style for the route patterns in api/index.js. Sixty-nine of
      // them, every one a working regex: rewriting them to satisfy a lint
      // rule is risk without a benefit.
      'no-useless-escape': 'off',
    },
  },
]
