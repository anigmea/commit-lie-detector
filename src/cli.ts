#!/usr/bin/env node
/**
 * cli.ts — commit-lie-detector CLI entry point
 *
 * Subcommands:
 *   install    — install git commit-msg hook
 *   uninstall  — remove hook
 *   check      — evaluate staged diff vs message (non-interactive, for scripts/CI)
 *   suggest    — generate commit message from staged diff
 *   doctor     — check environment and configuration
 *   _hook      — internal: called by the hook script (not for direct use)
 *
 * Flags:
 *   --conventional   — use Conventional Commits format
 *   --quality        — use higher-quality model (claude-sonnet-4-6 or gpt-4o)
 *   --strict         — exit 1 on lie (instead of offering rewrite)
 *   --suggest-always — show suggested message even when honest
 *   --copy           — copy output to clipboard (suggest subcommand)
 *   --verbose        — show more output
 */

import process from "node:process";
import { readStagedDiff } from "./diff-reader.js";
import { suggest as llmSuggest, evaluate, type LLMError } from "./llm.js";
import { install, uninstall, doctor } from "./installer.js";
import { runHook } from "./hook-runner.js";
import { execSync } from "node:child_process";

const VERSION = process.env.npm_package_version ?? "0.1.0";

function parseFlags(args: string[]): {
  subcommand: string | undefined;
  positional: string[];
  conventional: boolean;
  quality: boolean;
  strict: boolean;
  suggestAlways: boolean;
  copy: boolean;
  verbose: boolean;
} {
  const flags = {
    conventional: false,
    quality: false,
    strict: false,
    suggestAlways: false,
    copy: false,
    verbose: false,
  };
  const positional: string[] = [];

  for (const arg of args) {
    switch (arg) {
      case "--conventional":
        flags.conventional = true;
        break;
      case "--quality":
        flags.quality = true;
        break;
      case "--strict":
        flags.strict = true;
        break;
      case "--suggest-always":
        flags.suggestAlways = true;
        break;
      case "--copy":
        flags.copy = true;
        break;
      case "--verbose":
      case "-v":
        flags.verbose = true;
        break;
      default:
        if (!arg.startsWith("--")) positional.push(arg);
    }
  }

  return { subcommand: positional[0], positional, ...flags };
}

function printHelp(): void {
  console.log(`
  commit-lie-detector v${VERSION}

  An LLM-powered git hook that catches misleading commit messages.

  Usage:
    npx commit-lie-detector <subcommand> [flags]

  Subcommands:
    install      Install the commit-msg git hook in the current repo
    uninstall    Remove the installed hook
    check        Evaluate staged diff vs a commit message (non-interactive)
                   Usage: commit-lie-detector check "your message"
    suggest      Generate a commit message from staged changes
                   Usage: commit-lie-detector suggest [--copy] [--conventional] [--quality]
    doctor       Check environment, API keys, and hook status

  Flags:
    --conventional   Use Conventional Commits format in output
    --quality        Use a higher-quality model (slower, more accurate)
    --strict         Exit 1 on lie instead of offering interactive rewrite
    --suggest-always Show suggested message even on honest commits
    --copy           Copy output to clipboard (suggest subcommand)
    --verbose, -v    Show more output

  API keys (one required):
    ANTHROPIC_API_KEY   — uses claude-haiku-4-5-20251001 (or --quality: claude-sonnet-4-6)
    OPENAI_API_KEY      — uses gpt-4o-mini (or --quality: gpt-4o)
    Anthropic is preferred when both are set.

  Skip options:
    COMMIT_LIE_SKIP=1   — bypass check for one commit (env var)
    [skip-check]        — add to commit message to bypass once

  Examples:
    npx commit-lie-detector install
    npx commit-lie-detector check "fix typo"
    git commit -m "$(npx commit-lie-detector suggest)"
    npx commit-lie-detector suggest --conventional --copy

  https://github.com/anigmea/commit-lie-detector
`);
}

function copyToClipboard(text: string): void {
  try {
    if (process.platform === "darwin") {
      const proc = execSync("pbcopy", { input: text, stdio: ["pipe", "ignore", "ignore"] });
    } else if (process.platform === "linux") {
      try {
        execSync("xclip -selection clipboard", { input: text, stdio: ["pipe", "ignore", "ignore"] });
      } catch {
        execSync("xsel --clipboard --input", { input: text, stdio: ["pipe", "ignore", "ignore"] });
      }
    } else {
      // Windows: clip
      execSync("clip", { input: text, stdio: ["pipe", "ignore", "ignore"] });
    }
  } catch {
    // Graceful skip — clipboard not available
    process.stderr.write("commit-lie-detector: clipboard copy unavailable on this platform.\n");
  }
}

