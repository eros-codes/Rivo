// ESLint for the server, the scripts and the tests. (The browser code is
// TypeScript: `npm run typecheck` checks it.)
//   npm run lint
import js from "@eslint/js";

export default [
	{
		ignores: ["client/**", "public/**", "node_modules/**", "test-results/**", "playwright-report/**", "backups/**", "**/*.ts", "**/*.tsx"],
	},
	js.configs.recommended,
	{
		files: ["**/*.js", "**/*.mjs"],
		languageOptions: {
			ecmaVersion: "latest",
			sourceType: "module",
		},
		rules: {
			"no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
			// an empty catch says "this may fail, and that is fine" (each has a comment)
			"no-empty": ["error", { allowEmptyCatch: true }],
			// Node's globals (process, Buffer, fetch…) are not declared one by one
			"no-undef": "off",
			"no-constant-condition": ["error", { checkLoops: false }],
		},
	},
];
