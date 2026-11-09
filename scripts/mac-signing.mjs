#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const APP_IDENTIFIER = 'com.ganbo-gab.open-storyboard-canvas';

/** Development opt-in cannot weaken release policy; only a deliberate manual release can. */
export function signingPolicy(env = process.env) {
  const release = env.MACOS_SIGNING_RELEASE === '1'
    || (env.GITHUB_REF ?? '').startsWith('refs/tags/')
    || Boolean(env.RELEASE_TAG_INPUT?.trim());
  const identity = env.APPLE_SIGNING_IDENTITY?.trim() ?? '';
  if (/[\r\n\0]/.test(identity)) throw new Error('APPLE_SIGNING_IDENTITY must be a single signing identity.');
  const certificate = Boolean(env.APPLE_CERTIFICATE?.trim());
  const password = Boolean(env.APPLE_CERTIFICATE_PASSWORD);
  if (certificate !== password) {
    throw new Error('Provide APPLE_CERTIFICATE and APPLE_CERTIFICATE_PASSWORD together, or omit both when the signing identity is already installed.');
  }
  if (identity && identity !== '-') return { release, identity, kind: 'stable' };
  if (certificate) throw new Error('APPLE_CERTIFICATE requires a non-ad-hoc APPLE_SIGNING_IDENTITY.');
  if (release) {
    if (env.GITHUB_EVENT_NAME === 'workflow_dispatch' && env.MACOS_ALLOW_ADHOC_RELEASE === '1') {
      return { release, identity: '-', kind: 'adhoc' };
    }
    throw new Error('macOS release blocked: configure a persistent APPLE_SIGNING_IDENTITY (and APPLE_CERTIFICATE / APPLE_CERTIFICATE_PASSWORD on CI), or explicitly select ad-hoc signing for a manual workflow release. Development opt-in does not authorize a release. See docs/release/macos-signing.md.');
  }
  if (identity === '-' || env.MACOS_ALLOW_ADHOC === '1') {
    return { release, identity: '-', kind: 'adhoc' };
  }
  throw new Error('No macOS signing identity configured. For a development-only package, explicitly set MACOS_ALLOW_ADHOC=1; releases require stable signing. See docs/release/macos-signing.md.');
}

export function buildEnvironment(env = process.env) {
  const policy = signingPolicy(env);
  const next = { ...env, APPLE_SIGNING_IDENTITY: policy.identity };
  // Actions expands missing secrets to empty strings. Tauri treats even empty
  // certificate variables as an import request, so omit an absent pair entirely.
  if (!env.APPLE_CERTIFICATE?.trim()) {
    delete next.APPLE_CERTIFICATE;
    delete next.APPLE_CERTIFICATE_PASSWORD;
  }
  return next;
}

