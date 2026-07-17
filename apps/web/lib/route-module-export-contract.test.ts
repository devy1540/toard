import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";

const ALLOWED = new Set([
  "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS",
  "dynamic", "dynamicParams", "revalidate", "fetchCache", "runtime",
  "preferredRegion", "maxDuration", "config", "generateStaticParams",
]);

function routeFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return routeFiles(path);
    return entry.name === "route.ts" ? [path] : [];
  });
}

function runtimeExports(source: ts.SourceFile): string[] {
  const exports: string[] = [];
  for (const statement of source.statements) {
    if (ts.isExportAssignment(statement)) {
      exports.push("default");
      continue;
    }
    if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) continue;
      if (!statement.exportClause) {
        exports.push("*");
      } else if (ts.isNamedExports(statement.exportClause)) {
        for (const specifier of statement.exportClause.elements) {
          if (!specifier.isTypeOnly) exports.push(specifier.name.text);
        }
      } else {
        exports.push(statement.exportClause.name.text);
      }
      continue;
    }
    if (!ts.canHaveModifiers(statement) || !ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) continue;
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) exports.push(declaration.name.text);
      }
    } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) && statement.name) {
      exports.push(statement.name.text);
    }
  }
  return exports;
}

test("Next route modules export only the supported runtime contract", () => {
  const appDirectory = new URL("../app/", import.meta.url);
  const invalid = routeFiles(appDirectory.pathname)
    .map((file) => {
      const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
      const names = runtimeExports(source).filter((name) => !ALLOWED.has(name));
      return names.length > 0 ? `${file.replace(`${appDirectory.pathname}/`, "")}: ${names.join(", ")}` : null;
    })
    .filter((value): value is string => value !== null);

  assert.deepEqual(invalid, [], `Invalid route runtime exports:\n${invalid.join("\n")}`);
});
