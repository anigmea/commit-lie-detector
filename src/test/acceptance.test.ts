/**
 * Acceptance test — "The Assignment" from the spec.
 *
 * Fixture: staged diff adds UserAuthService, two new API endpoints in routes.ts,
 *          deletes legacy/auth.js.
 * Commit message: "fix typo."
 *
 * Assertion: the lie detector fires and the output contains:
 *   - the word "new" (new feature, new endpoints, etc.)
 *   - at least one of the changed file names
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// We test the evaluate() function directly to avoid needing a git repo.
// This is the same function the hook calls.
import { evaluate } from "../llm.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, "fixtures", "user-auth-service.diff");

// Skip if no API key is set (CI without keys should not fail)
const hasKey = Boolean(process.env.ANTHROPIC_API_KEY ?? process.env.OPENAI_API_KEY);

describe("Acceptance test: UserAuthService fixture", () => {
  it("requires an API key to run (skips otherwise)", async () => {
    if (!hasKey) {
      console.log("    [skipped] No API key set — set ANTHROPIC_API_KEY or OPENAI_API_KEY");
      return;
    }

    const diffContent = fs.readFileSync(FIXTURE_PATH, "utf8");

    const result = await evaluate("fix typo.", {
      stat: "3 files changed, 88 insertions(+), 30 deletions(-)",
      diff: diffContent,
      truncated: false,
    });

    // The lie detector must fire
    assert.equal(result.honest, false, "Should detect lie: 'fix typo' for a major feature addition");

    // The accusation must mention "new" and at least one changed file
    const accusation = (result.accusation ?? "").toLowerCase();
    const suggested = result.suggested_message.toLowerCase();
    const combined = accusation + " " + suggested;

    assert.ok(
      combined.includes("new"),
      `Expected 'new' in accusation/suggestion, got: "${result.accusation}" / "${result.suggested_message}"`
    );

    const changedFiles = ["userauthservice", "routes", "auth.js", "api/routes", "legacy"];
    const mentionsFile = changedFiles.some((f) => combined.includes(f));
    assert.ok(
      mentionsFile,
      `Expected at least one changed file name in output, got: "${result.accusation}" / "${result.suggested_message}"`
    );

    console.log(`    accusation: "${result.accusation}"`);
    console.log(`    suggested:  "${result.suggested_message}"`);
    console.log(`    confidence: ${result.confidence}`);
  });
});

describe("Unit: honest commit passes", () => {
  it("returns honest=true for accurate short message", async () => {
    if (!hasKey) {
      console.log("    [skipped] No API key set");
      return;
    }

    const result = await evaluate("fix: null check in getUserById", {
      stat: "1 file changed, 2 insertions(+), 1 deletion(-)",
      diff: `diff --git a/src/users.ts b/src/users.ts
index abc..def 100644
--- a/src/users.ts
+++ b/src/users.ts
@@ -10,6 +10,8 @@ export async function getUserById(id: string): Promise<User | null> {
   const row = await db.users.findOne({ id });
+  if (!row) return null;
   return row;
 }`,
      truncated: false,
    });

    assert.equal(result.honest, true, "Should pass honest null-check fix");
    assert.ok(result.confidence >= 0.5, `Confidence should be >= 0.5, got ${result.confidence}`);
    // suggested_message always populated
    assert.ok(result.suggested_message.length > 0, "suggested_message should always be populated");
    console.log(`    confidence: ${result.confidence}`);
  });
});
