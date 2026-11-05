import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Reports locations only; never prints the matched data. */
export function inspectPrivacy(file, content) {
  const findings = [];
  const normalizedFile = file.replaceAll(String.fromCharCode(92), "/");
  const forbiddenFile = /(?:^|\/)(?:\.env(?:\.(?!example$|template$)[^/]*)?|id_rsa|id_ed25519|auth\.json|credentials\.json)$|\.(?:pem|key|jks|keystore|p12|pfx)$/i;
  if (forbiddenFile.test(normalizedFile) || /^design\/spike\/real-snapshot.*\.json$/.test(normalizedFile)
    || (normalizedFile.startsWith("design/spike/scratch/") && normalizedFile !== "design/spike/scratch/e2e-ok.txt")) {
    findings.push({ file, line: 1, reason: "private file or raw capture" });
  }
  if (content.includes(0)) return findings;
  const lines = content.toString("utf8").split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const normalized = line.split(String.fromCharCode(92)).join("/").replace(/\/{2,}/g, "/");
    const homes = [...normalized.matchAll(/(?:[A-Za-z]:\/Users\/|\/home\/)([A-Za-z0-9_.-]+)/g)];
    if (homes.some((match) => !/^(?:example|user|username|Public|Default)$/i.test(match[1]))) {
      findings.push({ file, line: index + 1, reason: "personal home directory" });
    }
    if (/\b[A-Za-z0-9._%+-]+@(?:qq\.com|gmail\.com|outlook\.com|163\.com)\b/i.test(line)) {
      findings.push({ file, line: index + 1, reason: "personal email" });
    }
    if (/-----BEGIN (?:OPENSSH |RSA |EC |DSA |ENCRYPTED )?PRIVATE KEY-----/.test(line)
      || /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-(?:proj-|ant-)?[A-Za-z0-9_-]{24,}|AKIA[A-Z0-9]{16})\b/.test(line)) {
      findings.push({ file, line: index + 1, reason: "credential marker" });
    }
  }
  return findings;
}

function main() {
  // Never enumerate or read untracked files, especially local session captures.
  const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
  const findings = files.flatMap((file) => inspectPrivacy(file, readFileSync(file)));
  for (const finding of findings) console.error(`${finding.file}:${finding.line}: ${finding.reason}`);
  if (findings.length) process.exitCode = 1;
  else console.log(`Privacy checks passed for ${files.length} tracked files (pattern checks, not a guarantee of complete secret detection).`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
