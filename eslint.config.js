// @ts-check
import eslintComments from "@eslint-community/eslint-plugin-eslint-comments";
import eslint from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

/** Where the guardrail rules apply. */
const GUARDED = ["packages/**", "apps/**", "examples/**"];

/** One fixture per guardrail rule; `apps/zenorm/src/lint-rules.test.ts` lints each with `--no-ignore`. */
const LINT_FIXTURES = "apps/zenorm/eslint-fixtures/*.ts";

const FALLBACK = "LogicalExpression[operator=/^(\\?\\?|\\|\\|)$/]";
const NO_FALLBACK_MESSAGE =
  "No `?? <literal>` or `|| <literal>` fallback: missing data is a coded error.";
/** The same fallback as an assignment, `x ??= <literal>` or `x ||= <literal>`. */
const FALLBACK_ASSIGNMENT = "AssignmentExpression[operator=/^(\\?\\?=|\\|\\|=)$/]";
const NO_FALLBACK_ASSIGNMENT_MESSAGE =
  "No `??= <literal>` or `||= <literal>` fallback: missing data is a coded error.";

/**
 * No silent defaults: a fallback to a literal, an empty array or an empty object, as `??`/`||`
 * or as `??=`/`||=`, and any `.default(` call.
 */
const GUARDRAIL_SYNTAX = [
  {
    selector: `${FALLBACK}[right.type=/^(Literal|TemplateLiteral)$/]`,
    message: NO_FALLBACK_MESSAGE,
  },
  {
    selector: `${FALLBACK}[right.type='ArrayExpression'][right.elements.length=0]`,
    message: NO_FALLBACK_MESSAGE,
  },
  {
    selector: `${FALLBACK}[right.type='ObjectExpression'][right.properties.length=0]`,
    message: NO_FALLBACK_MESSAGE,
  },
  {
    selector: `${FALLBACK_ASSIGNMENT}[right.type=/^(Literal|TemplateLiteral)$/]`,
    message: NO_FALLBACK_ASSIGNMENT_MESSAGE,
  },
  {
    selector: `${FALLBACK_ASSIGNMENT}[right.type='ArrayExpression'][right.elements.length=0]`,
    message: NO_FALLBACK_ASSIGNMENT_MESSAGE,
  },
  {
    selector: `${FALLBACK_ASSIGNMENT}[right.type='ObjectExpression'][right.properties.length=0]`,
    message: NO_FALLBACK_ASSIGNMENT_MESSAGE,
  },
  {
    selector: "CallExpression[callee.property.name='default']",
    message: "No `.default(`: missing input is a coded error, never a default value.",
  },
];

/**
 * A typed rule: `.catch(` on a receiver whose type is a Zod schema (it has Zod's `_zod`
 * internals). A Promise's `.catch` passes.
 */
const noZodCatch = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      zodCatch: "No Zod `.catch(`: invalid input is a coded error, never a fallback value.",
    },
  },
  /** @param {import("eslint").Rule.RuleContext} context */
  create(context) {
    const services = context.sourceCode.parserServices;
    if (services?.program === undefined || services.program === null) {
      throw new Error("zenorm/no-zod-catch needs type information (parserOptions.projectService)");
    }
    const checker = services.program.getTypeChecker();
    /** @param {import("typescript").Type} type @returns {boolean} */
    const isZodSchema = (type) =>
      type.isUnion() ? type.types.some(isZodSchema) : type.getProperty("_zod") !== undefined;
    return {
      /** @param {import("estree").MemberExpression} node */
      "CallExpression > MemberExpression.callee[property.name='catch']"(node) {
        const receiver = services.esTreeNodeToTSNodeMap.get(node.object);
        if (isZodSchema(checker.getTypeAtLocation(receiver))) {
          context.report({ node, messageId: "zodCatch" });
        }
      },
    };
  },
};

export default defineConfig(
  {
    ignores: [
      ".scratch/",
      "docs/",
      "skills/",
      "prototypes/",
      ".serena/",
      "**/dist/",
      // Each fails its rule on purpose; the lint-rules test lints them with `--no-ignore`.
      LINT_FIXTURES,
      // Playwright output, which `e2e` rewrites while `lint` walks `apps/zenorm`.
      "**/test-results/",
      "**/playwright-report/",
    ],
  },
  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // The fixtures are in no tsconfig; the default project types them for the typed rule.
        projectService: { allowDefaultProject: [LINT_FIXTURES] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: {
      "@typescript-eslint/switch-exhaustiveness-check": [
        "error",
        { considerDefaultExhaustiveForUnions: false, requireDefaultForNonUnion: true },
      ],
      "@typescript-eslint/consistent-type-assertions": ["error", { assertionStyle: "never" }],
      "no-console": "error",
    },
  },
  {
    // The guardrail lint.
    files: GUARDED,
    plugins: { "@eslint-community/eslint-comments": eslintComments },
    rules: {
      "no-restricted-syntax": ["error", ...GUARDRAIL_SYNTAX],
      "@eslint-community/eslint-comments/require-description": ["error", { ignore: [] }],
      // Every disable names the rules it turns off.
      "@eslint-community/eslint-comments/no-unlimited-disable": "error",
    },
  },
  {
    // Never read the change feed to decide: only `packages/db`, core's `write` and the server's
    // event route may import the table.
    files: GUARDED,
    ignores: ["packages/db/**", "packages/core/src/writes.ts", "packages/server/src/events.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@zenorm/db",
              importNames: ["changeFeed"],
              message:
                "The change feed is never read to decide: only packages/db, core's writes.ts and the server's events.ts import it.",
            },
          ],
        },
      ],
    },
  },
  {
    // A plugin imports only the SDK and contracts from the workspace: the examples
    // keep the SDK honest. This replaces the change-feed block above, whose import it also refuses.
    files: ["examples/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@zenorm/*", "!@zenorm/plugin-sdk", "!@zenorm/contracts"],
              message:
                "A plugin imports only @zenorm/plugin-sdk and @zenorm/contracts from the workspace.",
            },
          ],
        },
      ],
    },
  },
  {
    files: GUARDED.map((dir) => `${dir}/*.{ts,tsx}`),
    plugins: { zenorm: { rules: { "no-zod-catch": noZodCatch } } },
    rules: { "zenorm/no-zod-catch": "error" },
  },
  {
    // The app entries own process output; packages log through the `log` function they pass in.
    files: ["apps/zenorm/**", "apps/zenorm-example/**", "apps/cli/**"],
    rules: { "no-console": "off" },
  },
  {
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
// cold-cache measurement
