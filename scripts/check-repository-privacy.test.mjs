import assert from "node:assert/strict";
import test from "node:test";
import { inspectPrivacy } from "./check-repository-privacy.mjs";

const inspect = (file, text = "") => inspectPrivacy(file, Buffer.from(text));

test("blocks raw captures, credentials and signing files, while allowing templates", () => {
  for (const file of ["design/spike/real-snapshot.json", "design/spike/scratch/capture.json", ".env", ".env.production", "signing.jks", "auth.json"]) {
    assert.ok(inspect(file).length, file);
  }
  for (const file of [".env.example", ".env.template", "design/spike/synthetic-snapshot.json", "design/spike/scratch/e2e-ok.txt"]) {
    assert.deepEqual(inspect(file), []);
  }
});

test("recognizes escaped home directories and redacts all reported matches", () => {
  const privateHome = "C:/" + "Users/" + "alice/private";
  const escapedHome = JSON.stringify(privateHome.replaceAll("/", String.fromCharCode(92)));
  for (const content of [privateHome, escapedHome, "/home/" + "alice/private", "person@" + "qq.com"]) {
    const findings = inspect("fixture.json", content);
    assert.ok(findings.length);
    assert.ok(!JSON.stringify(findings).includes(content));
  }
  assert.deepEqual(inspect("fixture.json", "C:/" + "Users/example/project"), []);
});

test("blocks private keys and provider tokens without including their contents", () => {
  const key = ["-----BEGIN", "OPENSSH", "PRIVATE KEY-----"].join(" ");
  const token = "ghp_" + "a".repeat(36);
  for (const content of [key, token]) {
    const findings = inspect("fixture.txt", content);
    assert.equal(findings.length, 1);
    assert.ok(!JSON.stringify(findings).includes(content));
  }
});
