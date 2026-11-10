import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

interface Manifest { schemaVersion: number; files: string[] }
export interface ExportPolicy { deniedLiterals: string[] }
export interface ExportPlan { files: Map<string, string>; changed: string[] }

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });
}

function safePath(path: string): boolean {
  return !isAbsolute(path) && !path.split("/").some(part => part === ".." || part === "" || part === ".") && !path.includes("\\");
}

export function publicize(path: string, text: string): string {
  if (path === "src/config.ts") {
    // Rewrite only the known private default. An upstream change needs an explicit review.
    const oldDefault = 'join(homedir(), "Library", "Application Support", "BoucheCousue", "FreshdeskMCP", "freshdesk-mcp.sqlite3")';
    if (!text.includes(oldDefault)) throw new Error("Database default changed upstream; review the public transform.");
    text = text.replace(oldDefault, 'resolve("var", "freshdesk-mcp.sqlite3")')
      .replace('import { homedir } from "node:os";\n', "")
      .replace('import { join } from "node:path";', 'import { resolve } from "node:path";');
  }
  if (path === "src/oauth/html.ts") {
    text = text.replaceAll("sur le serveur de l’atelier", "sur ce serveur MCP")
      .replaceAll("sur le Mac mini de l’atelier", "sur ce serveur MCP");
  }
  return text;
}

export function validateContent(path: string, text: string, policy: ExportPolicy): void {
  if (Buffer.byteLength(text) > 1024 * 1024) throw new Error(`Source exceeds the reviewable size limit: ${path}`);
  if (text.includes("\0")) throw new Error(`Binary source is not allowed: ${path}`);
  if (/\/(?:Users|Volumes|home)\/[A-Za-z0-9_.-]+\//.test(text)) throw new Error(`Host-specific path in ${path}`);
  if (/\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])(?:\.\d{1,3}){2})\b/.test(text)) {
    throw new Error(`Private network address in ${path}`);
  }
  for (const match of text.matchAll(/\b([\w-]+)\.freshdesk\.com\b/gi)) {
    if (!["example", "acme", "your-tenant", "monentreprise", "cdn", "developers"].includes(match[1]!.toLowerCase())) {
      throw new Error(`Non-example Freshdesk hostname in ${path}`);
    }
  }
  for (const match of text.matchAll(/\b[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})\b/gi)) {
    if (!/^(?:example\.(?:com|org|net)|.+\.(?:example|test|invalid))$/i.test(match[1]!)) {
      throw new Error(`Non-example email address in ${path}`);
    }
  }
  if (policy.deniedLiterals.some(value => text.toLowerCase().includes(value.toLowerCase()))) {
    // Never echo a private literal, matching line, source hash or source remote.
    throw new Error(`Local privacy policy rejected ${path}`);
  }
}

export function mergePackage(publicText: string, privateText: string): string {
  const target = JSON.parse(publicText) as Record<string, unknown>;
  const source = JSON.parse(privateText) as Record<string, unknown>;
  // Keep public identity, license, URLs and scripts. Never import lifecycle/deploy scripts.
  for (const key of ["version", "engines", "dependencies", "devDependencies"]) {
    if (source[key] === undefined) delete target[key];
    else target[key] = source[key];
  }
  for (const key of ["dependencies", "devDependencies"]) {
    for (const version of Object.values((target[key] ?? {}) as Record<string, unknown>)) {
      if (typeof version !== "string" || /[:/@\\]/.test(version)) throw new Error("Only npm registry dependency versions are allowed.");
    }
  }
  return JSON.stringify(target, null, 2) + "\n";
}

export function publicLock(text: string, packageText: string): string {
  const lock = JSON.parse(text) as { name: string; version: string; packages: Record<string, Record<string, unknown>> };
  const pkg = JSON.parse(packageText) as Record<string, unknown>;
  if (!lock.packages?.[""]) throw new Error("Unsupported upstream lockfile.");
  for (const entry of Object.values(lock.packages)) {
    if (entry.link) throw new Error("Local dependency links are not allowed.");
    if (typeof entry.resolved !== "string") continue;
    const url = new URL(entry.resolved);
    if (url.protocol !== "https:" || url.hostname !== "registry.npmjs.org" || url.port || url.username || url.password || url.search || url.hash) {
      throw new Error("Only credential-free npm registry dependencies are allowed.");
    }
  }
  lock.name = String(pkg.name);
  lock.version = String(pkg.version);
  // Rebuild the root from the public package; discard any private project metadata.
  lock.packages[""] = Object.fromEntries(["name", "version", "dependencies", "devDependencies", "engines", "license"]
    .filter(key => pkg[key] !== undefined).map(key => [key, pkg[key]]));
  const incoming = JSON.parse(text) as { lockfileVersion?: number; requires?: boolean };
  return JSON.stringify({ name: lock.name, version: lock.version, lockfileVersion: incoming.lockfileVersion,
    requires: incoming.requires, packages: lock.packages }, null, 2) + "\n";
}

