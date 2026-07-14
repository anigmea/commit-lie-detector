/**
 * hook-runner.ts
 *
 * Implements the commit-msg git hook logic:
 *   1. Read commit message from the file path given as argv[2]
 *   2. Read staged diff
 *   3. Call LLM to evaluate
 *   4. If honest → exit 0 silently (or show checkmark with --verbose)
 *   5. If lie → show accusation, offer Y/E/n rewrite prompt (TTY only)
 */

import fs from "node:fs";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { readStagedDiff } from "./diff-reader.js";
import { evaluate, type LLMError } from "./llm.js";

export interface HookOptions {
  conventional?: boolean;
  quality?: boolean;
  strict?: boolean;      // exit 1 instead of offering rewrite
  suggestAlways?: boolean; // show suggested message even when honest
  verbose?: boolean;
}

const COLORS = {
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  bold: "\x1b[1m",
  reset: "\x1b[0m",
  dim: "\x1b[2m",
};

function color(text: string, ...codes: string[]): string {
  if (!process.stderr.isTTY) return text;
  return codes.join("") + text + COLORS.reset;
}

function writeStderr(msg: string): void {
  process.stderr.write(msg + "\n");
}

function isAmendCommit(): boolean {
  // Primary check: $GIT_REFLOG_ACTION
  const reflogAction = process.env.GIT_REFLOG_ACTION ?? "";
  if (reflogAction.includes("amend")) return true;

  // Secondary check: ORIG_HEAD exists (set during amend)
  try {
    const gitDir = process.env.GIT_DIR ?? ".git";
    const origHead = `${gitDir}/ORIG_HEAD`;
    if (fs.existsSync(origHead)) {
      // ORIG_HEAD alone isn't definitive — only trust it when combined with
      // GIT_REFLOG_ACTION being empty (meaning no explicit action was provided
      // but we're in an amend-like context).
      return reflogAction === "";
    }
  } catch {
    // ignore
  }
  return false;
}

/**
 * Read the commit message from the file path git passes as argv[2].
 * The commit-msg hook receives the path to a temp file containing the message.
 */
function readCommitMessageFile(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (err: any) {
    throw new Error(`Cannot read commit message file "${filePath}": ${err.message}`);
  }
}

function writeCommitMessageFile(filePath: string, message: string): void {
  fs.writeFileSync(filePath, message, "utf8");
}

/**
 * Open $EDITOR with the suggested message pre-filled in the commit file.
 * Uses spawn() to prevent shell injection.
 */
function openEditor(commitFilePath: string, suggestedMessage: string): void {
  // Write suggested message to the commit file so editor opens with it
  writeCommitMessageFile(commitFilePath, suggestedMessage + "\n");

  const editor = process.env.EDITOR || process.env.VISUAL || "vi";
  // Split editor command in case it has flags (e.g. "code --wait")
  const parts = editor.split(/\s+/);
  const bin = parts[0]!;
  const args = [...parts.slice(1), commitFilePath];

  try {
    const result = spawnSync(bin, args, {
      stdio: "inherit",
      // Use /dev/tty so editor gets a proper TTY even when stdin is piped
      ...(process.platform !== "win32"
        ? { stdio: ["inherit", "inherit", "inherit"] }
        : {}),
    });
    if (result.error) {
      writeStderr(color(`\nCould not open editor "${editor}": ${result.error.message}`, COLORS.yellow));
      writeStderr(color("Commit message left unchanged.", COLORS.dim));
    }
  } catch (err: any) {
    writeStderr(color(`\nFailed to launch editor: ${err.message}`, COLORS.yellow));
  }
}

/**
 * Prompt the user interactively via /dev/tty (bypasses piped stdin).
 * Returns the character pressed, uppercased.
 */
function promptTTY(promptText: string): string {
  try {
    // Open /dev/tty for reading so we get keystrokes even when stdin is redirected
    const ttyFd = fs.openSync("/dev/tty", "r");
    process.stderr.write(promptText);

    const buf = Buffer.alloc(16);
    const bytesRead = fs.readSync(ttyFd, buf, 0, buf.length, null);
    fs.closeSync(ttyFd);

    const input = buf.slice(0, bytesRead).toString("utf8").trim();
    return input.slice(0, 1).toUpperCase();
  } catch {
    // /dev/tty not available (Windows, some CI) — treat as 'N'
    return "N";
  }
}

/**
 * Main hook entry point. Called by the git commit-msg hook script.
 *
 * @param commitFilePath - path to the file containing the commit message (argv[2])
 */
