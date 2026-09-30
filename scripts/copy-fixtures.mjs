import { mkdirSync, cpSync } from "node:fs";
mkdirSync("dist/test/fixtures", {recursive:true});
cpSync("src/test/fixtures", "dist/test/fixtures", {recursive:true});
