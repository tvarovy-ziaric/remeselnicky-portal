#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

const SOURCE_EXTENSIONS = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);

const IGNORED_DIRECTORIES = new Set([
  ".next",
  "coverage",
  "dist",
  "node_modules",
]);

// Domain is intentionally framework-free. Keep this list limited to runtime
// frameworks; test, compiler and lint tooling are valid development dependencies.
const FRAMEWORK_PACKAGES = new Set([
  "@nestjs/common",
  "@nestjs/core",
  "@nestjs/microservices",
  "@nestjs/platform-express",
  "@nestjs/platform-fastify",
  "express",
  "fastify",
  "h3",
  "hono",
  "koa",
  "next",
  "react",
  "react-dom",
]);

const IMPORT_PATTERNS = [
  /\b(?:import|export)\s+(?:type\s+)?(?:[^;"']*?\s+from\s*)?["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
];

function normalizePath(filePath) {
  return filePath.split(path.sep).join("/");
}

function isInside(candidate, directory) {
  const relative = path.relative(directory, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function matchesPackage(specifier, packageName) {
  return specifier === packageName || specifier.startsWith(`${packageName}/`);
}

function isFrameworkPackage(specifier) {
  for (const packageName of FRAMEWORK_PACKAGES) {
    if (matchesPackage(specifier, packageName)) return true;
  }
  return false;
}

function lineNumberAt(source, index) {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (source.charCodeAt(cursor) === 10) line += 1;
  }
  return line;
}

function findImports(source) {
  const imports = [];
  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      imports.push({
        specifier: match[1],
        line: lineNumberAt(source, match.index),
      });
    }
  }
  return imports;
}

async function directoryEntries(directory) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function discoverWorkspaces(rootDirectory, kind) {
  const parentDirectory = path.join(rootDirectory, kind);
  const entries = await directoryEntries(parentDirectory);
  const workspaces = [];

  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(parentDirectory, entry.name);
    const manifestPath = path.join(directory, "package.json");
    try {
      const source = await readFile(manifestPath, "utf8");
      const manifest = JSON.parse(source);
      workspaces.push({
        kind,
        directory,
        manifest,
        manifestPath,
        name: manifest.name ?? entry.name,
      });
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      error.message = `${normalizePath(path.relative(rootDirectory, manifestPath))}: ${error.message}`;
      throw error;
    }
  }

  return workspaces;
}

async function sourceFiles(directory) {
  const files = [];

  async function walk(currentDirectory) {
    const entries = await directoryEntries(currentDirectory);
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) {
          await walk(path.join(currentDirectory, entry.name));
        }
      } else if (
        entry.isFile() &&
        SOURCE_EXTENSIONS.has(path.extname(entry.name))
      ) {
        files.push(path.join(currentDirectory, entry.name));
      }
    }
  }

  await walk(directory);
  return files;
}

function allDependencies(manifest) {
  const dependencies = [];
  for (const field of DEPENDENCY_FIELDS) {
    for (const name of Object.keys(manifest[field] ?? {}).sort()) {
      dependencies.push({ field, name });
    }
  }
  return dependencies;
}

function resolveRelativeImport(importingFile, specifier) {
  if (!specifier.startsWith(".")) return undefined;
  return path.resolve(path.dirname(importingFile), specifier);
}

function diagnostic(rootDirectory, file, line, rule, message) {
  return {
    file: normalizePath(path.relative(rootDirectory, file)),
    line,
    message,
    rule,
  };
}

function referencesWorkspace(specifier, workspace) {
  return matchesPackage(specifier, workspace.name);
}

