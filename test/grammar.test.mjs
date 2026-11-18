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

test("a name in any script is a name", () => {
  expectScope("state café = 1", "café", "variable.other.state.webfluent");
  expectScope("state عدد = 3", "عدد", "variable.other.state.webfluent");
  expectScope("state عددٌ = 3", "عددٌ", "variable.other.state.webfluent");
  expectScope("derived 二倍 = n * 2", "二倍", "variable.other.state.webfluent");
  expectScope("component Été(_ nom: String) { }", "Été", "entity.name.type.webfluent");
  expectScope("type Ωmega { x: Number }", "Ωmega", "entity.name.type.webfluent");
  expectScope("action زد(n: Number) { }", "زد", "entity.name.function.action.webfluent");
  expectScope("persist المهام = []", "المهام", "variable.other.declaration.webfluent");
  expectScope("Text(عدد(1), عنوان: \"x\")", "عدد", "entity.name.function.call.webfluent");
  expectScope("Text(عدد(1), عنوان: \"x\")", "عنوان", "variable.parameter.named.webfluent");
  expectScope("Text(\"{عدد} left\")", "عدد", "variable.other.readwrite.webfluent");
  expectScope("on نقر { }", "نقر", "entity.name.event.webfluent");
  expectScope("Row(gap: .واسع) { }", "واسع", "constant.other.enum-case.webfluent");
  expectScope("Button(\"x\").أساسي", "أساسي", "support.constant.flag.webfluent");
  expectScope("derived d = عدد.طول", "طول", "variable.other.property.webfluent");
});

test("a keyword run into a name in another script is no keyword", () => {
  expectNoScope("stateعدد = 1", "stateعدد", "keyword.other.state.webfluent");
  expectNoScope("ifé = 1", "ifé", "keyword.control.webfluent");
  expectNoScope("derived x = عددstate", "عددstate", "keyword.other.state.webfluent");
});

test("a `.name` after a name is a member, after a call or a component a flag", () => {
  const src = "Alert(e.message).danger.lg";
  expectScope(src, "message", "variable.other.property.webfluent");
  expectNoScope(src, "message", "support.constant.flag.webfluent");
  expectScope(src, "danger", "support.constant.flag.webfluent");
  expectScope(src, "lg", "support.constant.flag.webfluent");
  expectScope("Spinner.lg", "lg", "support.constant.flag.webfluent");
  expectScope("Card.Body.flat { }", "flat", "support.constant.flag.webfluent");
  expectScope("Text(Cart.total)", "total", "variable.other.property.webfluent");
  expectScope("Text(items[0].title)", "title", "variable.other.property.webfluent");
  expectScope("Text(user?.name)", "name", "variable.other.property.webfluent");
  expectScope("Text(user.name.trim())", "trim", "entity.name.function.call.webfluent");
  expectNoScope("on click(e) { console.log(e.key) }", "log", "keyword.other.webfluent");
  expectScope("on click(e) { console.log(e.key) }", "key", "variable.other.property.webfluent");
  expectNoScope("Text(users.state)", "state", "keyword.other.state.webfluent");
  expectScope("Row(gap: .md)", "md", "constant.other.enum-case.webfluent");
});

/** No piece of `source` that holds `text` carries `scope`. */
function expectNoScopeWithin(source, text, scope) {
  const pieces = tokenize(source).filter((p) => p.text.includes(text));
  assert.ok(pieces.length > 0, `no piece holds \`${text}\` in:\n${source}`);
  for (const p of pieces) assert.ok(!p.scopes.includes(scope), `\`${p.text}\` is ${p.scopes}, and should not be ${scope}`);
}