function handleLLMError(err: any, operation: string): never {
  const msg = (err as LLMError)?.message ?? err?.message ?? String(err);
  process.stderr.write(`commit-lie-detector: ${operation} failed — ${msg}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const { subcommand, positional, conventional, quality, strict, suggestAlways, copy, verbose } =
    parseFlags(args);

  if (!subcommand || subcommand === "--help" || subcommand === "-h" || subcommand === "help") {
    printHelp();
    return;
  }

  if (subcommand === "--version" || subcommand === "version") {
    console.log(VERSION);
    return;
  }

  switch (subcommand) {
    // ── install ────────────────────────────────────────────────────────────
    case "install": {
      try {
        install();
      } catch (err: any) {
        process.stderr.write(`Error: ${err.message}\n`);
        process.exit(1);
      }
      break;
    }

    // ── uninstall ──────────────────────────────────────────────────────────
    case "uninstall": {
      try {
        uninstall();
      } catch (err: any) {
        process.stderr.write(`Error: ${err.message}\n`);
        process.exit(1);
      }
      break;
    }

    // ── doctor ─────────────────────────────────────────────────────────────
    case "doctor": {
      doctor();
      break;
    }

    // ── check ──────────────────────────────────────────────────────────────
    // Non-interactive evaluation: for scripts and CI.
    // Usage: commit-lie-detector check "your commit message"
    case "check": {
      const commitMessage = positional[1];
      if (!commitMessage) {
        process.stderr.write('Usage: commit-lie-detector check "your commit message"\n');
        process.exit(1);
      }

      const diff = readStagedDiff();
      if (diff.isEmpty) {
        process.stderr.write("commit-lie-detector check: no staged changes.\n");
        process.exit(0);
      }

      let result;
      try {
        result = await evaluate(commitMessage, diff, { conventional, quality });
      } catch (err) {
        handleLLMError(err, "check");
      }

      // Output JSON to stdout (machine-readable)
      process.stdout.write(JSON.stringify(result) + "\n");

      if (!result!.honest) {
        if (result!.accusation) {
          process.stderr.write(`Lie detected: ${result!.accusation}\n`);
        }
        if (result!.suggested_message) {
          process.stderr.write(`Suggested: ${result!.suggested_message}\n`);
        }
        process.exit(1);
      }

      if (verbose) {
        process.stderr.write(`Honest (confidence ${(result!.confidence * 100).toFixed(0)}%)\n`);
      }
      break;
    }

    // ── suggest ────────────────────────────────────────────────────────────
    case "suggest": {
      const diff = readStagedDiff();
      if (diff.isEmpty) {
        process.stderr.write("commit-lie-detector suggest: no staged changes to describe.\n");
        process.exit(1);
      }

      let message: string;
      try {
        message = await llmSuggest(diff, { conventional, quality });
      } catch (err) {
        handleLLMError(err, "suggest");
      }

      // Output to stdout — designed for piping: git commit -m "$(cld suggest)"
      process.stdout.write(message! + "\n");

      if (copy) {
        copyToClipboard(message!);
        if (verbose) process.stderr.write("Copied to clipboard.\n");
      }
      break;
    }

    // ── _hook ──────────────────────────────────────────────────────────────
    // Internal subcommand: invoked by the generated shell hook script.
    // Receives the commit-msg file path as argv[3].
    case "_hook": {
      const commitFilePath = positional[1];
      if (!commitFilePath) {
        process.stderr.write("commit-lie-detector: _hook requires a file path argument.\n");
        process.exit(0); // don't block commit on internal error
      }

      try {
        await runHook(commitFilePath, { conventional, quality, strict, suggestAlways, verbose });
      } catch (err: any) {
        // Never block a commit due to our own errors
        process.stderr.write(`commit-lie-detector: unexpected error — ${err.message}\n`);
      }
      break;
    }

    default: {
      process.stderr.write(`commit-lie-detector: unknown subcommand "${subcommand}"\n`);
      process.stderr.write('Run "commit-lie-detector help" for usage.\n');
      process.exit(1);
    }
  }
}

main().catch((err) => {
  process.stderr.write(`commit-lie-detector: fatal error — ${err.message}\n`);
  process.exit(1);
});
