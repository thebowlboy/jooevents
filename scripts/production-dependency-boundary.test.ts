import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';

const root = resolve(import.meta.dir, '..');

function sourceFiles(directory: string): readonly string[] {
  if (!existsSync(directory)) return [];
  const files: string[] = [];
  const visit = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (/\.ts$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)
          && !/\.(?:test|spec)\./.test(entry.name)) files.push(child);
    }
  };
  visit(directory);
  return files;
}

function packageDirectories(): readonly string[] {
  return ['apps/server', ...readdirSync(join(root, 'packages'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `packages/${entry.name}`)]
    .map((path) => join(root, path))
    .filter((path) => existsSync(join(path, 'package.json')));
}

function bareImports(path: string): readonly string[] {
  const source = readFileSync(path, 'utf8');
  const imports = new Set<string>();
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const add = (value: string) => {
    if (value.startsWith('.') || value.startsWith('/') || value.startsWith('node:')
        || value.startsWith('bun:') || value.startsWith('$')) return;
    imports.add(value.startsWith('@') ? value.split('/').slice(0, 2).join('/') : value.split('/')[0]!);
  };
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const clause = statement.importClause;
      const named = clause?.namedBindings;
      const typeOnly = clause?.isTypeOnly === true || (
        clause?.name === undefined && named !== undefined && ts.isNamedImports(named)
        && named.elements.every((element) => element.isTypeOnly)
      );
      if (!typeOnly) add(statement.moduleSpecifier.text);
    }
    if (ts.isExportDeclaration(statement) && statement.isTypeOnly !== true
        && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
      add(statement.moduleSpecifier.text);
    }
  }
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
        && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]!)) {
      add(node.arguments[0]!.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...imports];
}

test('every runtime source import is a production dependency of its package', () => {
  const failures: string[] = [];
  for (const directory of packageDirectories()) {
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as {
      readonly dependencies?: Readonly<Record<string, string>>;
      readonly devDependencies?: Readonly<Record<string, string>>;
    };
    for (const file of sourceFiles(join(directory, 'src'))) {
      for (const dependency of bareImports(file)) {
        if (manifest.dependencies?.[dependency] !== undefined) continue;
        failures.push(`${relative(root, file)} imports ${dependency} (${manifest.devDependencies?.[dependency] ? 'dev-only' : 'undeclared'})`);
      }
    }
  }
  expect(failures).toEqual([]);
});