export async function verifyWorkspace(rootDirectory) {
  const root = path.resolve(rootDirectory);
  const [apps, packages] = await Promise.all([
    discoverWorkspaces(root, "apps"),
    discoverWorkspaces(root, "packages"),
  ]);
  const diagnostics = [];
  const web =
    apps.find((workspace) => workspace.name === "@portal/web") ??
    apps.find((workspace) => path.basename(workspace.directory) === "web");
  const domain =
    packages.find((workspace) => workspace.name === "@portal/domain") ??
    packages.find(
      (workspace) => path.basename(workspace.directory) === "domain",
    );

  for (const workspace of packages) {
    for (const dependency of allDependencies(workspace.manifest)) {
      const app = apps.find((candidate) =>
        referencesWorkspace(dependency.name, candidate),
      );
      if (app) {
        diagnostics.push(
          diagnostic(
            root,
            workspace.manifestPath,
            1,
            "shared-no-app",
            `${workspace.name} ${dependency.field} must not reference app package ${app.name}`,
          ),
        );
      }
    }
  }

  if (web) {
    for (const dependency of allDependencies(web.manifest)) {
      if (matchesPackage(dependency.name, "@portal/db")) {
        diagnostics.push(
          diagnostic(
            root,
            web.manifestPath,
            1,
            "web-server-boundary",
            `${web.name} ${dependency.field} must not reference @portal/db`,
          ),
        );
      }
    }
  }

  if (domain) {
    for (const dependency of allDependencies(domain.manifest)) {
      const app = apps.find((candidate) =>
        referencesWorkspace(dependency.name, candidate),
      );
      if (app || isFrameworkPackage(dependency.name)) {
        diagnostics.push(
          diagnostic(
            root,
            domain.manifestPath,
            1,
            "domain-framework-free",
            `${domain.name} ${dependency.field} must not reference ${dependency.name}`,
          ),
        );
      }
    }
  }

  for (const workspace of [...apps, ...packages]) {
    const files = await sourceFiles(workspace.directory);
    for (const file of files) {
      const source = await readFile(file, "utf8");
      for (const imported of findImports(source)) {
        const relativeTarget = resolveRelativeImport(file, imported.specifier);
        const referencedApp = apps.find(
          (candidate) =>
            referencesWorkspace(imported.specifier, candidate) ||
            (relativeTarget && isInside(relativeTarget, candidate.directory)),
        );

        if (workspace.kind === "packages" && referencedApp) {
          diagnostics.push(
            diagnostic(
              root,
              file,
              imported.line,
              "shared-no-app",
              `${workspace.name} must not import app package ${referencedApp.name}`,
            ),
          );
        }

        if (
          workspace === web &&
          (matchesPackage(imported.specifier, "@portal/db") ||
            matchesPackage(imported.specifier, "@portal/config/server"))
        ) {
          diagnostics.push(
            diagnostic(
              root,
              file,
              imported.line,
              "web-server-boundary",
              `${web.name} must not import ${imported.specifier}`,
            ),
          );
        }

        if (
          workspace === domain &&
          (referencedApp || isFrameworkPackage(imported.specifier))
        ) {
          diagnostics.push(
            diagnostic(
              root,
              file,
              imported.line,
              "domain-framework-free",
              `${domain.name} must not import ${imported.specifier}`,
            ),
          );
        }
      }
    }
  }

  return diagnostics.sort((left, right) =>
    [left.file, left.line, left.rule, left.message]
      .join(":")
      .localeCompare(
        [right.file, right.line, right.rule, right.message].join(":"),
      ),
  );
}

export function formatDiagnostic(item) {
  return `${item.file}:${item.line} [${item.rule}] ${item.message}`;
}

async function main() {
  const rootDirectory = process.argv[2]
    ? path.resolve(process.argv[2])
    : process.cwd();
  const diagnostics = await verifyWorkspace(rootDirectory);
  if (diagnostics.length === 0) {
    console.log("Import boundaries verified.");
    return;
  }

  console.error(
    `Import boundary verification failed (${diagnostics.length} violation(s)):`,
  );
  for (const item of diagnostics) console.error(formatDiagnostic(item));
  process.exitCode = 1;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
