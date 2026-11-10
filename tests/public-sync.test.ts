import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectExport, mergePackage, publicize, publicLock, validateContent } from "../scripts/sync-from-private.js";

const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
const policy = { deniedLiterals: ["internal-only.example"] };

function fixture() {
  const dir = mkdtempSync(resolve(tmpdir(), "mcp-sync-test-")); temporary.push(dir);
  const source = resolve(dir, "private"), target = resolve(dir, "public");
  mkdirSync(resolve(source, "mcp/src"), { recursive: true }); mkdirSync(target);
  for (const repo of [source, target]) execFileSync("git", ["init", "-q", repo]);
  const pkg = { name: "example-mcp", version: "1.0.0", scripts: { start: "public-only" }, license: "MIT" };
  writeFileSync(resolve(target, "public-sync.manifest.json"), JSON.stringify({ schemaVersion: 1, files: ["src/index.ts"] }));
  writeFileSync(resolve(target, "package.json"), JSON.stringify(pkg));
  writeFileSync(resolve(source, "mcp/package.json"), JSON.stringify({ ...pkg, scripts: { postinstall: "private-only" } }));
  writeFileSync(resolve(source, "mcp/package-lock.json"), JSON.stringify({ name: pkg.name, version: pkg.version, packages: { "": { name: pkg.name, version: pkg.version } } }));
  writeFileSync(resolve(source, "mcp/src/index.ts"), "export const version = 1;\n");
  const commit = () => {
    execFileSync("git", ["-C", source, "add", "."]);
    execFileSync("git", ["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "Synthetic source"]);
  };
  commit(); return { source: resolve(source, "mcp"), target, commit };
}

describe("public export safety boundaries", () => {
  it("reads only allowlisted committed blobs and preserves public scripts", () => {
    const f = fixture();
    writeFileSync(resolve(f.source, ".env"), "API_KEY=never-read-this-value\n");
    mkdirSync(resolve(f.source, "deploy")); writeFileSync(resolve(f.source, "deploy/private.conf"), "internal-only.example");
    const result = collectExport(f.source, f.target, policy);
    expect([...result.files.keys()]).toEqual(["src/index.ts", "package.json", "package-lock.json"]);
    expect(JSON.parse(result.files.get("package.json")!).scripts).toEqual({ start: "public-only" });
    expect(readFileSync(resolve(f.target, "package.json"), "utf8")).not.toContain("postinstall");
  });
  it("rejects uncommitted tracked source changes", () => {
    const f = fixture(); writeFileSync(resolve(f.source, "src/index.ts"), "modified\n");
    expect(() => collectExport(f.source, f.target, policy)).toThrow("Commit tracked");
  });
  it("requires review for a new source file and refuses source symlinks", () => {
    const f = fixture(); writeFileSync(resolve(f.source, "src/new.ts"), "new\n"); f.commit();
    expect(() => collectExport(f.source, f.target, policy)).toThrow("explicit manifest review");
    rmSync(resolve(f.source, "src/new.ts")); rmSync(resolve(f.source, "src/index.ts"));
    symlinkSync("../package.json", resolve(f.source, "src/index.ts")); f.commit();
    expect(() => collectExport(f.source, f.target, policy)).toThrow("non-regular");
  });
  it("refuses source deletions and destination symlinks", () => {
    const f = fixture(); mkdirSync(resolve(f.target, "src"));
    symlinkSync(resolve(f.source, "src/index.ts"), resolve(f.target, "src/index.ts"));
    expect(() => collectExport(f.source, f.target, policy)).toThrow("Destination symlinks");
    rmSync(resolve(f.source, "src/index.ts")); f.commit();
    expect(() => collectExport(f.source, f.target, policy)).toThrow("Missing");
  });
  it("rejects an expanded manifest that would import configuration", () => {
    const f = fixture(); writeFileSync(resolve(f.target, "public-sync.manifest.json"), JSON.stringify({ schemaVersion: 1, files: [".env"] }));
    expect(() => collectExport(f.source, f.target, policy)).toThrow("outside the public code boundary");
  });
  it("blocks internal data without echoing the matching value", () => {
    for (const text of ["/Users/example/app/file", "10.1.2.3", "100.80.90.10", "real-customer.freshdesk.com", "someone@real-company.com", "internal-only.example", "binary\0value"]) {
      expect(() => validateContent("src/example.ts", text, policy)).toThrow();
    }
    expect(() => validateContent("src/example.ts", "internal-only.example", policy)).toThrow("Local privacy policy rejected src/example.ts");
    expect(() => validateContent("src/example.ts", "https://acme.freshdesk.com http://127.0.0.1:8788", policy)).not.toThrow();
  });
  it("applies the portable config transform and fails if its anchor changes", () => {
    const source = 'import { homedir } from "node:os";\nimport { join } from "node:path";\nconst path = join(homedir(), "Library", "Application Support", "BoucheCousue", "FreshdeskMCP", "freshdesk-mcp.sqlite3");';
    const result = publicize("src/config.ts", source);
    expect(result).toContain('resolve("var", "freshdesk-mcp.sqlite3")'); expect(result).not.toContain("homedir");
    expect(() => publicize("src/config.ts", "upstream changed")).toThrow("review the public transform");
    expect(publicize("src/oauth/html.ts", "sur le serveur de l’atelier; sur le Mac mini de l’atelier")).toBe("sur ce serveur MCP; sur ce serveur MCP");
  });
  it("keeps public package metadata while updating runtime dependencies", () => {
    const merged = JSON.parse(mergePackage(JSON.stringify({ name: "public", license: "MIT", scripts: { test: "safe" }, dependencies: { old: "1" } }), JSON.stringify({ name: "private", version: "2", dependencies: { updated: "2" }, scripts: { postinstall: "unsafe" }, homepage: "internal-only.example" })));
    expect(merged).toEqual({ name: "public", license: "MIT", version: "2", scripts: { test: "safe" }, dependencies: { updated: "2" } });
    expect(() => mergePackage("{}", JSON.stringify({ dependencies: { private: "file:../private" } }))).toThrow("registry dependency versions");
  });
  it("rejects credentials, local links, alternative registries and URL tokens in locks", () => {
    const pkg = JSON.stringify({ name: "public", version: "2", license: "MIT" });
    for (const resolved of ["https://user:password@registry.npmjs.org/pkg.tgz", "file:../private", "https://private.example/pkg.tgz", "https://registry.npmjs.org/pkg.tgz?token=example"]) {
      expect(() => publicLock(JSON.stringify({ packages: { "": {}, "node_modules/pkg": { resolved } } }), pkg)).toThrow();
    }
    expect(() => publicLock(JSON.stringify({ packages: { "": {}, "node_modules/pkg": { link: true } } }), pkg)).toThrow();
    const lock = JSON.parse(publicLock(JSON.stringify({ internalMetadata: "never-copy", packages: { "": { name: "private", internalMetadata: "never-copy" }, "node_modules/pkg": { resolved: "https://registry.npmjs.org/pkg/-/pkg-1.tgz" } } }), pkg));
    expect(lock.packages[""]).toEqual({ name: "public", version: "2", license: "MIT" });
    expect(JSON.stringify(lock)).not.toContain("never-copy");
  });
});
