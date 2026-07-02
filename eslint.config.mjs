import globals from "globals";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";

export default [
    {
        ignores: ["node_modules/**", "out/**", "dist/**", ".vscode-test/**"]
    },
    {
        files: ["**/*.ts"],
        languageOptions: {
            parser: tsparser,
            parserOptions: {
                ecmaVersion: 2022,
                sourceType: "module",
            },
            globals: {
                ...globals.node,
                ...globals.mocha,
            },
        },
        plugins: {
            "@typescript-eslint": tseslint,
        },
        rules: {
            ...tseslint.configs.recommended.rules,
            "no-undef": "off",
            "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
            "@typescript-eslint/no-explicit-any": "off",
            "@typescript-eslint/no-require-imports": "off",
            "constructor-super": "warn",
            "valid-typeof": "warn",
        },
    },
    {
        files: ["**/*.js"],
        languageOptions: {
            globals: {
                ...globals.commonjs,
                ...globals.node,
                ...globals.mocha,
            },
            ecmaVersion: 2022,
            sourceType: "module",
        },
        rules: {
            "no-const-assign": "warn",
            "no-this-before-super": "warn",
            "no-undef": "warn",
            "no-unreachable": "warn",
            "no-unused-vars": "warn",
            "constructor-super": "warn",
            "valid-typeof": "warn",
        },
    }
];