/** Do not log command environments or tool output: signing inputs may contain secrets. */
function runCommand(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${path.basename(command)} failed during macOS signature verification.`);
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
}

export function validateSignature(output, policy) {
  const identifier = /^Identifier=(.+)$/m.exec(output)?.[1]?.trim();
  if (identifier !== APP_IDENTIFIER) throw new Error('Signed application identifier does not match the existing application.');
  // codesign prefixes its synthesized default requirement with "# ".
  const requirement = /^(?:#\s*)?designated\s*=>\s*(.+)$/m.exec(output)?.[1]?.trim();
  if (!requirement) throw new Error('Signed application has no designated requirement.');
  const adhoc = /^Signature=adhoc\s*$/m.test(output);
  if (policy.kind === 'adhoc') {
    if (!adhoc) throw new Error('Ad-hoc signing policy does not match the resulting signature.');
    return { requirement };
  }
  if (adhoc || !/^Authority=.+$/m.test(output)) throw new Error('Release requires a certificate-backed signature, not ad-hoc signing.');
  if (/\bcdhash\b/.test(requirement)) throw new Error('Designated requirement is tied to a build hash; updates cannot retain Keychain identity.');
  // Accept the normal Developer ID and fixed self-signed certificate requirements.
  // Unknown/custom Boolean policies need a separate review, not a permissive fallback.
  const escapedIdentifier = APP_IDENTIFIER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!new RegExp(`\\bidentifier\\s+(?:"${escapedIdentifier}"|${escapedIdentifier})(?=\\s|\\)|$)`).test(requirement)) {
    throw new Error('Designated requirement must bind the existing application identifier.');
  }
  const fixedAnchor = /\banchor\s+H"[0-9a-fA-F]{40}"(?=\s|\)|$)/.test(requirement);
  const appleTeam = /\banchor\s+apple\s+generic(?=\s|\)|$)/.test(requirement)
    && /\bcertificate\s+leaf\[subject\.OU\]\s*=\s*(?:"[A-Z0-9]+"|[A-Z0-9]+)(?=\s|\)|$)/.test(requirement);
  if (/\b(?:or|not)\b/.test(requirement) || (!fixedAnchor && !appleTeam)) {
    throw new Error('Designated requirement must bind an Apple or fixed certificate anchor; custom requirements need review.');
  }
  return { requirement };
}

/** Inspect every Mach-O architecture; a universal bundle must share one stable identity. */
export function verifyApplication(appPath, policy, run = runCommand) {
  const absolutePath = path.resolve(appPath);
  const plist = path.join(absolutePath, 'Contents', 'Info.plist');
  const plistValue = (key) => run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist]).trim();
  if (plistValue('CFBundleIdentifier') !== APP_IDENTIFIER) throw new Error('Bundle identifier does not match the existing application.');
  const executable = plistValue('CFBundleExecutable');
  if (!executable || executable === '.' || executable === '..' || /[/\\\0\r\n]/.test(executable)) throw new Error('Invalid bundle executable name.');
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--all-architectures', absolutePath]);
  const architectures = run('/usr/bin/lipo', ['-archs', path.join(absolutePath, 'Contents', 'MacOS', executable)]).trim().split(/\s+/);
  if (!architectures.length || architectures.some((arch) => !['arm64', 'x86_64'].includes(arch))) throw new Error('Expected an Apple Silicon, Intel, or universal macOS application.');
  let previousRequirement;
  for (const arch of architectures) {
    const output = run('/usr/bin/codesign', ['--display', '--verbose=4', '--requirements', '-', '--arch', arch, absolutePath]);
    const { requirement } = validateSignature(output, policy);
    if (policy.kind === 'stable' && previousRequirement && requirement !== previousRequirement) {
      throw new Error('Universal application architectures have different designated requirements.');
    }
    previousRequirement = requirement;
  }
  return { architectures, kind: policy.kind };
}

function main(args) {
  const [command, ...rest] = args;
  if (!['check', 'build', 'verify'].includes(command)
    || (command === 'check' && rest.length)
    || (command === 'verify' && rest.length !== 1)) {
    throw new Error('Usage: node scripts/mac-signing.mjs check | build [tauri build arguments] | verify <app-path>');
  }
  const policy = signingPolicy();
  if (policy.kind === 'adhoc') console.warn(policy.release
    ? 'Maintainer explicitly selected an ad-hoc release: this package is not notarized; each saved credential can require Keychain access again after an update.'
    : 'Development ad-hoc package: updates can require Keychain access again; release requires a separate explicit manual selection.');
  if (command === 'check') {
    console.log(`macOS signing policy: ${policy.kind}${policy.release ? ' (release)' : ' (development)'}.`);
  } else if (command === 'build') {
    // Tauri owns certificate import/signing. This wrapper never creates identities or changes ACLs.
    const result = spawnSync('npx', ['tauri', 'build', ...rest], {
      stdio: 'inherit', env: buildEnvironment(),
    });
    if (result.error || result.status !== 0) throw new Error('Tauri macOS build failed.');
  } else {
    const result = verifyApplication(rest[0], policy);
    console.log(`Verified macOS ${result.kind} signature and application identifier for ${result.architectures.join(', ')}. Notarization and existing Keychain access are separate checks.`);
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(error instanceof Error ? error.message : 'macOS signing check failed.'); process.exitCode = 1; }
}
