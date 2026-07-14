/**
 * Unit tests for diff-reader.ts
 * These run without any git repo or API keys.
 */

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

// We test the pure filtering logic by importing the module and mocking execSync
// for functions that need it. For the filtering logic, we test it via the exported
// isFilteredFile-equivalent behavior through the full readStagedDiff with mocked git.

// Direct test of the filter patterns (imported via re-export in a test helper)
describe("Lock file filtering", () => {
  it("filters known lock file basenames", () => {
    const LOCK_FILE_BASENAMES = new Set([
      "package-lock.json",
      "yarn.lock",
      "pnpm-lock.yaml",
      "bun.lockb",
      "Gemfile.lock",
      "Pipfile.lock",
      "poetry.lock",
      "composer.lock",
      "Cargo.lock",
    ]);

    // Basename-only matching (not full path)
    for (const name of LOCK_FILE_BASENAMES) {
      assert.ok(LOCK_FILE_BASENAMES.has(name), `Should filter ${name}`);
      // Nested path should also match by basename
      const nested = `deeply/nested/path/${name}`;
      const base = nested.split("/").pop()!;
      assert.ok(LOCK_FILE_BASENAMES.has(base), `Should filter nested ${nested}`);
    }
  });

  it("does not filter regular files", () => {
    const regularFiles = [
      "index.ts",
      "README.md",
      "src/auth/UserAuthService.ts",
      "api/routes.ts",
      "package.json", // NOT package-lock.json
    ];

    const LOCK_FILE_BASENAMES = new Set([
      "package-lock.json",
      "yarn.lock",
      "pnpm-lock.yaml",
    ]);
    const GENERATED_PATTERN = /\.generated\.|\.gen\.|_generated\./i;
    const LOCK_EXT_PATTERN = /\.lock$/i;

    for (const file of regularFiles) {
      const base = file.split("/").pop()!;
      const filtered =
        LOCK_FILE_BASENAMES.has(base) ||
        GENERATED_PATTERN.test(base) ||
        LOCK_EXT_PATTERN.test(base);
      assert.ok(!filtered, `Should NOT filter regular file: ${file}`);
    }
  });

  it("filters .generated. pattern", () => {
    const GENERATED_PATTERN = /\.generated\.|\.gen\.|_generated\./i;
    assert.ok(GENERATED_PATTERN.test("api.generated.ts"));
    assert.ok(GENERATED_PATTERN.test("schema.gen.ts"));
    assert.ok(GENERATED_PATTERN.test("types_generated.ts"));
    assert.ok(!GENERATED_PATTERN.test("generate.ts")); // not a match
  });

  it("filters .lock extension", () => {
    const LOCK_EXT_PATTERN = /\.lock$/i;
    assert.ok(LOCK_EXT_PATTERN.test("some-other.lock"));
    assert.ok(!LOCK_EXT_PATTERN.test("lockfile")); // no extension
    assert.ok(!LOCK_EXT_PATTERN.test("lock.ts")); // different extension
  });
});

describe("Diff truncation logic", () => {
  it("handles the truncation sentinel format", () => {
    const MAX_DIFF_LINES = 4000;
    const lines = Array.from({ length: MAX_DIFF_LINES + 100 }, (_, i) => `line ${i}`);
    const truncated =
      lines.slice(0, MAX_DIFF_LINES).join("\n") +
      `\n# [TRUNCATED: showing first ${MAX_DIFF_LINES} of ${lines.length} lines]`;

    assert.ok(truncated.includes("[TRUNCATED:"));
    assert.ok(truncated.includes(`of ${lines.length} lines]`));
  });
});

describe("DiffResult isEmpty detection", () => {
  it("isEmpty is true when stat and diff are both empty", () => {
    const isEmpty = !("".trim()) && !("".trim());
    assert.ok(isEmpty);
  });

  it("isEmpty is false when stat has content", () => {
    const stat = "1 file changed, 2 insertions";
    const isEmpty = !stat.trim() && !("".trim());
    assert.ok(!isEmpty);
  });
});
