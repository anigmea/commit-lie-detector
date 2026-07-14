import { execSync } from "node:child_process";
import path from "node:path";

const MAX_DIFF_LINES = 4000;

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

const GENERATED_PATTERN = /\.generated\.|\.gen\.|_generated\./i;
const LOCK_EXT_PATTERN = /\.lock$/i;

function isFilteredFile(filePath: string): boolean {
  const base = path.basename(filePath);
  if (LOCK_FILE_BASENAMES.has(base)) return true;
  if (GENERATED_PATTERN.test(base)) return true;
  if (LOCK_EXT_PATTERN.test(base)) return true;
  return false;
}

export interface DiffResult {
  stat: string;
  diff: string;
  truncated: boolean;
  totalLines: number;
  filteredFiles: string[];
  isEmpty: boolean;
}

export function readStagedDiff(): DiffResult {
  let stat = "";
  let rawDiff = "";

  try {
    stat = execSync("git diff --staged --stat", {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    stat = "";
  }

  try {
    rawDiff = execSync("git diff --staged", {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 50 * 1024 * 1024,
    });
  } catch {
    rawDiff = "";
  }

  if (!rawDiff.trim() && !stat) {
    return { stat: "", diff: "", truncated: false, totalLines: 0, filteredFiles: [], isEmpty: true };
  }

  // Filter files: split by diff --git header, remove filtered files
  const chunks = splitDiffByFile(rawDiff);
  const filteredFiles: string[] = [];
  const keptChunks: string[] = [];

  for (const chunk of chunks) {
    const match = chunk.match(/^diff --git a\/(.*?) b\/(.*?)$/m);
    const filePath = match?.[2] ?? match?.[1] ?? "";

    // Strip binary hunks, keep the diff --git header line
    const isBinary = /^Binary files/.test(chunk.replace(/^diff --git[^\n]*\n/, ""));
    if (isBinary) {
      // Keep the binary file notice in stat, skip the hunk from diff body
      continue;
    }

    if (filePath && isFilteredFile(filePath)) {
      filteredFiles.push(filePath);
      continue;
    }

    keptChunks.push(chunk);
  }

  const joined = keptChunks.join("\n");
  const lines = joined.split("\n");
  const totalLines = lines.length;
  let truncated = false;
  let finalDiff = joined;

  if (totalLines > MAX_DIFF_LINES) {
    truncated = true;
    finalDiff =
      lines.slice(0, MAX_DIFF_LINES).join("\n") +
      `\n# [TRUNCATED: showing first ${MAX_DIFF_LINES} of ${totalLines} lines]`;
  }

  const isEmpty = !finalDiff.trim() && !stat.trim();

  return {
    stat,
    diff: finalDiff,
    truncated,
    totalLines,
    filteredFiles,
    isEmpty,
  };
}

function splitDiffByFile(diff: string): string[] {
  const chunks: string[] = [];
  const parts = diff.split(/(?=^diff --git )/m);
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed) chunks.push(trimmed);
  }
  return chunks;
}
