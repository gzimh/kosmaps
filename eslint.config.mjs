import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Node/Python pipeline scripts are not part of the web app
    "pipeline/**",
    "osm-prototype/**",
    ".venv/**",
    ".context/**",
  ]),
]);

export default eslintConfig;
