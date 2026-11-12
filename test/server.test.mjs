// `src/server.ts` in plain Node: finding `wf-lsp`, naming the release asset
// for each platform, checking a download against SHA256SUMS, which settings
// may choose the server, and — with WF_NETWORK_TESTS=1 — downloading the
// pinned release's server and talking LSP to it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const bundle = path.join(os.tmpdir(), `wf-vscode-server-${process.pid}.cjs`);
await build({
  entryPoints: [path.join(here, "..", "src", "server.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: bundle,
  logLevel: "silent",
});
const server = createRequire(import.meta.url)(bundle);

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "wf-vscode-"));
const touch = (p) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, "");
  return p;
};

test("the asset is named as release.yml names it, for every platform it builds", () => {
  const t = "v4.0.1";
  assert.equal(server.assetName(t, "linux", "x64"), "wf-lsp-v4.0.1-x86_64-linux.tar.gz");
  assert.equal(server.assetName(t, "darwin", "arm64"), "wf-lsp-v4.0.1-aarch64-macos.tar.gz");
  assert.equal(server.assetName(t, "darwin", "x64"), "wf-lsp-v4.0.1-x86_64-macos.tar.gz");
  assert.equal(server.assetName(t, "win32", "x64"), "wf-lsp-v4.0.1-x86_64-windows.zip");
});

test("no asset is invented for a platform the release does not build", () => {
  assert.equal(server.assetName("v4.0.1", "linux", "arm64"), undefined);
  assert.equal(server.assetName("v4.0.1", "win32", "arm64"), undefined);
  assert.equal(server.assetName("v4.0.1", "freebsd", "x64"), undefined);
});

test("on Windows the server is wf-lsp.exe — it used to look for wf-lsp and never find it", () => {
  const exists = (f) => f === "C:\\Tools\\wf-lsp.exe" || f === "/opt/tools/wf-lsp.exe";
  assert.equal(server.onPath("C:\\Tools", "win32", exists), "C:\\Tools\\wf-lsp.exe");
  assert.equal(server.onPath('"C:\\Tools"', "win32", exists), "C:\\Tools\\wf-lsp.exe");
  assert.equal(server.onPath("/opt/tools", "linux", exists), undefined);
});

test("PATH is searched in order, and a directory named wf-lsp is not the server", () => {
  const [a, b] = [tmp(), tmp()];
  fs.mkdirSync(path.join(a, "wf-lsp"));
  touch(path.join(b, "wf-lsp"));
  assert.equal(server.onPath([a, b].join(path.delimiter), "linux"), path.join(b, "wf-lsp"));
  assert.equal(server.onPath("", "linux"), undefined);
});

test("a server built in the workspace is found, release before debug", () => {
  const root = tmp();
  const debug = touch(path.join(root, "target", "debug", "wf-lsp"));
  assert.equal(server.inFolders([root], "linux"), debug);
  const release = touch(path.join(root, "target", "release", "wf-lsp"));
  assert.equal(server.inFolders([root], "linux"), release);
});

test("the newest download is picked by version, not by spelling", () => {
  const storage = tmp();
  for (const tag of ["v4.0.9", "v4.0.10", "v4.0.2"]) touch(path.join(storage, tag, server.executableName()));
  fs.mkdirSync(path.join(storage, "v4.1.0")); // a download that never finished
  assert.equal(server.newestDownloaded(storage), path.join(storage, "v4.0.10", server.executableName()));
  assert.equal(server.newestDownloaded(path.join(storage, "nowhere")), undefined);
});

// Speaks the first message of the protocol and waits for the answer.
function initialize(binary) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [], { stdio: ["pipe", "pipe", "ignore"] });
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { processId: null, rootUri: null, capabilities: {} } });
    let out = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("no answer to initialize"));
    }, 10_000);
    child.stdout.on("data", (d) => {
      out += d;
      const at = out.indexOf("\r\n\r\n");
      if (at >= 0) {
        const length = Number(/Content-Length: (\d+)/i.exec(out.slice(0, at))?.[1]);
        if (out.length >= at + 4 + length) {
          clearTimeout(timer);
          child.kill();
          resolve(JSON.parse(out.slice(at + 4, at + 4 + length)));
        }
      }
    });
    child.on("error", reject);
    child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  });
}

