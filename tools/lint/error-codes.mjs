#!/usr/bin/env node
// Checks how errors are built in the files that tools/lint/error-codes.json lists as migrated to error codes.
// The catalog is the `codeCategory` table in src/errors.ts. See tools/lint/README.md.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { listSourceFiles, unwrap } from "./shared-helpers.mjs";

const ERRORS_FILE = "src/errors.ts";
const CONFIG_FILE = "tools/lint/error-codes.json";
const CATEGORIES = ["transient", "permanent", "counterparty", "substrate"];
const CODE_SHAPE = /^[a-z][a-z0-9]*\.[a-z][a-z0-9_]*$/;
/** Reserved for this check: code that is not classified yet. It is never in the catalog. */
const UNCLASSIFIED = "sdk.unclassified";
const BASE_CLASS = "DacsError";
/** Classes whose constructor takes a catalog `code`, with the category each one fixes (the base fixes none). */
const CATALOG_CLASSES = { DacsError: null, TransientError: "transient", CounterpartyError: "counterparty", SubstrateError: "substrate" };
/** Where the code sits among the arguments where a subclass that owns its `code` is built; other owned classes take it first. */
const OWNED_CONSTRUCTORS = { WireError: 0, RawJsonAdmissionError: 1, AnchorWaitError: 0 };
/** The helpers that build those errors, each with the file that declares it and the position of its code. A call is checked only where the name is that helper. */
const OWNED_HELPERS = {
  fail: { file: "src/wire/validate.ts", position: 0 },
  reject: { file: "src/canonical/rawJson.ts", position: 1 },
};
const PLAIN_ERRORS = ["Error", "TypeError", "RangeError", "SyntaxError"];

const parse = (path, text) => ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false);
const memberName = (node) => (ts.isIdentifier(node) || ts.isStringLiteralLike(node) ? node.text : undefined);

/** Reads the `codeCategory` table in src/errors.ts. Returns the codes with their categories and the problems with the table. */
export function readCatalog(repoRoot) {
  const codes = new Map();
  const source = parse(ERRORS_FILE, readFileSync(join(repoRoot, ERRORS_FILE), "utf8"));
  const declaration = source.statements
    .flatMap((statement) => (ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : []))
    .find((candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === "codeCategory");
  const table = declaration?.initializer && unwrap(declaration.initializer);
  if (!table || !ts.isObjectLiteralExpression(table)) return { codes, problems: [`${ERRORS_FILE}: no codeCategory table found`] };
  const problems = [];
  for (const entry of table.properties) {
    if (!ts.isPropertyAssignment(entry) || memberName(entry.name) === undefined || !ts.isStringLiteralLike(entry.initializer)) {
      problems.push(`${ERRORS_FILE}: the codeCategory table holds only "code": "category" entries`);
      continue;
    }
    const code = memberName(entry.name);
    const category = entry.initializer.text;
    if (code === UNCLASSIFIED) {
      problems.push(`${ERRORS_FILE}: catalog code "${code}" is reserved for lint and cannot be in the catalog`);
      continue;
    }
    if (!CODE_SHAPE.test(code)) problems.push(`${ERRORS_FILE}: catalog code "${code}" is not shaped like domain.reason in lower case`);
    if (!CATEGORIES.includes(category)) problems.push(`${ERRORS_FILE}: catalog code "${code}" has unknown category "${category}"`);
    codes.set(code, category);
  }
  return { codes, problems };
}

function declaresCode(declaration) {
  return declaration.members.some((member) =>
    (ts.isPropertyDeclaration(member) && memberName(member.name) === "code")
    || (ts.isConstructorDeclaration(member) && member.parameters.some((parameter) =>
      parameter.modifiers?.length > 0 && ts.isIdentifier(parameter.name) && parameter.name.text === "code")));
}

/**
 * Finds every class under src/ that extends DacsError, directly or through other classes, by name.
 * The value says how a code reaches it: "catalog" (the constructor takes a catalog `code`), "owned"
 * (the class declares its own `code`) or "closed" (neither, so no catalog code can be given).
 */
export function findErrorClasses(repoRoot) {
  const parents = new Map();
  const owners = new Set();
  for (const path of listSourceFiles(repoRoot)) {
    for (const statement of parse(path, readFileSync(join(repoRoot, path), "utf8")).statements) {
      if (!ts.isClassDeclaration(statement) || !statement.name) continue;
      const base = statement.heritageClauses?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]?.expression;
      parents.set(statement.name.text, base && ts.isIdentifier(base) ? base.text : undefined);
      if (declaresCode(statement)) owners.add(statement.name.text);
    }
  }
  const extendsBase = (name) => {
    for (const seen = new Set(); name !== undefined && !seen.has(name); name = parents.get(name)) {
      if (name === BASE_CLASS) return true;
      seen.add(name);
    }
    return false;
  };
  const kinds = new Map();
  for (const name of parents.keys()) {
    if (!extendsBase(name)) continue;
    kinds.set(name, Object.hasOwn(CATALOG_CLASSES, name) ? "catalog" : owners.has(name) ? "owned" : "closed");
  }
  return kinds;
}

const collapseSpace = (text) => text.replace(/\s+/g, " ");

/** The names that stand for an owned-code helper in a file: its top-level declaration, or an import of it from the declaring file. */
function helperNames(path, source) {
  const names = new Map();
  const helperNamed = (name) => (Object.hasOwn(OWNED_HELPERS, name) ? OWNED_HELPERS[name] : undefined);
  for (const statement of source.statements) {
    const declared = ts.isFunctionDeclaration(statement) && statement.name ? helperNamed(statement.name.text) : undefined;
    if (declared?.file === path) names.set(statement.name.text, declared);
    const bindings = ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) ? statement.importClause?.namedBindings : undefined;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    const from = posix.join(posix.dirname(path), statement.moduleSpecifier.text).replace(/\.js$/, ".ts");
    for (const { name, propertyName } of bindings.elements) {
      const helper = helperNamed((propertyName ?? name).text);
      if (helper?.file === from) names.set(name.text, helper);
    }
  }
  return names;
}

