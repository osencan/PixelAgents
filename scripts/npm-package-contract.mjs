import { createHash } from 'node:crypto';
import fs from 'node:fs';

import semver from 'semver';

// 2.x publishes under its own scope: the unscoped `pixel-agents` belongs to the
// original 1.x project. The root package.json keeps the plain name because it is
// also the VS Code extension manifest, and vsce rejects scoped names, so the npm
// package is packed from a staged folder whose manifest `npmManifest` writes.
export const EXPECTED_PACKAGE_NAME = '@osencan/pixel-agents';
export const EXPECTED_REPOSITORY_URL = 'https://github.com/osencan/PixelAgents';
export const PACKAGE_BIN = 'pixel-agents';

// fastify + @fastify/{cors,static,websocket} are root runtime `dependencies` even though
// no root source file imports them: esbuild marks them `external` when bundling
// dist/cli.js (see esbuild.js), so the published `pixel-agents` bin resolves them from
// node_modules at runtime. server/ ships its own copy for local dev but is excluded from
// the tarball (FORBIDDEN_PACKAGE_PREFIXES below), so dropping the root declarations would
// publish a CLI that crashes on require(). knip.json ignores them for this reason.

export const REQUIRED_PACKAGE_FILES = [
  'CHANGELOG.md',
  'LICENSE',
  'README.md',
  'dist/cli.js',
  'dist/hooks/claude-hook.js',
  'dist/hooks/claude-statusline.js',
  'dist/webview/index.html',
  'icon.png',
  'package.json',
];

export const REQUIRED_PACKAGE_PREFIXES = ['dist/assets/furniture/', 'dist/webview/assets/'];

export const FORBIDDEN_PACKAGE_PREFIXES = [
  '.github/',
  '.husky/',
  'adapters/',
  'core/',
  'dist/browser/',
  'dist/extension.js',
  'dist/pty-host.js',
  'dist/uninstall.js',
  'dist/webview-preview/',
  'docs/',
  'e2e/',
  'reports/',
  'scripts/',
  'server/',
  'test-results/',
  'webview-ui/',
];

// What the staged package holds besides its generated package.json: the CLI and
// what it loads at runtime, never the VS Code entry points or dev-only bundles.
export const STAGED_PACKAGE_PATHS = [
  'CHANGELOG.md',
  'LICENSE',
  'README.md',
  'icon.png',
  'dist/cli.js',
  'dist/hooks/claude-hook.js',
  'dist/hooks/claude-statusline.js',
  'dist/assets',
  'dist/webview',
];

/** The npm manifest, derived from the root (VS Code) manifest: CLI fields only. */
export function npmManifest(root) {
  return {
    name: EXPECTED_PACKAGE_NAME,
    version: root.version,
    // The root description is the VS Code extension's; this one names both CLIs.
    description:
      'Watch and steer your Claude Code and Codex agents as pixel-art characters in a tiny office, from any browser or your phone.',
    keywords: ['claude-code', 'codex', 'ai-agents', 'pixel-art', 'agent-monitoring', 'cli'],
    homepage: root.homepage,
    bugs: { url: `${EXPECTED_REPOSITORY_URL}/issues` },
    repository: { type: 'git', url: EXPECTED_REPOSITORY_URL },
    license: root.license,
    engines: { node: root.engines.node },
    bin: { [PACKAGE_BIN]: './dist/cli.js' },
    files: STAGED_PACKAGE_PATHS,
    dependencies: root.dependencies,
    optionalDependencies: root.optionalDependencies,
    publishConfig: { access: 'public' },
  };
}

export function parsePackJsonOutput(output) {
  const trimmed = output.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const candidates = [];
    for (let index = 0; index < trimmed.length; index++) {
      if (trimmed[index] === '[' || trimmed[index] === '{') candidates.push(index);
    }
    for (let index = candidates.length - 1; index >= 0; index--) {
      try {
        return JSON.parse(trimmed.slice(candidates[index]));
      } catch {
        // Build/lifecycle output can contain JSON-looking fragments; keep scanning.
      }
    }
  }
  throw new Error(`Unable to locate npm pack JSON metadata in output:\n${output}`);
}

