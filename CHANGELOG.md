# Changelog

## Unreleased

- Highlighting brought up to WebFluent 5: every property of a `style`
  block is coloured as one (only `-`-prefixed ones were); a theme's tokens
  and an animation's keyframes are coloured as CSS; two declarations on
  one line, two spaces apart, are two; a `.wfx` file's `style`,
  `transition`, nested rules, `theme` and `animation` written by
  indentation are coloured as their braced spelling is; `on click`,
  `head`, `cleanup`, `step` and match arms that end a line too.
- New: `worker`, colour literals (`#0F766E`), regular expressions,
  `?.`, `??`, `...` and ranges, a splice's format (`{total:.currency}`),
  singular duration units (`1.second`), times with seconds, `///` doc
  comments and `// wf-allow(…)`. A keyword written as an argument's name
  (`show: .onBlur`, `in: .local`) is a name, and a `{` that opens no splice
  (`"{ a: 1 }"`) is text.
- The grammar is tested with the engine VS Code reads it with.

## 0.5.0

- WebFluent 5.9: `Popover`, `Frame`, `Splitter` and `VirtualList` are
  highlighted as components.

## 0.4.0

- WebFluent 4.2: `external` is no longer highlighted as a keyword — the
  language removed it.
- The language server is told when a `.js` or `.css` file changes, so a
  script's functions and a stylesheet's classes are current in completion,
  hover and diagnostics without reopening the file.

## 0.3.0

- Highlighting for WebFluent 4: `api` services and their endpoints,
  `socket`, `stream` and `channel`, `validate`, `test` and its steps,
  `const`, `image`, `data`, `try`/`catch`, the eleven scalar types, date,
  time, money and duration literals, raw and block strings, and a string
  inside a splice. Every built-in component is recognised.
- The language server is downloaded from the latest release when it is not
  on `PATH`, and kept for the next start.
- `wf-lsp.exe` is found on Windows, where only `wf-lsp` was looked for.
- The extension ships as one bundle. The package before this one left the
  language client out and could not start.
- New settings: `webfluent.server.path`, `webfluent.server.download`.
- Needs VS Code 1.82 or later.

## 0.2.0

- `.wfx` files, and the `wf-lsp` language client.