test("an example, a fake, a middleware", () => {
  const src = "example UserCard \"Away\"(fakes: [OneUser]) { UserCard(\"Ada\") }";
  expectScope(src, "example", "keyword.declaration.webfluent");
  expectScope(src, "UserCard", "entity.name.type.webfluent");
  expectScope(src, "fakes", "keyword.other.test.webfluent");
  expectScope("fake OneUser for Backend.users from examples", "fake", "keyword.declaration.webfluent");
  expectScope("fake OneUser for Backend.users from examples", "examples", "keyword.declaration.webfluent");
  expectScope("middleware timed(req, next) {", "middleware", "keyword.declaration.webfluent");
  expectScope("middleware timed(req, next) {", "timed", "entity.name.function.webfluent");
  expectScope("    middleware [requestId, log]", "middleware", "keyword.declaration.webfluent");
});

test("the words of a service", () => {
  const ep = "    get list(t: String in header \"X-T\", q: String? in query \"q\", s: String in cookie) at \"u\" -> [User]! idempotent streamed";
  expectScope(ep, "header", "keyword.other.parameter-location.webfluent");
  expectScope(ep, "query", "keyword.other.parameter-location.webfluent");
  expectScope(ep, "cookie", "keyword.other.parameter-location.webfluent");
  expectScope(ep, "idempotent", "keyword.other.service.webfluent");
  expectScope(ep, "streamed", "keyword.other.service.webfluent");
  expectScope(ep, "->", "keyword.operator.arrow.webfluent");
  expectScope(ep, "!", "keyword.operator.type.result.webfluent");
  expectScope("    invalidates [list, byId(id)]", "invalidates", "keyword.other.service.webfluent");
  expectScope("    invalidations {", "invalidations", "keyword.other.service.webfluent");
  expectScope("    pagination {", "pagination", "keyword.other.service.webfluent");
  expectScope("    users.list pages .cursor(param: after)", "pages", "keyword.other.service.webfluent");
  expectScope("action save() -> ! CreateError {", "!", "keyword.operator.type.result.webfluent");
  expectScope("type R = Settings ! DecodeError", "!", "keyword.operator.type.result.webfluent");
  expectScope("derived off = !open", "!", "keyword.operator.logical.webfluent");
  expectScope("derived same = a != b", "!=", "keyword.operator.comparison.webfluent");
  expectScope("derived f = x => x", "=>", "keyword.operator.arrow.webfluent");
  expectScope("action poll() -> ! concurrent {", "concurrent", "keyword.other.webfluent");
});

test("what a test expects", () => {
  expectScope("expect called Backend.users.create", "called", "keyword.other.test.webfluent");
  expectScope("expect not called Backend.users.create", "expect", "keyword.other.test.webfluent");
  expectScope("expect focus \"Beta\"", "focus", "keyword.other.test.webfluent");
});

test("Json is a type; Map and Any are not", () => {
  expectScope("state raw: Json = Json.null", "Json", "support.type.webfluent");
  expectNoScopeWithin("state m: Map = x", "Map", "support.type.webfluent");
  expectNoScopeWithin("state m: Any = x", "Any", "support.type.webfluent");
});

test("a brace group in prose is text, a splice is not", () => {
  expectNoScopeWithin("Text(\"Use {key: value} in prose\")", "key", "meta.interpolation.webfluent");
  expectNoScopeWithin("Text(\"Pairs {a, b} too\")", "a, b", "meta.interpolation.webfluent");
  expectNoScopeWithin("Text(\"Open { on one line\")", "Open", "meta.interpolation.webfluent");
  expectScope("Text(\"Hi {name}\")", "name", "meta.interpolation.webfluent");
  expectScope("Text(\"{items[0]}\")", "items", "meta.interpolation.webfluent");
  expectScope("Text(\"{when:.date(long)}\")", "date", "support.function.format.webfluent");
});

test("every built-in's part, and a project's", () => {
  expectScope("Tour.Step(target: x) { }", "Step", "support.class.sub-component.webfluent");
  expectScope("DescriptionList.Item(\"Region\")", "Item", "support.class.sub-component.webfluent");
  expectScope("Unsafe.Html(x)", "Html", "support.class.sub-component.webfluent");
  expectScope("PanelGroup.Panel.flat { }", "flat", "support.constant.flag.webfluent");
  expectScope("Panel.Header(\"Keys\")", "Header", "entity.name.type.part.webfluent");
});