export async function runHook(
  commitFilePath: string,
  opts: HookOptions = {}
): Promise<void> {
  const { conventional = false, quality = false, strict = false, suggestAlways = false, verbose = false } = opts;

  // ── Skip conditions ────────────────────────────────────────────────────────

  // User explicitly requested skip
  if (process.env.COMMIT_LIE_SKIP === "1") {
    if (verbose) writeStderr(color("commit-lie-detector: skipped (COMMIT_LIE_SKIP=1)", COLORS.dim));
    return;
  }

  // Amend commits: don't re-evaluate
  if (isAmendCommit()) {
    if (verbose) writeStderr(color("commit-lie-detector: skipped (amend commit)", COLORS.dim));
    return;
  }

  // ── Read commit message ────────────────────────────────────────────────────

  let commitMessage: string;
  try {
    commitMessage = readCommitMessageFile(commitFilePath).trim();
  } catch (err: any) {
    writeStderr(color(`commit-lie-detector: ${err.message} — skipping check.`, COLORS.yellow));
    return; // never block a commit due to our own errors
  }

  // [skip-check] escape hatch
  if (commitMessage.toLowerCase().includes("[skip-check]")) {
    if (verbose) writeStderr(color("commit-lie-detector: skipped ([skip-check] in message)", COLORS.dim));
    return;
  }

  // Empty message — let git handle that validation
  if (!commitMessage || commitMessage.startsWith("#")) {
    return;
  }

  // ── Read staged diff ───────────────────────────────────────────────────────

  const diffResult = readStagedDiff();

  if (diffResult.isEmpty) {
    if (verbose) writeStderr(color("commit-lie-detector: no staged changes — skipping.", COLORS.dim));
    return;
  }

  // ── Check TTY ─────────────────────────────────────────────────────────────
  // If not a TTY (GUI git clients, CI), fall back to advisory mode
  const isTTY = Boolean(process.stderr.isTTY);

  // ── Call LLM ──────────────────────────────────────────────────────────────

  let result;
  try {
    result = await evaluate(commitMessage, diffResult, { conventional, quality });
  } catch (err: any) {
    // LLMError or network failure: always exit 0 with a warning
    const llmErr = err as LLMError;
    const msg = llmErr?.message ?? String(err);
    writeStderr(color(`commit-lie-detector: API error — skipping check. (${msg})`, COLORS.yellow));
    return;
  }

  // ── Honest: pass ──────────────────────────────────────────────────────────

  if (result.honest) {
    if (verbose) {
      writeStderr(color("  commit-lie-detector: ", COLORS.dim) + color("honest", COLORS.green) + color(` (confidence ${(result.confidence * 100).toFixed(0)}%)`, COLORS.dim));
    }
    if (suggestAlways && result.suggested_message) {
      writeStderr(color("\nSuggested message: ", COLORS.dim) + result.suggested_message);
    }
    return;
  }

  // ── Lie detected ──────────────────────────────────────────────────────────

  writeStderr("");
  writeStderr(color("  commit-lie-detector", COLORS.bold) + color(" caught a lie:", COLORS.red));
  writeStderr("");
  writeStderr(color("  Your message: ", COLORS.dim) + color(`"${commitMessage}"`, COLORS.yellow));
  if (result.accusation) {
    writeStderr(color("  What actually changed: ", COLORS.dim) + result.accusation);
  }
  writeStderr("");

  // Advisory mode (non-TTY): print suggestion, always exit 0
  if (!isTTY) {
    if (result.suggested_message) {
      writeStderr(color("  Suggested message: ", COLORS.dim) + result.suggested_message);
    }
    writeStderr("");
    return;
  }

  // Strict mode: block commit
  if (strict) {
    writeStderr(color("  Commit blocked (--strict mode). Fix your message and retry.", COLORS.red));
    writeStderr("");
    process.exit(1);
  }

  // ── Interactive prompt ─────────────────────────────────────────────────────

  if (result.suggested_message) {
    writeStderr(color("  Suggested: ", COLORS.dim) + color(result.suggested_message, COLORS.cyan));
  }
  writeStderr("");

  const promptText =
    color("  Accept suggestion? ", COLORS.bold) +
    color("[Y]es  ", COLORS.green) +
    color("[E]dit  ", COLORS.yellow) +
    color("[n]o (keep original) ", COLORS.dim) +
    "> ";

  const answer = promptTTY(promptText);
  writeStderr("");

  if (answer === "Y" || answer === "") {
    // Accept: write suggested message synchronously (async write before exit loses bytes)
    if (result.suggested_message) {
      writeCommitMessageFile(commitFilePath, result.suggested_message + "\n");
      writeStderr(color("  Commit message updated.", COLORS.green));
    }
    return;
  }

  if (answer === "E") {
    // Edit: open $EDITOR with suggested message pre-filled
    openEditor(commitFilePath, result.suggested_message || commitMessage);
    return;
  }

  // N or anything else: keep original message, proceed
  writeStderr(color("  Keeping your original message.", COLORS.dim));
}
