// The TextMate grammar, read by the engine VS Code reads it with. It has no
// parser behind it, only patterns, so each test names a line of WebFluent
// and the scope one of its pieces must carry.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const vsctm = require("vscode-textmate");
const oniguruma = require("vscode-oniguruma");

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const grammarPath = path.join(root, "syntaxes", "webfluent.tmLanguage.json");

await oniguruma.loadWASM(fs.readFileSync(require.resolve("vscode-oniguruma/release/onig.wasm")).buffer);
const registry = new vsctm.Registry({
  onigLib: Promise.resolve({
    createOnigScanner: (patterns) => new oniguruma.OnigScanner(patterns),
    createOnigString: (s) => new oniguruma.OnigString(s),
  }),
  loadGrammar: async () => vsctm.parseRawGrammar(fs.readFileSync(grammarPath, "utf8"), grammarPath),
});
const grammar = await registry.loadGrammar("source.webfluent");

/** Every piece of `source` with its scopes, line by line. */
function tokenize(source) {
  let stack = vsctm.INITIAL;
  const pieces = [];
  for (const line of source.split("\n")) {
    const result = grammar.tokenizeLine(line, stack);
    for (const t of result.tokens) {
      pieces.push({ text: line.slice(t.startIndex, t.endIndex), scopes: t.scopes.join(" ") });
    }
    stack = result.ruleStack;
  }
  return pieces;
}

/** The scopes of the first piece of `source` whose text is `text`. */
function scopesOf(source, text) {
  const piece = tokenize(source).find((p) => p.text.trim() === text);
  assert.ok(piece, `no piece \`${text}\` in:\n${source}`);
  return piece.scopes;
}

function expectScope(source, text, scope) {
  const scopes = scopesOf(source, text);
  assert.ok(scopes.includes(scope), `\`${text}\` is ${scopes}, not ${scope}`);
}

function expectNoScope(source, text, scope) {
  const scopes = scopesOf(source, text);
  assert.ok(!scopes.includes(scope), `\`${text}\` is ${scopes}, and should not be ${scope}`);
}

test("every property of a style block is a property name", () => {
  const src = "Card {\n    style {\n        padding: 1rem\n        --accent: {tone}\n    }\n}";
  expectScope(src, "padding", "support.type.property-name.css");
  expectScope(src, "--accent", "support.type.property-name.css");
});

test("two declarations on one line, two spaces apart", () => {
  const src = "theme Brand { color-primary: #0F766E  radius-md: 14px }";
  expectScope(src, "theme", "keyword.declaration.webfluent");
  expectScope(src, "radius-md", "support.type.property-name.css");
  expectScope("Row { style { padding: 0  margin: 0 } }", "margin", "support.type.property-name.css");
});

test("a comment after a style value is a comment", () => {
  expectScope("Card {\n    style {\n        --accent: {tone}  // follows state\n    }\n}", "// follows state", "comment.line.double-slash.webfluent");
});

test("a block written by indentation (.wfx)", () => {
  const src = [
    "theme Brand",
    "    color-primary: #0F766E",
    "page Home(path: \"/\")",
    "    Card",
    "        style",
    "            padding: 6px 0",
    "            &:hover",
    "                background: $surface",
    "        on click",
    "            draft = \"\"",
  ].join("\n");
  expectScope(src, "color-primary", "support.type.property-name.css");
  expectScope(src, "page", "keyword.declaration.webfluent");
  expectNoScope(src, "page", "meta.theme.webfluent");
  expectScope(src, "padding", "support.type.property-name.css");
  expectScope(src, "&:hover", "entity.name.tag.selector.webfluent");
  expectScope(src, "background", "support.type.property-name.css");
  expectScope(src, "on", "keyword.other.event.webfluent");
  expectNoScope(src, "on", "meta.style-block.webfluent");
});

test("keyframes", () => {
  const src = "animation Pulse { from { opacity: 1 } 50% { opacity: 0.4 } }";
  expectScope(src, "50%", "entity.other.keyframe-offset.webfluent");
  expectScope(src, "opacity", "support.type.property-name.css");
});

test("the language's own literals", () => {
  expectScope("state c: Color = #0F766E", "#0F766E", "constant.other.color.webfluent");
  expectScope("state d = 1.second", "1.second", "constant.numeric.duration.webfluent");
  expectScope("state t = @09:30:15", "@09:30:15", "constant.other.time.webfluent");
  expectScope("const S = ###\"a \"## b\"###", "a \"## b", "string.quoted.raw.webfluent");
});

test("a regular expression, and division", () => {
  expectScope("derived ok = /^[\\w.]+$/.test(email)", "^[\\w.]+$", "string.regexp.webfluent");
  expectScope("derived half = total / 2", "/", "keyword.operator.arithmetic.webfluent");
});

test("a splice's format, and braces that open no splice", () => {
  const src = "Text(\"Total: {total:.currency} and { a: 1 }\")";
  expectScope(src, "currency", "support.function.format.webfluent");
  expectNoScope(src, "and { a: 1 }", "meta.interpolation.webfluent");
});

test("operators", () => {
  const src = "derived city = user?.address ?? [...rest, 1..=n]";
  expectScope(src, "?.", "punctuation.accessor.optional.webfluent");
  expectScope(src, "??", "keyword.operator.null-coalescing.webfluent");
  expectScope(src, "...", "keyword.operator.spread.webfluent");
  expectScope(src, "..=", "keyword.operator.range.webfluent");
});

test("keywords, and keywords used as a name", () => {
  expectScope("worker css = spawn(\"/w.js\")", "worker", "keyword.declaration.webfluent");
  expectScope("Form(bind: form, show: .onBlur) { }", "show", "variable.parameter.named.webfluent");
  expectScope("show open { }", "show", "keyword.control.webfluent");
});

test("a doc comment and an allowed finding", () => {
  expectScope("/// A person, at a glance.", "/// A person, at a glance.", "comment.line.documentation.webfluent");
  expectScope("Text(x) // wf-allow(U01, T05)", "wf-allow", "keyword.other.directive.allow.webfluent");
});
