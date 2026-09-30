import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { parseEvaluateResult } from "../llm.js";

describe("Release contract", () => {
  it("supports --version and --help", () => {
    assert.equal(execFileSync(process.execPath, ["dist/cli.js", "--version"], {encoding:"utf8"}).trim(), "0.1.0");
    assert.match(execFileSync(process.execPath, ["dist/cli.js", "--help"], {encoding:"utf8"}), /Usage:/);
  });
  it("accepts valid responses and enforces the confidence threshold", () => {
    const value = {honest:true, accusation:null, suggested_message:"fix: validate response", confidence:0.9};
    assert.equal(parseEvaluateResult(JSON.stringify(value), "original").honest, true);
    assert.equal(parseEvaluateResult(JSON.stringify({...value, confidence:0.2}), "original").honest, false);
  });
  it("rejects malformed or coerced values", () => {
    for (const value of ["null", "{}", 'not-json', JSON.stringify({honest:"false",accusation:null,suggested_message:"x",confidence:0.8}), JSON.stringify({honest:true,accusation:null,suggested_message:"",confidence:0.8})]) {
      assert.throws(() => parseEvaluateResult(value,"original"));
    }
  });
});

import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readStagedDiff } from "../diff-reader.js";

describe("Installation and ignored diffs", () => {
  it("installs/uninstalls without touching an existing unmanaged hook", () => {
    const dir = mkdtempSync(join(tmpdir(), "cld-install-"));
    const cli = join(process.cwd(), "dist/cli.js");
    try {
      execFileSync("git", ["init", "-q"], {cwd:dir});
      execFileSync(process.execPath, [cli,"install"], {cwd:dir});
      assert.ok(existsSync(join(dir,".git/hooks/commit-msg")));
      execFileSync(process.execPath, [cli,"uninstall"], {cwd:dir});
      assert.ok(!existsSync(join(dir,".git/hooks/commit-msg")));
    } finally { rmSync(dir,{recursive:true,force:true}); }
  });
  it("does not call an LLM for generated/lock-only changes", () => {
    const dir = mkdtempSync(join(tmpdir(), "cld-filter-"));
    const cwd = process.cwd();
    try {
      execFileSync("git",["init","-q"],{cwd:dir});
      writeFileSync(join(dir,"package-lock.json"),"{}\n");
      execFileSync("git",["add","package-lock.json"],{cwd:dir});
      process.chdir(dir);
      assert.equal(readStagedDiff().isEmpty,true);
    } finally { process.chdir(cwd);rmSync(dir,{recursive:true,force:true}); }
  });
});