export function collectExport(sourceDir: string, targetDir: string, policy: ExportPolicy): ExportPlan {
  const source = realpathSync(sourceDir), target = realpathSync(targetDir);
  const sourceRoot = git(source, ["rev-parse", "--show-toplevel"]).trim();
  if (sourceRoot === git(target, ["rev-parse", "--show-toplevel"]).trim()) throw new Error("Source and target must be separate repositories.");
  const prefix = relative(sourceRoot, source).split(sep).join("/");
  const sourcePath = prefix ? prefix + "/" : "";
  if (git(sourceRoot, ["status", "--porcelain", "--untracked-files=no", "--", sourcePath || "."]).trim()) {
    throw new Error("Commit tracked private MCP changes before exporting. Untracked files are never read.");
  }
  const commit = git(sourceRoot, ["rev-parse", "--verify", "HEAD^{commit}"]).trim();
  const manifest = JSON.parse(readFileSync(resolve(target, "public-sync.manifest.json"), "utf8")) as Manifest;
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files) || new Set(manifest.files).size !== manifest.files.length) {
    throw new Error("Invalid public export manifest.");
  }
  for (const file of manifest.files) {
    if (!safePath(file) || !/^(?:src\/.*\.ts|tests\/.*\.ts|scripts\/(?:generate-master-key|import-semantic-export|index-semantic|usage-report)\.ts|scripts\/stream-semantic-export\.py|tsconfig(?:\.build)?\.json)$/.test(file)) {
      throw new Error("Manifest contains a file outside the public code boundary.");
    }
  }
  const tree = git(sourceRoot, ["ls-tree", "-r", "-z", commit, "--", sourcePath || "."]);
  const entries = new Map(tree.split("\0").filter(Boolean).map(line => {
    const tab = line.indexOf("\t");
    return [line.slice(tab + 1).slice(sourcePath.length), line.slice(0, tab).split(" ")[0]!];
  }));
  const unknown = [...entries.keys()].filter(file => /^(?:src|tests)\//.test(file) && !manifest.files.includes(file));
  if (unknown.length) throw new Error("New upstream source/test files need explicit manifest review before export.");
  const selected = [...manifest.files, "package.json", "package-lock.json"];
  const read = (file: string): string => {
    if (!["100644", "100755"].includes(entries.get(file) ?? "")) throw new Error(`Missing or non-regular committed source: ${file}`);
    return git(sourceRoot, ["show", `${commit}:${sourcePath}${file}`]);
  };
  const files = new Map<string, string>();
  for (const file of manifest.files) files.set(file, publicize(file, read(file)));
  const pkg = mergePackage(readFileSync(resolve(target, "package.json"), "utf8"), read("package.json"));
  files.set("package.json", pkg);
  files.set("package-lock.json", publicLock(read("package-lock.json"), pkg));
  for (const file of selected) validateContent(file, files.get(file)!, policy);
  const changed = [...files].filter(([file, content]) => {
    const destination = resolve(target, file);
    let parent = destination;
    while (parent !== target) {
      if (existsSync(parent) && lstatSync(parent).isSymbolicLink()) throw new Error(`Destination symlinks are not allowed: ${file}`);
      parent = dirname(parent);
    }
    return !existsSync(destination) || readFileSync(destination, "utf8") !== content;
  }).map(([file]) => file);
  return { files, changed };
}

export function scanPlan(plan: ExportPlan): void {
  const scratch = mkdtempSync(resolve(tmpdir(), "freshdesk-public-export-"));
  try {
    for (const [file, content] of plan.files) {
      const destination = resolve(scratch, file);
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      writeFileSync(destination, content, { mode: 0o600 });
    }
    try {
      execFileSync("gitleaks", ["dir", "--redact", "--no-banner", "--ignore-gitleaks-allow", scratch], {
        cwd: scratch, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, GITLEAKS_CONFIG: "", GITLEAKS_CONFIG_TOML: "" },
      });
    } catch {
      throw new Error("Gitleaks is missing or rejected the candidate export. Nothing was copied; inspect privately before retrying.");
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log("npm run sync:private -- --source /path/to/private/mcp [--policy /path/to/private/policy.json] [--apply]\nDefault: preview only. --apply: create a local branch and copy validated files. Never commits or pushes.");
    return;
  }
  const options = new Map<string, string>();
  let apply = false;
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (key === "--apply") { apply = true; continue; }
    if (!["--source", "--policy"].includes(key) || !args[i + 1] || args[i + 1]!.startsWith("--") || options.has(key)) throw new Error("Invalid arguments; use --help.");
    options.set(key, args[++i]!);
  }
  if (!options.has("--source")) throw new Error("--source is required; use --help.");
  const target = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  if (git(target, ["status", "--porcelain"]).trim()) throw new Error("Public checkout must be clean before synchronization.");
  const publicHead = git(target, ["rev-parse", "HEAD"]).trim();
  const policyPath = options.get("--policy");
  const policy = policyPath ? JSON.parse(readFileSync(resolve(policyPath), "utf8")) as ExportPolicy : { deniedLiterals: [] };
  if (!Array.isArray(policy.deniedLiterals) || policy.deniedLiterals.some(value => typeof value !== "string" || value.length < 3)) throw new Error("Invalid local privacy policy.");
  const plan = collectExport(options.get("--source")!, target, policy);
  scanPlan(plan);
  console.log(`Validated ${plan.files.size} committed code/package files; secret and privacy checks passed.`);
  console.log(plan.changed.length ? `Changes (${plan.changed.length}):\n${plan.changed.join("\n")}` : "Public code is already up to date.");
  if (!apply || !plan.changed.length) return;
  if (git(target, ["status", "--porcelain"]).trim() || git(target, ["rev-parse", "HEAD"]).trim() !== publicHead) {
    throw new Error("Public checkout changed during validation; no files copied.");
  }
  const branch = `codex/sync-mcp-${new Date().toISOString().replace(/[^0-9]/g, "")}`;
  git(target, ["switch", "-c", branch]);
  for (const file of plan.changed) {
    const destination = resolve(target, file);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, plan.files.get(file)!);
  }
  console.log(`Prepared local branch ${branch}. Review git diff, run npm ci and npm run check, then open a pull request. No commit or push was made.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    console.error(error instanceof Error ? error.message : "Public export failed.");
    process.exitCode = 1;
  }
}
