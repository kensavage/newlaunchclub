import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = [
  {
    ignores: [
      ".next/**",
      ".netlify/**",
      "coverage/**",
      "node_modules/**",
      "playwright-report/**",
      "test-results/**"
    ]
  },
  ...nextVitals,
  ...nextTs
];

export default eslintConfig;