test("the pinned release's server downloads, checks out, starts and answers initialize", { skip: !process.env.WF_NETWORK_TESTS }, async (t) => {
  const storage = tmp();
  const tag = server.SERVER_VERSION;
  try {
    await server.get(server.assetUrl(tag, "SHA256SUMS"));
  } catch (error) {
    if (/answered 404/.test(error.message)) {
      t.skip(`WebFluent ${tag} is not released yet (or has no SHA256SUMS)`);
      return;
    }
    throw error;
  }
  const binary = await server.fetchServer(storage);
  assert.equal(binary, path.join(storage, tag, server.executableName()));
  assert.ok(!fs.existsSync(`${path.dirname(binary)}.partial`), "the partial download was moved into place");

  const reply = await initialize(binary);
  assert.equal(reply.id, 1);
  assert.ok(reply.result?.capabilities, "the server announced its capabilities");

  // A second start serves the copy already downloaded.
  const mtime = fs.statSync(binary).mtimeMs;
  assert.equal(await server.fetchServer(storage), binary);
  assert.equal(fs.statSync(binary).mtimeMs, mtime);
});

// ---- The download is checked before it is unpacked -------------------------

const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");

// A release, served by a fake `fetch`: the archive for this platform and a
// SHA256SUMS that names it (or does not).
function fakeRelease(tag, { tamper = false, sums = true } = {}) {
  const work = tmp();
  fs.writeFileSync(path.join(work, server.executableName()), "#!/bin/sh\necho fake wf-lsp\n", { mode: 0o755 });
  const name = server.assetName(tag);
  const archive = path.join(work, name);
  execFileSync("tar", ["-czf", archive, "-C", work, server.executableName()]);
  const good = fs.readFileSync(archive);
  const files = new Map();
  files.set(name, tamper ? Buffer.concat([good, Buffer.from("x")]) : good);
  if (sums) files.set("SHA256SUMS", Buffer.from(`${sha256(good)}  ${name}\n${"0".repeat(64)}  other.zip\n`));
  const asked = [];
  const fetch = async (url) => {
    asked.push(url);
    const file = decodeURIComponent(url.split("/").pop());
    if (!url.startsWith(`https://github.com/${server.REPO}/releases/download/${tag}/`) || !files.has(file)) {
      throw new Error(`${url} answered 404`);
    }
    return files.get(file);
  };
  return { fetch, asked };
}

const canPack = process.platform !== "win32" && server.assetName("v1.0.0") !== undefined;

test("SHA256SUMS is read as sha256sum writes it", () => {
  const sums = server.parseSums(`${"A".repeat(64)}  wf-lsp-v1.0.0-x86_64-linux.tar.gz\n${"b".repeat(64)} *wf.zip\r\nnot a line\n`);
  assert.equal(sums.get("wf-lsp-v1.0.0-x86_64-linux.tar.gz"), "a".repeat(64));
  assert.equal(sums.get("wf.zip"), "b".repeat(64));
  assert.equal(sums.size, 2);
});

test("verify refuses a file the sums do not list, or list differently", () => {
  const data = Buffer.from("server");
  const sums = new Map([["a", sha256(data)]]);
  server.verify(data, "a", sums);
  assert.throws(() => server.verify(Buffer.from("other"), "a", sums), /does not match/);
  assert.throws(() => server.verify(data, "b", sums), /lists no b/);
});

test("the pinned release is downloaded by its tag, never `latest`", { skip: !canPack }, async () => {
  const storage = tmp();
  const { fetch, asked } = fakeRelease("v1.2.3");
  const binary = await server.fetchServer(storage, "v1.2.3", fetch);
  assert.equal(binary, path.join(storage, "v1.2.3", server.executableName()));
  assert.ok(asked.every((u) => u.includes("/releases/download/v1.2.3/")), asked.join("\n"));
  assert.ok(!asked.some((u) => u.includes("latest")));
  assert.match(server.SERVER_VERSION, /^v\d+\.\d+\.\d+$/);
});

