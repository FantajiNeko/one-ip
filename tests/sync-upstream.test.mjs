import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const workflow = readFileSync(
  new URL("../.github/workflows/sync-upstream.yml", import.meta.url),
  "utf8",
).replaceAll("\r\n", "\n");
const script = workflow.split("        run: |\n")[1].replace(/^ {10}/gm, "");

// Run the actual workflow's Bash and env wiring against a simulated GitHub API.
// The API reproduces GitHub's refusal to update workflows with GITHUB_TOKEN.
function runSync({ token = "", workflowsChanged = false, changed = true, conflict = false, parent = "zhihui-hu/one-ip", deploy = "true" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "one-ip-sync-"));
  const context = {
    "github.token": "builtin-token",
    "github.repository": "owner/fork",
    "vars.ENABLE_CF_DEPLOY": deploy,
    "secrets.UPSTREAM_SYNC_TOKEN": token,
  };
  const workflowEnv = Object.fromEntries(
    [...workflow.matchAll(/^ {6}([A-Z_]+): \$\{\{ ([\w.]+) \}\}$/gm)].map(
      ([, name, expression]) => {
        assert.ok(expression in context, `Unsupported env context: ${expression}`);
        return [name, context[expression]];
      },
    ),
  );
  try {
    writeFileSync(join(dir, "gh"), String.raw`#!/usr/bin/env node
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
const env = process.env;
appendFileSync(env.STUB_DIR + "/calls", JSON.stringify({ args, credential: env.GH_TOKEN }) + "\n");
if (args[0] === "api" && args.some(arg => arg.endsWith("/merge-upstream"))) {
  if (env.STUB_CONFLICT === "true") {
    console.error("gh: Merge conflict (HTTP 409)");
    process.exit(1);
  }
  if (env.STUB_WORKFLOWS_CHANGED === "true" && env.GH_TOKEN !== "sync-token") {
    console.error("gh: refusing to allow a GitHub App to create or update workflow .github/workflows/pages.yml without workflows permission (HTTP 422)");
    process.exit(1);
  }
  console.log(JSON.stringify({ message: "Successfully synced" }));
} else if (args[0] === "api" && args[1].includes("/commits/")) {
  const state = env.STUB_DIR + "/read-commit";
  console.log(existsSync(state) && env.STUB_CHANGED === "true" ? "after" : "before");
  writeFileSync(state, "1");
} else if (args[0] === "api" && args[1] === "repos/owner/fork") {
  console.log(JSON.stringify({ parent: { full_name: env.STUB_PARENT }, default_branch: "main" }));
} else if (args[0] === "workflow" && args[1] === "run") {
  console.log("Dispatched build workflow");
} else {
  console.error("Unexpected gh call: " + JSON.stringify(args));
  process.exit(1);
}
`, { mode: 0o755 });
    writeFileSync(join(dir, "jq"), String.raw`#!/usr/bin/env node
const { readFileSync } = require("node:fs");
const path = process.argv.at(-1).split(".").filter(Boolean);
console.log(path.reduce((value, key) => value[key], JSON.parse(readFileSync(0, "utf8"))));
`, { mode: 0o755 });
    const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", script], {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        ...workflowEnv,
        PATH: `${dir}:${process.env.PATH}`,
        STUB_DIR: dir,
        STUB_WORKFLOWS_CHANGED: String(workflowsChanged),
        STUB_CHANGED: String(changed),
        STUB_CONFLICT: String(conflict),
        STUB_PARENT: parent,
      },
    });
    assert.ifError(result.error);
    const calls = readFileSync(join(dir, "calls"), "utf8").trim().split("\n").map(JSON.parse);
    return { ...result, calls, output: result.stdout + result.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const dispatches = result => result.calls.filter(call => call.args[0] === "workflow");
const merges = result => result.calls.filter(call => call.args.includes("POST"));

test("syncs upstream workflow changes using the configured credential", () => {
  const result = runSync({ token: "sync-token", workflowsChanged: true });
  assert.equal(result.status, 0, result.output);
  assert.equal(merges(result)[0].credential, "sync-token");
  assert.equal(result.calls[0].credential, "builtin-token");
  assert.equal(dispatches(result).length, 0, "credential pushes already trigger the push workflow");
});

test("explains how to fix workflow permission failures", () => {
  const result = runSync({ workflowsChanged: true });
  assert.notEqual(result.status, 0);
  assert.match(result.output, /HTTP 422/);
  assert.match(result.output, /UPSTREAM_SYNC_TOKEN/);
  assert.equal(dispatches(result).length, 0);
});

test("keeps builtin-token synchronization and explicitly dispatches deployment", () => {
  const result = runSync();
  assert.equal(result.status, 0, result.output);
  assert.equal(merges(result)[0].credential, "builtin-token");
  assert.equal(dispatches(result).length, 1);
  assert.deepEqual(dispatches(result)[0].args, ["workflow", "run", "pages.yml", "--repo", "owner/fork", "--ref", "main"]);
});

test("does not dispatch when nothing changed or deployment is disabled", () => {
  for (const options of [{ changed: false }, { deploy: "" }]) {
    const result = runSync(options);
    assert.equal(result.status, 0, result.output);
    assert.equal(dispatches(result).length, 0);
  }
});

test("preserves conflicts as failures without force-resetting the fork", () => {
  const result = runSync({ token: "sync-token", conflict: true });
  assert.notEqual(result.status, 0);
  assert.match(result.output, /HTTP 409/);
  assert.doesNotMatch(result.output, /UPSTREAM_SYNC_TOKEN/);
  assert.equal(dispatches(result).length, 0);
  assert.equal(result.calls.some(call => call.args.some(arg => arg.includes("force"))), false);
});

test("leaves forks of other repositories untouched", () => {
  const result = runSync({ parent: "someone/else" });
  assert.equal(result.status, 0, result.output);
  assert.equal(merges(result).length, 0);
  assert.equal(dispatches(result).length, 0);
});
