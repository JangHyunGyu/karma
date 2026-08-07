'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const workerPath = path.join(__dirname, '../assets/js/worker.js');
const workerSource = fs.readFileSync(workerPath, 'utf8');
const instrumentedSource = workerSource.replace('export default {', 'globalThis.__worker = {') + `
globalThis.__karmaSecurity = {
  PHOTO_MAX_UPLOAD_BYTES,
  PHOTO_MAX_REQUEST_BYTES,
  validatePhotoImageInput,
  getKarmaAdminAuthError,
  getKarmaRateLimitPolicy
};`;
const context = {
  console: { log() {}, warn() {}, error() {} },
  crypto: webcrypto,
  TextEncoder,
  Uint8Array,
  Response,
  Request,
  URL,
  atob,
  btoa,
  setTimeout,
  clearTimeout,
};
vm.runInNewContext(instrumentedSource, context);
const security = context.__karmaSecurity;

function requestWithToken(token = '') {
  return new Request('https://karma-api.example/api/r2/list', {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

test('management routes fail closed unless the configured admin token matches', async () => {
  assert.equal(security.getKarmaAdminAuthError(requestWithToken(), {}).status, 404);
  assert.equal(security.getKarmaAdminAuthError(requestWithToken('wrong'), { KARMA_ADMIN_TOKEN: 'correct' }).status, 401);
  assert.equal(security.getKarmaAdminAuthError(requestWithToken('correct'), { KARMA_ADMIN_TOKEN: 'correct' }), null);

  for (const route of ['/api/error-log', '/api/r2/list', '/api/r2/image', '/api/r2/delete']) {
    const routeIndex = workerSource.indexOf(`path === '${route}'`);
    assert.ok(routeIndex >= 0, `${route} route is missing`);
    const routeBlock = workerSource.slice(routeIndex, routeIndex + 320);
    assert.match(routeBlock, /getKarmaAdminAuthError\(request, env\)/, `${route} is not protected`);
  }
});

test('photo uploads are compact, typed, and never persisted to public R2 before analysis', () => {
  assert.equal(security.PHOTO_MAX_UPLOAD_BYTES, 8 * 1024 * 1024);
  assert.ok(security.PHOTO_MAX_REQUEST_BYTES > security.PHOTO_MAX_UPLOAD_BYTES);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]).toString('base64');
  assert.equal(security.validatePhotoImageInput(jpeg, 'image/jpeg', 'ko').mimeType, 'image/jpeg');
  assert.match(security.validatePhotoImageInput(jpeg, 'image/png', 'ko').error, /손상된 이미지/);
  assert.match(security.validatePhotoImageInput('not-base64!', 'image/jpeg', 'en').error, /damaged or unsupported/);

  const faceStart = workerSource.indexOf('async function handleFaceReading');
  const palmStart = workerSource.indexOf('async function handlePalmReading');
  const faceHandler = workerSource.slice(faceStart, palmStart);
  const palmHandler = workerSource.slice(palmStart, workerSource.indexOf('// ============================================================', palmStart));
  assert.doesNotMatch(faceHandler, /R2_BUCKET|saveImageToR2|R2_PUBLIC_URL/);
  assert.doesNotMatch(palmHandler, /R2_BUCKET|saveImageToR2|R2_PUBLIC_URL/);
  assert.doesNotMatch(workerSource, /R2_PUBLIC_URL/);
});

test('AI analysis budgets distinguish photo and text traffic and run before handlers', () => {
  assert.equal(security.getKarmaRateLimitPolicy('face').bucket, 'photo');
  assert.equal(security.getKarmaRateLimitPolicy('face').limit, 5);
  assert.equal(security.getKarmaRateLimitPolicy('tarot').bucket, 'text');
  assert.equal(security.getKarmaRateLimitPolicy('tarot').limit, 20);
  const loggedHandler = workerSource.slice(
    workerSource.indexOf('async function handleLoggedKarmaAnalysis'),
    workerSource.indexOf('async function recordKarmaImageAnalysis')
  );
  assert.match(loggedHandler, /await enforceKarmaAnalysisRateLimit\(request, env, analysisType\)/);
});
