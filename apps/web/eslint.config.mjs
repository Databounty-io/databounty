// SPDX-License-Identifier: Apache-2.0

import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // `eslint-config-next/typescript` turns on `no-unused-vars` with no ignore
    // pattern, so it also flags bindings that are deliberately unused and
    // marked as such with a leading underscore. That happens here for real
    // reasons and the alternative is worse:
    //
    //   - `rewardNoun(_workType)` and `resolveHomeRoute(_persona)` keep a
    //     parameter their callers still pass (and that the paid/community
    //     split may need again) while the community build has one answer for
    //     every input. Dropping the parameter would change the exported
    //     signature; renaming the callers' argument away would change call
    //     shapes.
    //
    // Honouring the `_` convention keeps "unused" meaningful for accidental
    // dead bindings — which are still reported — instead of the rule being
    // noise contributors learn to scroll past. The rule itself stays on.
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          args: "after-used",
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
