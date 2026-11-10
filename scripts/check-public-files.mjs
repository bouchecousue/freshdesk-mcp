// Guard tracked files and documentation links without reading local runtime secrets.
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
const errors = [];
for (const file of files) {
  if (/(^|\/)(node_modules|dist|coverage|var|outputs|logs|backups|exports|__pycache__)(\/|$)/i.test(file)
      || /(^|\/)\.env(?:\..*)?$/.test(file) && file !== ".env.example"
      || /\.(sqlite[^/]*|db(?:-[^/]*)?|log|pem|key|p12|pfx|zip|tar|gz|pyc)$/i.test(file)) {
    errors.push(`Runtime or sensitive artifact must not be tracked: ${file}`);
  }
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.size > 1024 * 1024) errors.push(`Unexpected file type or size: ${file}`);
  if (!file.endsWith(".md")) continue;
  const markdown = readFileSync(file, "utf8");
  for (const match of markdown.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const link = match[1].split("#")[0];
    if (!link || /^[a-z]+:/i.test(link)) continue;
    if (!existsSync(resolve(dirname(file), decodeURIComponent(link)))) errors.push(`Broken link in ${file}: ${link}`);
  }
}
if (errors.length) {
  process.stderr.write(errors.join("\n") + "\n");
  process.exitCode = 1;
} else {
  process.stdout.write(`Checked ${files.length} tracked files and local Markdown links.\n`);
}
