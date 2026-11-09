import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { APP_IDENTIFIER, buildEnvironment, signingPolicy, validateSignature, verifyApplication } from './mac-signing.mjs';

const stable = signingPolicy({ APPLE_SIGNING_IDENTITY: 'Developer ID Application: Fixture (TEAM)' });
const adhoc = signingPolicy({ MACOS_ALLOW_ADHOC: '1' });
const appleRequirement = `identifier "${APP_IDENTIFIER}" and anchor apple generic and certificate leaf[subject.OU] = "TEAM"`;
const selfSignedRequirement = `identifier "${APP_IDENTIFIER}" and anchor H"${'a'.repeat(40)}"`;
const hashRequirement = `cdhash H"${'b'.repeat(40)}"`;
const signature = (requirement = appleRequirement, identity = APP_IDENTIFIER, isAdhoc = false) =>
  `Identifier=${identity}\n${isAdhoc ? 'Signature=adhoc' : 'Authority=Fixture signing certificate'}\n# designated => ${requirement}\n`;

test('tag, manual release and local release refuse ad-hoc even with development opt-in', () => {
  for (const release of [{ GITHUB_REF: 'refs/tags/v0.2.2' }, { RELEASE_TAG_INPUT: 'v0.2.2' }, { MACOS_SIGNING_RELEASE: '1' }]) {
    for (const identity of ['', '-']) {
      assert.throws(() => signingPolicy({ ...release, APPLE_SIGNING_IDENTITY: identity, MACOS_ALLOW_ADHOC: '1' }), /release blocked/);
    }
  }
});

test('only an explicit manual release opt-in permits ad-hoc and stable identity still wins', () => {
  const manual = { GITHUB_EVENT_NAME: 'workflow_dispatch', RELEASE_TAG_INPUT: 'v9.8.7', MACOS_ALLOW_ADHOC_RELEASE: '1' };
  assert.deepEqual(signingPolicy(manual), { release: true, identity: '-', kind: 'adhoc' });
  assert.equal(signingPolicy({ ...manual, APPLE_SIGNING_IDENTITY: 'Maintainer fixed certificate' }).kind, 'stable');
  assert.equal(buildEnvironment({ ...manual, APPLE_CERTIFICATE: '', APPLE_CERTIFICATE_PASSWORD: '' }).APPLE_SIGNING_IDENTITY, '-');
  assert.throws(() => signingPolicy({ GITHUB_REF: 'refs/tags/v9.8.7', GITHUB_EVENT_NAME: 'push', MACOS_ALLOW_ADHOC_RELEASE: '1' }), /release blocked/);
  assert.throws(() => signingPolicy({ MACOS_SIGNING_RELEASE: '1', MACOS_ALLOW_ADHOC_RELEASE: '1' }), /release blocked/);
  for (const env of [{ APPLE_CERTIFICATE: 'p12-fixture' }, { APPLE_CERTIFICATE_PASSWORD: 'test-only' }]) {
    assert.throws(() => signingPolicy({ ...manual, ...env }), /together/);
  }
  assert.throws(() => signingPolicy({ ...manual, APPLE_SIGNING_IDENTITY: '-', APPLE_CERTIFICATE: 'p12-fixture', APPLE_CERTIFICATE_PASSWORD: 'test-only' }), /non-ad-hoc/);
  const optedIn = signingPolicy(manual);
  assert.equal(validateSignature(signature(hashRequirement, APP_IDENTIFIER, true), optedIn).requirement, hashRequirement);
  assert.throws(() => validateSignature(signature(), optedIn), /does not match/);
});

test('manual ad-hoc release logs its notarization and per-credential update limitations', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./mac-signing.mjs', import.meta.url)), 'check'], {
    encoding: 'utf8', env: { GITHUB_EVENT_NAME: 'workflow_dispatch', RELEASE_TAG_INPUT: 'v9.8.7', MACOS_ALLOW_ADHOC_RELEASE: '1' },
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /adhoc \(release\)/);
  assert.match(result.stderr, /Maintainer explicitly selected/);
  assert.match(result.stderr, /not notarized/);
  assert.match(result.stderr, /each saved credential/);
});

test('development requires explicit ad-hoc opt-in; a supplied stable identity is preserved', () => {
  assert.throws(() => signingPolicy({}), /explicitly set/);
  assert.equal(signingPolicy({ APPLE_SIGNING_IDENTITY: '-' }).kind, 'adhoc');
  assert.equal(adhoc.identity, '-');
  assert.equal(signingPolicy({ APPLE_SIGNING_IDENTITY: 'Maintainer private certificate', MACOS_ALLOW_ADHOC: '1' }).identity, 'Maintainer private certificate');
});

