/**
 * installer.ts
 *
 * Handles: install, uninstall, doctor subcommands.
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import process from "node:process";

// Injected at build time via package.json version
const VERSION = process.env.npm_package_version ?? "0.1.0";

const HOOK_FILENAME = "commit-msg";
const HOOK_MARKER = "# installed by commit-lie-detector";

function getGitRoot(): string {
  try {
    return execSync("git rev-parse --show-toplevel", {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new Error("Not inside a git repository. Run this command from within a git repo.");
  }
}

function getGitDir(): string {
  try {
    return execSync("git rev-parse --git-dir", {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new Error("Cannot locate .git directory.");
  }
}

function getHooksDir(): string {
  const gitDir = getGitDir();
  // git-dir might be relative — resolve against cwd
  const resolved = path.resolve(gitDir);
  return path.join(resolved, "hooks");
}

/** Detect if husky or lefthook is managing hooks */
function detectHookManager(gitRoot: string): "husky" | "lefthook" | null {
  if (fs.existsSync(path.join(gitRoot, ".husky"))) return "husky";
  if (
    fs.existsSync(path.join(gitRoot, ".lefthook.yml")) ||
    fs.existsSync(path.join(gitRoot, "lefthook.yml"))
  ) {
    return "lefthook";
  }
  return null;
}

function buildHookScript(version: string): string {
  return `#!/bin/sh
${HOOK_MARKER} v${version}
# commit-lie-detector — https://github.com/anigmea/commit-lie-detector
#
# This hook evaluates your commit message against the staged diff.
# Set COMMIT_LIE_SKIP=1 to bypass. Add [skip-check] to message to skip once.
# Uninstall: npx --no commit-lie-detector uninstall

if ! command -v npx > /dev/null 2>&1; then
  echo "commit-lie-detector: npx not found — skipping check." >&2
  exit 0
fi

if [ -z "$ANTHROPIC_API_KEY" ] && [ -z "$OPENAI_API_KEY" ]; then
  echo "commit-lie-detector: no API key set (ANTHROPIC_API_KEY or OPENAI_API_KEY) — skipping check." >&2
  exit 0
fi

npx --no commit-lie-detector _hook "$1"
`;
}

function buildHuskySnippet(version: string): string {
  return `# Add to .husky/commit-msg:
npx --no commit-lie-detector _hook "$1"`;
}

function buildLefthookSnippet(version: string): string {
  return `# Add to lefthook.yml:
commit-msg:
  commands:
    lie-detector:
      run: npx --no commit-lie-detector _hook {1}`;
}

// ── install ───────────────────────────────────────────────────────────────────

export function install(): void {
  const gitRoot = getGitRoot();
  const hooksDir = getHooksDir();
  const hookPath = path.join(hooksDir, HOOK_FILENAME);
  const hookManager = detectHookManager(gitRoot);

  // Warn if a hook manager is present
  if (hookManager) {
    const snippet =
      hookManager === "husky"
        ? buildHuskySnippet(VERSION)
        : buildLefthookSnippet(VERSION);

    console.error(
      `\ncommit-lie-detector: detected ${hookManager} — writing to .git/hooks/ would be overridden.\n`
    );
    console.error(`Add this snippet to your ${hookManager} config instead:\n`);
    console.error(snippet);
    console.error(
      "\nhttps://github.com/anigmea/commit-lie-detector#hook-manager-integration\n"
    );
    // Still exit 0 — user can integrate manually
    return;
  }

  // Ensure hooks directory exists
  fs.mkdirSync(hooksDir, { recursive: true });

  // Backup existing hook if it doesn't have our marker
  if (fs.existsSync(hookPath)) {
    const existing = fs.readFileSync(hookPath, "utf8");
    if (!existing.includes(HOOK_MARKER)) {
      const backupPath = hookPath + ".bak";
      fs.copyFileSync(hookPath, backupPath);
      console.error(`  Backed up existing hook to ${backupPath}`);
    }
  }

  const script = buildHookScript(VERSION);
  fs.writeFileSync(hookPath, script, { encoding: "utf8", mode: 0o755 });

  // Ensure executable
  try {
    execSync(`chmod +x "${hookPath}"`, { stdio: "ignore" });
  } catch {
    // chmod not available on Windows — the mode: 0o755 above should suffice
  }

  console.log(`\n  commit-lie-detector installed to ${hookPath}`);
  console.log(`  Run \`git commit\` to try it out.\n`);
  console.log(
    `  Set ANTHROPIC_API_KEY or OPENAI_API_KEY to enable. Uninstall: npx commit-lie-detector uninstall\n`
  );
}

// ── uninstall ─────────────────────────────────────────────────────────────────