function ownedCodeProblem(args, position) {
  const code = args?.[position];
  return code === undefined || (ts.isStringLiteralLike(code) && (code.text === "" || code.text === UNCLASSIFIED));
}

function checkFile(path, text, { codes, classes, retained, matched }) {
  const source = parse(path, text);
  const problems = [];
  const report = (node, message) => problems.push(`${path}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: ${message}`);

  const checkCatalogCode = (node, name) => {
    const options = node.arguments?.[1] && unwrap(node.arguments[1]);
    const property = (key) => options && ts.isObjectLiteralExpression(options)
      ? options.properties.find((entry) => (ts.isPropertyAssignment(entry) || ts.isShorthandPropertyAssignment(entry)) && memberName(entry.name) === key)
      : undefined;
    const given = property("code");
    if (!given || !ts.isPropertyAssignment(given) || !ts.isStringLiteralLike(given.initializer)) {
      return report(node, `${name} must be given a catalog code written as a string literal`);
    }
    const code = given.initializer.text;
    const fixed = CATALOG_CLASSES[name];
    if (code === UNCLASSIFIED) return report(node, `"${code}" marks code that is not classified yet; it is not a catalog code`);
    if (!codes.has(code)) return report(node, `"${code}" is not in the catalog in ${ERRORS_FILE}`);
    if (fixed && codes.get(code) !== fixed) return report(node, `${name} is ${fixed} but "${code}" is ${codes.get(code)} in the catalog`);
    if (name === BASE_CLASS && property("category")) report(node, `${name} takes its category from the catalog; remove \`category\` beside \`code\``);
  };

  const checkConstruction = (node, name) => {
    const kind = classes.get(name);
    if (kind === "closed") report(node, `${name} cannot carry a catalog code; throw a coded ${BASE_CLASS} instead`);
    else if (kind === "owned" && ownedCodeProblem(node.arguments, OWNED_CONSTRUCTORS[name] ?? 0)) report(node, `${name} needs a code argument`);
    else if (kind === "catalog") checkCatalogCode(node, name);
  };

  const checkThrow = (node) => {
    const thrown = unwrap(node.expression);
    if (!ts.isNewExpression(thrown) || !ts.isIdentifier(thrown.expression) || !PLAIN_ERRORS.includes(thrown.expression.text)) return;
    const key = `${path}\n${collapseSpace(thrown.getText(source))}`;
    if (retained.has(key)) matched.add(key);
    else report(node, `plain ${thrown.expression.text} throw; throw a coded ${BASE_CLASS}, or list it in retainedPlainThrows with a reason`);
  };

  const helpers = helperNames(path, source);
  /** `shadowed` holds the parameter names of the functions around the node; a parameter named like a helper is not the helper. */
  const visit = (node, shadowed) => {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) checkConstruction(node, node.expression.text);
    else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && helpers.has(node.expression.text) && !shadowed.has(node.expression.text)) {
      const name = node.expression.text;
      if (ownedCodeProblem(node.arguments, helpers.get(name).position)) report(node, `${name} needs a code argument`);
    } else if (ts.isThrowStatement(node)) checkThrow(node);
    const inner = ts.isFunctionLike(node) ? new Set([...shadowed, ...node.parameters.flatMap((parameter) => (ts.isIdentifier(parameter.name) ? [parameter.name.text] : []))]) : shadowed;
    ts.forEachChild(node, (child) => visit(child, inner));
  };
  visit(source, new Set());
  return problems;
}

/** Lists what is wrong with the catalog, the config and every migrated file, as `path:line: message` lines. */
export function findProblems(repoRoot) {
  const { codes, problems } = readCatalog(repoRoot);
  const config = JSON.parse(readFileSync(join(repoRoot, CONFIG_FILE), "utf8"));
  const sourceFiles = listSourceFiles(repoRoot);
  const migrated = new Set();
  for (const entry of config.migrated) {
    const found = sourceFiles.filter((path) => (entry.endsWith("/") ? path.startsWith(entry) : path === entry));
    if (found.length === 0) problems.push(`${CONFIG_FILE}: migrated path "${entry}" does not exist`);
    for (const path of found) migrated.add(path);
  }
  const retained = new Set(config.retainedPlainThrows.map((entry) => `${entry.path}\n${collapseSpace(entry.throw)}`));
  const matched = new Set();
  const classes = findErrorClasses(repoRoot);
  for (const path of migrated) problems.push(...checkFile(path, readFileSync(join(repoRoot, path), "utf8"), { codes, classes, retained, matched }));
  for (const entry of config.retainedPlainThrows) {
    const where = `retained throw \`${entry.throw}\` in ${entry.path}`;
    if (!entry.reason) problems.push(`${CONFIG_FILE}: ${where} has no reason`);
    if (!matched.has(`${entry.path}\n${collapseSpace(entry.throw)}`)) problems.push(`${CONFIG_FILE}: ${where} matches no plain throw`);
  }
  return problems;
}

function main() {
  const problems = findProblems(resolve(fileURLToPath(new URL("../..", import.meta.url))));
  for (const problem of problems) console.error(problem);
  if (problems.length === 0) console.log("error-codes: ok");
  return problems.length === 0 ? 0 : 1;
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
