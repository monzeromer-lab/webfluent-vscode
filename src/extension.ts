import * as fs from "fs";
import { ExtensionContext, ProgressLocation, window, workspace } from "vscode";
import {
  Executable,
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
} from "vscode-languageclient/node";
import {
  SERVER_VERSION,
  fetchServer,
  inFolders,
  newestDownloaded,
  onPath,
  serverPathSetting,
  userLevel,
} from "./server";

let client: LanguageClient | undefined;

/**
 * Where the language server is, in this order: the `webfluent.server.path`
 * setting (a workspace's value only once the workspace is trusted); `wf-lsp`
 * on PATH; one built in the workspace, only when the user's own settings
 * turn `webfluent.server.useWorkspaceBuild` on; and otherwise the pinned
 * release's, checked against its SHA256SUMS, downloaded once and kept.
 */
async function findServer(context: ExtensionContext): Promise<string | undefined> {
  const config = workspace.getConfiguration("webfluent");
  const configured = serverPathSetting(config.inspect<string>("server.path"), workspace.isTrusted);
  if (configured) {
    if (fs.existsSync(configured)) return configured;
    window.showErrorMessage(`WebFluent: \`webfluent.server.path\` names ${configured}, which does not exist.`);
    return undefined;
  }

  const fromPath = onPath();
  if (fromPath) return fromPath;

  if (workspace.isTrusted && userLevel(config.inspect<boolean>("server.useWorkspaceBuild"), false)) {
    const built = inFolders((workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath));
    if (built) return built;
  }

  if (!config.get<boolean>("server.download", true)) {
    window.showWarningMessage(
      "WebFluent: `wf-lsp` is not on PATH and downloading it is turned off " +
        "(`webfluent.server.download`). Highlighting works; diagnostics and completion need the server.",
    );
    return undefined;
  }

  const storage = context.globalStorageUri.fsPath;
  try {
    return await window.withProgress(
      { location: ProgressLocation.Window, title: `WebFluent: fetching wf-lsp ${SERVER_VERSION}` },
      () => fetchServer(storage),
    );
  } catch (error) {
    // No network, or the pinned release not published yet: a server
    // downloaded and checked by an earlier start still serves.
    const cached = newestDownloaded(storage);
    if (cached) return cached;
    window.showWarningMessage(
      `WebFluent: could not get wf-lsp ${SERVER_VERSION} (${(error as Error).message}). ` +
        "Highlighting works; for diagnostics and completion, install wf-lsp on PATH or set `webfluent.server.path`.",
    );
    return undefined;
  }
}

export async function activate(context: ExtensionContext): Promise<void> {
  const serverPath = await findServer(context);
  if (!serverPath) return;

  const run: Executable = { command: serverPath, args: [] };
  const serverOptions: ServerOptions = { run, debug: run };
  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: "file", language: "webfluent" }],
    synchronize: {
      // A script or a stylesheet under src/ is part of the project too.
      fileEvents: workspace.createFileSystemWatcher("**/*.{wf,wfx,js,css}"),
    },
  };

  client = new LanguageClient("webfluent", "WebFluent Language Server", serverOptions, clientOptions);
  await client.start();
}

export async function deactivate(): Promise<void> {
  if (client) {
    await client.stop();
    client = undefined;
  }
}
