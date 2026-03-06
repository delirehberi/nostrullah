# AGENTS.md: A Guide for AI Agents

This document provides instructions for AI agents working in this repository.

## Core Workflow: Plan Before You Act

For any non-trivial request that involves changing files, you must follow this procedure:

1.  **Understand:** Analyze the request and the existing codebase to understand the context and requirements. Use tools like `grep` and `read` to explore the code.
2.  **Plan:** Propose a clear, step-by-step implementation plan. Describe what you are going to do and which files you will modify.
3.  **Wait for Approval:** **Do not start implementing** until the user explicitly approves your plan. Wait for a confirmation like "yes", "sounds good", or "proceed".

This process ensures that your work aligns with the user's expectations.


## Build, Lint, and Test Commands

### Build

This is a Cloudflare Workers project. There is no explicit build command in `package.json`. The project is built and deployed using `wrangler`.

-   **Deploy:** `npx wrangler deploy`
-   **Local Development:** `npx wrangler dev`

### Lint

There is currently no linting setup in this project. A linter like ESLint is recommended to ensure code quality and consistency.

### Test

There is no test runner configured in `package.json`. However, `vitest` is included as a dev dependency.

-   **Run all tests:** `npx vitest`
-   **Run a single test file:** `npx vitest <path_to_test_file>`

It is recommended to create a `vitest.config.ts` file and add a `test` script to `package.json`.

## Code Style Guidelines

### Imports

-   Group imports by source: built-in modules, external modules, and then local modules.
-   Use named imports where possible: `import { ScheduledEvent, ExecutionContext } from '@cloudflare/workers-types';`
-   Separate groups of imports with a blank line.

### Formatting

-   **Indentation:** Use 4 spaces for indentation.
-   **Quotes:** Use single quotes (`'`) for strings.
-   **Braces:** Use braces on the same line for classes, methods, and blocks.
    ```typescript
    class MyClass {
        myMethod() {
            if (condition) {
                // ...
            }
        }
    }
    ```
-   **Spacing:** Use single blank lines to separate logical blocks of code. Add a blank line at the end of each file.

### Types

-   This project uses TypeScript with `strict: true` enabled.
-   Use explicit types for all function parameters and return values.
-   Avoid using the `any` type. Define custom types in `src/types.ts` and import them where needed.
-   Use interfaces or types for complex objects.

### Naming Conventions

-   **Classes and Types:** Use `PascalCase` (e.g., `ContentGenerator`, `NostrAccount`).
-   **Methods and Variables:** Use `camelCase` (e.g., `generatePost`, `privateKey`).
-   **Files:** Use `kebab-case` for new files.

### Error Handling

-   Use `try...catch` blocks for all asynchronous operations that may fail.
-   Log errors to the console using `console.error`.
-   Use the `withRetry` utility function for operations that should be retried on failure.
-   When creating new errors, use the `Error` constructor: `throw new Error('Something went wrong');`

### Asynchronous Code

-   Use `async/await` for all asynchronous operations.
-   Use `ctx.waitUntil` for background tasks in the Cloudflare Worker to ensure they complete even after the response has been sent.

### General Principles

-   Keep functions small and focused on a single responsibility.
-   Add JSDoc comments to public methods and complex functions to explain their purpose, parameters, and return values.
-   Follow existing patterns in the codebase.
-   All new code should be accompanied by tests.
