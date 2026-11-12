// Finding `wf-lsp`, and fetching it when it is nowhere to be found.
//
// Nothing here imports `vscode`, so it runs — and is tested — in plain Node.
// The download mirrors the Zed extension: one pinned WebFluent release, the
// asset named as the compiler's `.github/workflows/release.yml` names it,
// checked against that release's `SHA256SUMS` before it is unpacked, and
// kept per release so a failed download still has a checked copy to serve.

import * as crypto from "crypto";
import * as fs from "fs";
import * as https from "https";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

export const REPO = "monzeromer-lab/WebFluent";

/**
 * The WebFluent release whose server this extension downloads. A release of
 * the extension is tested against it; raise it (and release the extension)
 * after a compiler release. Never `latest`: whoever could replace the latest
 * release would otherwise choose what every editor runs on its next start.
 */
export const SERVER_VERSION = "v5.15.0";

const SERVER = "wf-lsp";
const USER_AGENT = "webfluent-vscode (https://github.com/monzeromer-lab/WebFluent)";

/** The server's file name on this platform. */
export function executableName(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? `${SERVER}.exe` : SERVER;
}

/**
 * The release asset built for a platform, or `undefined` where the release
 * builds none: x86_64 on Linux, macOS and Windows, and arm64 on macOS.
 */
export function assetName(
  tag: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | undefined {
  const os =
    platform === "linux" ? "linux" : platform === "darwin" ? "macos" : platform === "win32" ? "windows" : undefined;
  const cpu = arch === "x64" ? "x86_64" : arch === "arm64" ? "aarch64" : undefined;
  if (!os || !cpu || (cpu === "aarch64" && os !== "macos")) {
    return undefined;
  }
  return `${SERVER}-${tag}-${cpu}-${os}.${os === "windows" ? "zip" : "tar.gz"}`;
}

/**
 * The server on `PATH`. Only absolute entries are searched: an empty entry,
 * `.` or any relative one names whatever folder VS Code was started in,
 * which may be the project just opened.
 */
export function onPath(
  envPath: string = process.env.PATH ?? "",
  platform: NodeJS.Platform = process.platform,
  exists: (file: string) => boolean = isFile,
): string | undefined {
  const name = executableName(platform);
  const p = platform === "win32" ? path.win32 : path.posix;
  for (const raw of envPath.split(platform === "win32" ? ";" : ":")) {
    const dir = platform === "win32" ? raw.trim().replace(/^"(.*)"$/, "$1") : raw;
    if (!dir || !p.isAbsolute(dir)) continue;
    if (platform === "win32" && !/^([a-zA-Z]:[\\/]|\\\\)/.test(dir)) continue;
    const candidate = p.join(dir, name);
    if (exists(candidate)) return candidate;
  }
  return undefined;
}

/**
 * A server built in one of these folders — the compiler's own checkout.
 * Only consulted when the user turns `webfluent.server.useWorkspaceBuild`
 * on in their own settings: a folder someone else wrote could hold any
 * `target/release/wf-lsp`.
 */
export function inFolders(folders: string[], platform: NodeJS.Platform = process.platform): string | undefined {
  const name = executableName(platform);
  for (const root of folders) {
    for (const profile of ["release", "debug"]) {
      const candidate = path.join(root, "target", profile, name);
      if (isFile(candidate)) return candidate;
    }
  }
  return undefined;
}

/** What `WorkspaceConfiguration.inspect` reports for one setting. */
export interface Inspected<T> {
  defaultValue?: T;
  globalValue?: T;
  workspaceValue?: T;
  workspaceFolderValue?: T;
}

/**
 * A setting as the user's own settings say it, ignoring what a workspace
 * says: for the switches that decide which program runs.
 */
export function userLevel<T>(inspected: Inspected<T> | undefined, fallback: T): T {
  return inspected?.globalValue ?? inspected?.defaultValue ?? fallback;
}

/**
 * `webfluent.server.path`: a workspace (or folder) may set it only once the
 * user has trusted that workspace; otherwise only the user's own value
 * counts. VS Code applies the same rule through `restrictedConfigurations`;
 * this holds when it does not.
 */
export function serverPathSetting(inspected: Inspected<string> | undefined, trusted: boolean): string | undefined {
  const fromWorkspace = trusted ? inspected?.workspaceFolderValue ?? inspected?.workspaceValue : undefined;
  const value = (fromWorkspace ?? inspected?.globalValue ?? "").trim();
  return value || undefined;
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** A GET that follows GitHub's redirects to where a release asset lives. HTTPS only. */
export function get(url: string, redirects = 5): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (!url.startsWith("https://")) return reject(new Error(`refusing to fetch ${url}: not HTTPS`));
    const request = https.get(url, { headers: { "User-Agent": USER_AGENT, Accept: "*/*" } }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (redirects <= 0) return reject(new Error(`too many redirects fetching ${url}`));
        return resolve(get(new URL(res.headers.location, url).toString(), redirects - 1));
      }
      if (status !== 200) {
        res.resume();
        return reject(new Error(`${url} answered ${status}`));
      }
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });
    request.setTimeout(60_000, () => request.destroy(new Error(`timed out fetching ${url}`)));
    request.on("error", reject);
  });
}