test('stable release supports installed identities and Tauri certificate inputs', () => {
  assert.equal(signingPolicy({ APPLE_SIGNING_IDENTITY: 'Maintainer certificate', MACOS_SIGNING_RELEASE: '1' }).kind, 'stable');
  assert.equal(signingPolicy({ APPLE_SIGNING_IDENTITY: 'Developer ID Application: Fixture', APPLE_CERTIFICATE: 'p12-fixture', APPLE_CERTIFICATE_PASSWORD: 'test-only', GITHUB_REF: 'refs/tags/v0.2.2' }).kind, 'stable');
  for (const env of [{ APPLE_CERTIFICATE: 'p12-fixture' }, { APPLE_CERTIFICATE_PASSWORD: 'test-only' }]) {
    assert.throws(() => signingPolicy({ APPLE_SIGNING_IDENTITY: 'Fixture', ...env }), /together/);
  }
  assert.throws(() => signingPolicy({ APPLE_SIGNING_IDENTITY: '-', APPLE_CERTIFICATE: 'p12-fixture', APPLE_CERTIFICATE_PASSWORD: 'test-only' }), /non-ad-hoc/);
  assert.throws(() => signingPolicy({ APPLE_SIGNING_IDENTITY: 'Fixture\nInjected' }), /single signing identity/);
});

test('missing Actions secrets do not make Tauri import an empty certificate', () => {
  const env = { MACOS_ALLOW_ADHOC: '1', APPLE_SIGNING_IDENTITY: '', APPLE_CERTIFICATE: '', APPLE_CERTIFICATE_PASSWORD: '' };
  const next = buildEnvironment(env);
  assert.equal(next.APPLE_SIGNING_IDENTITY, '-');
  assert.equal('APPLE_CERTIFICATE' in next, false);
  assert.equal('APPLE_CERTIFICATE_PASSWORD' in next, false);
  assert.equal(env.APPLE_CERTIFICATE, '');
  const configured = { APPLE_SIGNING_IDENTITY: 'Fixture', APPLE_CERTIFICATE: 'p12-fixture', APPLE_CERTIFICATE_PASSWORD: 'test-only' };
  assert.deepEqual(buildEnvironment(configured), configured);
});

test('stable requirements allow Developer ID and fixed self-signed anchors', () => {
  assert.equal(validateSignature(signature(), stable).requirement, appleRequirement);
  const bareTeam = appleRequirement.replace('\"TEAM\"', 'EQHXZ8M8AV');
  assert.equal(validateSignature(signature(bareTeam), stable).requirement, bareTeam);
  assert.equal(validateSignature(signature(selfSignedRequirement), stable).requirement, selfSignedRequirement);
  assert.equal(validateSignature(signature().replace('# designated', 'designated'), stable).requirement, appleRequirement);
});

test('verification rejects changed bundle identity, unsigned/ad-hoc and per-build requirements', () => {
  assert.throws(() => validateSignature(signature(appleRequirement, 'another.app'), stable), /identifier/);
  assert.throws(() => validateSignature(signature(hashRequirement, APP_IDENTIFIER, true), stable), /certificate-backed/);
  assert.throws(() => validateSignature(signature(hashRequirement), stable), /build hash/);
  assert.throws(() => validateSignature(signature('identifier "another.app" and anchor apple generic'), stable), /existing application identifier/);
  assert.throws(() => validateSignature(signature(`identifier "${APP_IDENTIFIER}"`), stable), /certificate anchor/);
  assert.throws(() => validateSignature(signature(`identifier "${APP_IDENTIFIER}" and anchor apple generic`), stable), /certificate anchor/);
  assert.throws(() => validateSignature(signature(`${appleRequirement} or identifier "${APP_IDENTIFIER}"`), stable), /custom requirements/);
  assert.throws(() => validateSignature(`Identifier=${APP_IDENTIFIER}\nAuthority=Fixture\n`, stable), /no designated requirement/);
  assert.equal(validateSignature(signature(hashRequirement, APP_IDENTIFIER, true), adhoc).requirement, hashRequirement);
});

function mockTools({ plistIdentifier = APP_IDENTIFIER, intelSignature = signature(), failIntegrity = false } = {}) {
  const checkedArchitectures = [];
  const run = (command, args) => {
    if (command.endsWith('/plutil')) return args[1] === 'CFBundleIdentifier' ? plistIdentifier : 'open-storyboard-canvas';
    if (command.endsWith('/lipo')) return 'x86_64 arm64';
    if (args[0] === '--verify') { if (failIntegrity) throw new Error('codesign integrity failure'); return ''; }
    const arch = args[args.indexOf('--arch') + 1]; checkedArchitectures.push(arch);
    return arch === 'x86_64' ? intelSignature : signature();
  };
  return { run, checkedArchitectures };
}

test('bundle verification checks both universal architectures and rejects a failing slice', () => {
  const tools = mockTools();
  assert.deepEqual(verifyApplication('/fixture/App.app', stable, tools.run).architectures, ['x86_64', 'arm64']);
  assert.deepEqual(tools.checkedArchitectures, ['x86_64', 'arm64']);
  assert.throws(() => verifyApplication('/fixture/App.app', stable, mockTools({ intelSignature: signature(hashRequirement, APP_IDENTIFIER, true) }).run), /certificate-backed/);
  assert.throws(() => verifyApplication('/fixture/App.app', stable, mockTools({ intelSignature: signature(selfSignedRequirement) }).run), /different designated requirements/);
  assert.throws(() => verifyApplication('/fixture/App.app', stable, mockTools({ plistIdentifier: 'another.app' }).run), /Bundle identifier/);
  assert.throws(() => verifyApplication('/fixture/App.app', stable, mockTools({ failIntegrity: true }).run), /integrity failure/);
});
