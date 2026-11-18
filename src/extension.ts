import * as fs from "fs";
import {
  CodeLens,
  EventEmitter,
  ExtensionContext,
  Location,
  ProgressLocation,
  TextDocument,
  commands,
  languages,
  window,
  workspace,
} from "vscode";
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
  scriptUses(context, client);
}

/** What `webfluent/scriptUses` answers: a name the script declares, where,
 * and every place that uses it. */
interface ScriptName {
  name: string;
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  uses: { uri: string; range: ScriptName["range"] }[];
  title: string;
}

/** A project's own scripts — the `.js` files under `src/` — are JavaScript,
 * which the built-in TypeScript service reads; what it cannot see is that a
 * page calls them. Over each name a script declares, a lens says where it
 * is used, and find-references lists the pages beside the scripts. The
 * server is not handed the script (it would be offered as its formatter and
 * its highlighter); it reads it from the disk, so this follows a save. Its
 * faded hint on a name nothing uses arrives as a diagnostic. */
function scriptUses(context: ExtensionContext, lsp: LanguageClient): void {
  const selector = [{ scheme: "file", language: "javascript", pattern: "**/src/**/*.{js,mjs,cjs}" }];
  const changed = new EventEmitter<void>();
  const asked = async (doc: TextDocument): Promise<ScriptName[]> => {
    try {
      return await lsp.sendRequest<ScriptName[]>("webfluent/scriptUses", { uri: doc.uri.toString() });
    } catch {
      return [];
    }
  };
  const p2c = lsp.protocol2CodeConverter;
  const locations = (uses: ScriptName["uses"]): Location[] =>
    uses.map((u) => new Location(p2c.asUri(u.uri), p2c.asRange(u.range)));

  context.subscriptions.push(
    changed,
    languages.registerCodeLensProvider(selector, {
      onDidChangeCodeLenses: changed.event,
      async provideCodeLenses(doc) {
        return (await asked(doc)).map((n) => {
          const range = p2c.asRange(n.range);
          return new CodeLens(range, {
            title: n.title,
            command: n.uses.length > 0 ? "editor.action.showReferences" : "",
            arguments: [doc.uri, range.start, locations(n.uses)],
          });
        });
      },
    }),
    languages.registerReferenceProvider(selector, {
      async provideReferences(doc, position) {
        const found = (await asked(doc)).find((n) => p2c.asRange(n.range).contains(position) ||
          doc.getText(doc.getWordRangeAtPosition(position)) === n.name);
        // Every use but this script's own, which the TypeScript service
        // lists already.
        return found ? locations(found.uses).filter((l) => l.uri.toString() !== doc.uri.toString()) : [];
      },
    }),
    // A server's lens elsewhere (another editor's) names this command.
    commands.registerCommand("webfluent.showReferences", (uri: string, position, uses) =>
      commands.executeCommand(
        "editor.action.showReferences",
        p2c.asUri(uri),
        p2c.asPosition(position),
        locations(uses ?? []),
      ),
    ),
    // A save of a page or a script may change who uses what.
    workspace.onDidSaveTextDocument((doc) => {
      if (["webfluent", "javascript"].includes(doc.languageId)) changed.fire();
    }),
  );
}

export async function deactivate(): Promise<void> {
  if (client) {
    await client.stop();
    client = undefined;
  }
}