export function normalizePackMetadata(value) {
  if (Array.isArray(value)) {
    if (value.length !== 1) {
      throw new Error(`Expected one packed package, received ${value.length.toString()}`);
    }
    return value[0];
  }
  if (value && typeof value === 'object') {
    if (typeof value.filename === 'string') return value;
    const entries = Object.values(value);
    if (entries.length === 1 && entries[0] && typeof entries[0] === 'object') {
      return entries[0];
    }
  }
  throw new Error('npm pack did not return one package metadata object');
}

export function validatePackageFiles(files) {
  if (!Array.isArray(files)) throw new Error('npm pack metadata is missing its files array');
  const paths = files.map((file) => file?.path).filter((file) => typeof file === 'string');
  const pathSet = new Set(paths);
  const problems = [];

  for (const required of REQUIRED_PACKAGE_FILES) {
    if (!pathSet.has(required)) problems.push(`missing required file: ${required}`);
  }
  for (const prefix of REQUIRED_PACKAGE_PREFIXES) {
    if (!paths.some((file) => file.startsWith(prefix))) {
      problems.push(`missing required file prefix: ${prefix}`);
    }
  }
  for (const file of paths) {
    const forbiddenPrefix = FORBIDDEN_PACKAGE_PREFIXES.find((prefix) => file.startsWith(prefix));
    if (forbiddenPrefix) problems.push(`forbidden package path: ${file}`);
    if (file.endsWith('.map')) problems.push(`source map must not ship: ${file}`);
    if (file.endsWith('.tgz')) problems.push(`nested tarball must not ship: ${file}`);
  }

  if (problems.length > 0) {
    throw new Error(`Invalid npm package contents:\n- ${problems.join('\n- ')}`);
  }
  return paths;
}

export function validateReleaseIdentity({
  manifest,
  releaseTag,
  ref,
  latestVersion,
  exactVersionExists = false,
}) {
  if (manifest.name !== EXPECTED_PACKAGE_NAME) {
    throw new Error(
      `Expected package name ${EXPECTED_PACKAGE_NAME}, received ${String(manifest.name)}`,
    );
  }
  if (manifest.repository?.url !== EXPECTED_REPOSITORY_URL) {
    throw new Error(
      `Expected repository ${EXPECTED_REPOSITORY_URL}, received ${String(manifest.repository?.url)}`,
    );
  }
  if (!semver.valid(manifest.version)) {
    throw new Error(`Invalid package version: ${String(manifest.version)}`);
  }
  const expectedTag = `v${manifest.version}`;
  if (releaseTag !== expectedTag) {
    throw new Error(`Release tag ${releaseTag} does not match package version ${expectedTag}`);
  }
  const expectedRef = `refs/tags/${releaseTag}`;
  if (ref !== expectedRef) {
    throw new Error(`Release ref ${ref} does not match ${expectedRef}`);
  }
  // null = nothing published under this name yet (the first release).
  if (latestVersion === null) return;
  if (!semver.valid(latestVersion)) {
    throw new Error(`Invalid npm latest version: ${String(latestVersion)}`);
  }
  if (!exactVersionExists && !semver.gt(manifest.version, latestVersion)) {
    throw new Error(
      `Package version ${manifest.version} must be greater than npm latest ${latestVersion}`,
    );
  }
}

export function getPublicationDecision(localIntegrity, publishedIntegrity) {
  if (!publishedIntegrity) return 'publish';
  if (publishedIntegrity === localIntegrity) return 'skip';
  return 'conflict';
}

export function validateTarballIntegrity(tarballPath, expectedIntegrity) {
  const actualIntegrity = `sha512-${createHash('sha512')
    .update(fs.readFileSync(tarballPath))
    .digest('base64')}`;
  if (actualIntegrity !== expectedIntegrity) {
    throw new Error(
      `Packed artifact integrity changed after verification: expected ${expectedIntegrity}, received ${actualIntegrity}`,
    );
  }
  return actualIntegrity;
}
