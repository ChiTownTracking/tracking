import { defineConfig, type Plugin } from 'vitest/config';
import { transformAsync } from '@babel/core';
import { fileURLToPath } from 'url';

// Run the React Compiler over test-rendered components exactly as
// next.config.ts does for the app (reactCompiler: true). Without this,
// component tests exercise UNcompiled code and can't catch bugs the
// compiler's auto-memoization introduces — the ScheduleTimeline stale-status
// bug was invisible to an uncompiled test.
//
// A hand-rolled plugin because @vitejs/plugin-react deliberately strips
// babel-plugin-react-compiler from SSR transforms (v5) or gates it to
// client environments (v6) — and vitest transforms test modules as SSR, so
// going through plugin-react silently yields uncompiled components. Babel
// runs the compiler only; TS/JSX stripping stays with Vite's own esbuild
// pass afterwards.
//
// Scoped to components/ on purpose: the compiler also compiles async server
// components (e.g. app/page.tsx), whose tests invoke them as plain
// functions outside a React renderer — compiled output calls useMemoCache
// and crashes there. Client components under components/ are the ones tests
// actually render.
const COMPILED_PATH = /[\\/]components[\\/][^\\/]+\.tsx$/;

function reactCompilerForTests(): Plugin {
  return {
    name: 'react-compiler-for-tests',
    enforce: 'pre',
    async transform(code, id) {
      const [filepath] = id.split('?');
      if (!COMPILED_PATH.test(filepath) || filepath.includes('node_modules')) {
        return null;
      }
      const result = await transformAsync(code, {
        filename: filepath,
        configFile: false,
        babelrc: false,
        sourceType: 'module',
        parserOpts: { plugins: ['jsx', 'typescript'] },
        plugins: ['babel-plugin-react-compiler'],
        sourceMaps: true,
      });
      return result?.code != null
        ? { code: result.code, map: result.map }
        : null;
    },
  };
}

export default defineConfig({
  plugins: [reactCompilerForTests()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
  },
});