/** Where a release's asset is served from. */
export function assetUrl(tag: string, name: string, repo: string = REPO): string {
  return `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
}

/** `SHA256SUMS` as a map from file name to lower-case hex digest. */
export function parseSums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line.trim());
    if (m) sums.set(m[2], m[1].toLowerCase());
  }
  return sums;
}

/** Throws unless `data` is the file `SHA256SUMS` lists as `name`. */
export function verify(data: Buffer, name: string, sums: Map<string, string>): void {
  const want = sums.get(name);
  if (!want) throw new Error(`SHA256SUMS lists no ${name}; refusing a download that cannot be checked`);
  const have = crypto.createHash("sha256").update(data).digest("hex");
  if (have !== want) {
    throw new Error(`${name} does not match the release's SHA256SUMS (expected ${want}, got ${have}); not installed`);
  }
}

/** The server downloaded for `tag`, if an earlier start fetched and checked it. */
export function downloadedFor(storage: string, tag: string): string | undefined {
  const candidate = path.join(storage, tag, executableName());
  return isFile(candidate) ? candidate : undefined;
}

/** The newest release downloaded before, for when the download fails. */
export function newestDownloaded(storage: string): string | undefined {
  let tags: string[];
  try {
    tags = fs.readdirSync(storage).filter((t) => /^v[0-9]+\.[0-9]+\.[0-9]+$/.test(t));
  } catch {
    return undefined;
  }
  const byVersion = (t: string) => t.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  tags.sort((a, b) => {
    const [x, y] = [byVersion(a), byVersion(b)];
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
    }
    return 0;
  });
  for (const tag of tags) {
    const found = downloadedFor(storage, tag);
    if (found) return found;
  }
  return undefined;
}

/**
 * The server of the pinned release: the copy already downloaded for it, or
 * a fresh download, checked against the release's `SHA256SUMS` before it is
 * unpacked. `tar` unpacks both archive kinds — Windows has shipped one that
 * reads `.zip` since Windows 10. `fetch` is replaceable for the tests.
 */
export async function fetchServer(
  storage: string,
  tag: string = SERVER_VERSION,
  fetch: (url: string) => Promise<Buffer> = get,
): Promise<string> {
  if (!/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(tag)) throw new Error(`a release is vX.Y.Z, not ${tag}`);
  const have = downloadedFor(storage, tag);
  if (have) return have;

  const name = assetName(tag);
  if (!name) {
    throw new Error(
      `no wf-lsp is built for ${process.platform}/${process.arch}; build it with ` +
        "`cargo build --release -p wf-lsp` and set `webfluent.server.path`",
    );
  }

  const sums = parseSums((await fetch(assetUrl(tag, "SHA256SUMS"))).toString("utf8"));
  const data = await fetch(assetUrl(tag, name));
  verify(data, name, sums);

  const dir = path.join(storage, tag);
  const partial = `${dir}.partial`;
  fs.rmSync(partial, { recursive: true, force: true });
  fs.mkdirSync(partial, { recursive: true });
  const archive = path.join(partial, name);
  fs.writeFileSync(archive, data);
  await promisify(execFile)("tar", ["-xf", archive, "-C", partial]);
  fs.rmSync(archive);
  const binary = path.join(partial, executableName());
  if (!isFile(binary) || fs.lstatSync(binary).isSymbolicLink()) {
    throw new Error(`${name} did not contain ${executableName()}`);
  }
  if (process.platform !== "win32") fs.chmodSync(binary, 0o755);
  // Moved into place whole, so an interrupted download never looks finished.
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(partial, dir);
  return path.join(dir, executableName());
}