export function uninstall(): void {
  const hooksDir = getHooksDir();
  const hookPath = path.join(hooksDir, HOOK_FILENAME);

  if (!fs.existsSync(hookPath)) {
    console.log("  commit-lie-detector: no hook found — nothing to uninstall.");
    return;
  }

  const content = fs.readFileSync(hookPath, "utf8");
  if (!content.includes(HOOK_MARKER)) {
    console.error(
      "  commit-lie-detector: hook at " + hookPath + " was not installed by this tool — not removing."
    );
    console.error("  Remove it manually if needed.");
    return;
  }

  // Check if backup exists to restore
  const backupPath = hookPath + ".bak";
  if (fs.existsSync(backupPath)) {
    fs.copyFileSync(backupPath, hookPath);
    fs.unlinkSync(backupPath);
    console.log(`  Restored previous hook from ${backupPath}`);
  } else {
    fs.unlinkSync(hookPath);
    console.log(`  Removed ${hookPath}`);
  }

  console.log("  commit-lie-detector uninstalled.\n");
}

// ── doctor ────────────────────────────────────────────────────────────────────

interface DoctorCheck {
  label: string;
  ok: boolean;
  detail?: string;
}

export function doctor(): void {
  const checks: DoctorCheck[] = [];

  // Git available
  let gitVersion = "";
  try {
    gitVersion = execSync("git --version", { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
    checks.push({ label: "git available", ok: true, detail: gitVersion });
  } catch {
    checks.push({ label: "git available", ok: false, detail: "git not found in PATH" });
  }

  // Inside a git repo
  let gitRoot = "";
  try {
    gitRoot = getGitRoot();
    checks.push({ label: "inside git repo", ok: true, detail: gitRoot });
  } catch (err: any) {
    checks.push({ label: "inside git repo", ok: false, detail: err.message });
  }

  // Hook installed
  let hookOk = false;
  let hookDetail = "";
  if (gitRoot) {
    try {
      const hooksDir = getHooksDir();
      const hookPath = path.join(hooksDir, HOOK_FILENAME);
      if (fs.existsSync(hookPath)) {
        const content = fs.readFileSync(hookPath, "utf8");
        hookOk = content.includes(HOOK_MARKER);
        const versionMatch = content.match(HOOK_MARKER + " v([\\d.]+)");
        hookDetail = hookOk
          ? `installed (v${versionMatch?.[1] ?? "?"})`
          : "exists but not installed by commit-lie-detector";
      } else {
        hookDetail = "not installed — run: npx commit-lie-detector install";
      }
    } catch (err: any) {
      hookDetail = err.message;
    }
    checks.push({ label: "hook installed", ok: hookOk, detail: hookDetail });
  }

  // API key
  const hasAnthropic = Boolean(process.env.ANTHROPIC_API_KEY);
  const hasOpenAI = Boolean(process.env.OPENAI_API_KEY);
  if (hasAnthropic || hasOpenAI) {
    const keys = [hasAnthropic ? "ANTHROPIC_API_KEY" : null, hasOpenAI ? "OPENAI_API_KEY" : null]
      .filter(Boolean)
      .join(", ");
    checks.push({ label: "API key", ok: true, detail: `set: ${keys}` });
  } else {
    checks.push({
      label: "API key",
      ok: false,
      detail: "neither ANTHROPIC_API_KEY nor OPENAI_API_KEY is set",
    });
  }

  // Node version
  const nodeVersion = process.version;
  const nodeMajor = parseInt(nodeVersion.slice(1), 10);
  checks.push({
    label: "Node.js version",
    ok: nodeMajor >= 18,
    detail: nodeVersion + (nodeMajor < 18 ? " (requires >=18)" : ""),
  });

  // Hook manager detection
  if (gitRoot) {
    const mgr = detectHookManager(gitRoot);
    if (mgr) {
      checks.push({
        label: "hook manager",
        ok: false,
        detail: `${mgr} detected — manual integration required (see README)`,
      });
    }
  }

  // ── Print report ──────────────────────────────────────────────────────────
  const isTTY = process.stdout.isTTY;
  const green = isTTY ? "\x1b[32m" : "";
  const red = isTTY ? "\x1b[31m" : "";
  const reset = isTTY ? "\x1b[0m" : "";
  const dim = isTTY ? "\x1b[2m" : "";

  console.log("\n  commit-lie-detector doctor\n");
  for (const check of checks) {
    const icon = check.ok ? green + "✓" + reset : red + "✗" + reset;
    const detail = check.detail ? dim + "  " + check.detail + reset : "";
    console.log(`  ${icon}  ${check.label}${detail}`);
  }

  const allOk = checks.every((c) => c.ok);
  console.log("");
  if (allOk) {
    console.log(green + "  All checks passed." + reset + "\n");
  } else {
    console.log(red + "  Some checks failed — see details above." + reset + "\n");
    process.exitCode = 1;
  }
}