test("a tampered archive is refused, and nothing is installed", { skip: !canPack }, async () => {
  const storage = tmp();
  const { fetch } = fakeRelease("v1.2.3", { tamper: true });
  await assert.rejects(server.fetchServer(storage, "v1.2.3", fetch), /does not match the release's SHA256SUMS/);
  assert.equal(server.downloadedFor(storage, "v1.2.3"), undefined);
  assert.equal(server.newestDownloaded(storage), undefined);
});

test("a release without SHA256SUMS is refused", { skip: !canPack }, async () => {
  const storage = tmp();
  const { fetch } = fakeRelease("v1.2.3", { sums: false });
  await assert.rejects(server.fetchServer(storage, "v1.2.3", fetch), /SHA256SUMS/);
  assert.equal(server.downloadedFor(storage, "v1.2.3"), undefined);
});

test("a tag that is not vX.Y.Z is refused before anything is fetched", async () => {
  let asked = 0;
  await assert.rejects(server.fetchServer(tmp(), "latest", async () => (asked++, Buffer.alloc(0))), /vX\.Y\.Z/);
  assert.equal(asked, 0);
});

test("only HTTPS is fetched", async () => {
  await assert.rejects(server.get("http://example.com/x"), /not HTTPS/);
});

// ---- A workspace cannot choose the server ----------------------------------

test("PATH entries that are empty, `.` or relative are never searched", () => {
  const cwd = process.cwd();
  const dir = tmp();
  touch(path.join(dir, "wf-lsp"));
  process.chdir(dir);
  try {
    assert.equal(server.onPath(":.:rel", "linux"), undefined);
    assert.equal(server.onPath(`.:${dir}`, "linux"), path.join(dir, "wf-lsp"));
    assert.equal(server.onPath(".;;bin", "win32"), undefined);
  } finally {
    process.chdir(cwd);
  }
});

test("server.path from a workspace counts only once the workspace is trusted", () => {
  const inspected = { defaultValue: "", globalValue: "/usr/local/bin/wf-lsp", workspaceValue: "/bin/sh" };
  assert.equal(server.serverPathSetting(inspected, false), "/usr/local/bin/wf-lsp");
  assert.equal(server.serverPathSetting(inspected, true), "/bin/sh");
  assert.equal(server.serverPathSetting({ defaultValue: "", workspaceFolderValue: "./x" }, false), undefined);
  assert.equal(server.serverPathSetting({ defaultValue: "", globalValue: "  " }, true), undefined);
  assert.equal(server.serverPathSetting(undefined, true), undefined);
});

test("useWorkspaceBuild is read from the user's settings alone", () => {
  assert.equal(server.userLevel({ defaultValue: false, workspaceValue: true }, false), false);
  assert.equal(server.userLevel({ defaultValue: false, workspaceFolderValue: true }, false), false);
  assert.equal(server.userLevel({ defaultValue: false, globalValue: true, workspaceValue: false }, false), true);
  assert.equal(server.userLevel(undefined, false), false);
});

test("the manifest scopes the settings that choose a program, and restricts them in untrusted workspaces", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(here, "..", "package.json"), "utf8"));
  const props = manifest.contributes.configuration.properties;
  assert.equal(props["webfluent.server.path"].scope, "machine-overridable");
  assert.equal(props["webfluent.server.useWorkspaceBuild"].scope, "application");
  assert.equal(props["webfluent.server.useWorkspaceBuild"].default, false);
  const untrusted = manifest.capabilities.untrustedWorkspaces;
  assert.equal(untrusted.supported, "limited");
  assert.deepEqual(untrusted.restrictedConfigurations.sort(), [
    "webfluent.server.path",
    "webfluent.server.useWorkspaceBuild",
  ]);
});
