# WebFluent for VS Code

Highlighting for WebFluent's `.wf` and `.wfx` files, and the language server
that checks them as you type.

- **Diagnostics** — the compiler's own errors and warnings, with the line.
- **Completion** — elements, their props, flags, events and slots, from the
  compiler's registry.
- **Hover, signature help, go to definition, references, rename** across
  the project.
- **Formatting, folding, inlay types and semantic highlighting.**
- **Quick fixes** and *Extract component*.

## The language server

The extension runs `wf-lsp`. It looks for it in this order:

1. the `webfluent.server.path` setting;
2. `wf-lsp` in an absolute directory on your `PATH`;
3. `target/release` or `target/debug` in the workspace (the compiler's own
   checkout) — only when `webfluent.server.useWorkspaceBuild` is on in your
   user settings and the workspace is trusted;
4. otherwise it downloads the `wf-lsp` of the WebFluent release this version
   of the extension pins, for your platform, checks it against that
   release's `SHA256SUMS`, and keeps it. A download that does not match is
   refused; a server checked by an earlier start is used instead.

A workspace's own `.vscode/settings.json` cannot choose the program that
runs: in a workspace you have not trusted, `webfluent.server.path` and
`webfluent.server.useWorkspaceBuild` are read from your user settings only
(the extension runs in restricted mode there), and `useWorkspaceBuild` is
never read from a workspace at all.

Releases are built for x86_64 Linux, macOS (Apple Silicon and Intel) and
x86_64 Windows. Elsewhere, build it with `cargo build --release -p wf-lsp`
from a clone and point `webfluent.server.path` at it.

## Settings

| Setting | Default | |
|---|---|---|
| `webfluent.server.path` | `""` | The `wf-lsp` to run. A workspace's value counts only once you trust it. |
| `webfluent.server.useWorkspaceBuild` | `false` | Run a `wf-lsp` built in the workspace's `target/`. User settings only. |
| `webfluent.server.download` | `true` | Download the pinned release's `wf-lsp` when it is not found. Off: highlighting only. |

## Links

- [WebFluent](https://github.com/monzeromer-lab/WebFluent) — the language,
  and where to report a problem with this extension.
- [Documentation](https://webfluent.monzeromer.dev)
