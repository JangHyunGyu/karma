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
  getKarmaRateLimitPolicy,
  saveKarmaAnalysisImageToR2,
  handleFaceReading,
  handlePalmReading
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

test('valid photo uploads are persisted privately before every analysis outcome', async () => {
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
  assert.ok(
    faceHandler.indexOf('saveKarmaAnalysisImageToR2(') < faceHandler.indexOf('callKarmaVisionAi('),
    'face images must be stored before AI analysis starts',
  );
  assert.ok(
    palmHandler.indexOf('saveKarmaAnalysisImageToR2(') < palmHandler.indexOf('callKarmaVisionAi('),
    'palm images must be stored before AI analysis starts',
  );
  assert.doesNotMatch(workerSource, /R2_PUBLIC_URL/);

  let stored = null;
  const key = await security.saveKarmaAnalysisImageToR2({
    KARMA_IMAGE_BUCKET: {
      async put(objectKey, bytes, options) {
        stored = { objectKey, bytes: Array.from(bytes), options };
      },
    },
  }, {
    image: jpeg,
    mimeType: 'image/jpeg',
    analysisType: 'face',
    requestId: 'request-123',
  });
  assert.match(key, /^karma\/face\/\d+-request-123\.jpg$/);
  assert.equal(stored.objectKey, key);
  assert.deepEqual(stored.bytes, Array.from(Buffer.from(jpeg, 'base64')));
  assert.equal(stored.options.httpMetadata.contentType, 'image/jpeg');

  const rateLimitedContext = {};
  const rateLimitedResponse = await security.handleFaceReading(new Request('https://karma-api.example/api/face-reading', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: jpeg, mimeType: 'image/jpeg', lang: 'en' }),
  }), {
    KARMA_IMAGE_BUCKET: {
      async put() {},
    },
  }, 'rate-limited-request', jsonResponse({ error: 'Too many requests' }, 429), rateLimitedContext);
  assert.equal(rateLimitedResponse.status, 429);
  assert.match(rateLimitedContext.r2Key, /^karma\/face\/\d+-rate-limited-request\.jpg$/);

  const unavailableContext = {};
  const unavailableResponse = await security.handlePalmReading(new Request('https://karma-api.example/api/palm-reading', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: jpeg, mimeType: 'image/jpeg', lang: 'en' }),
  }), {
    KARMA_IMAGE_BUCKET: {
      async put() {},
    },
  }, 'service-unavailable-request', null, unavailableContext);
  assert.equal(unavailableResponse.status, 503);
  assert.match(unavailableContext.r2Key, /^karma\/palm\/\d+-service-unavailable-request\.jpg$/);

  let aiCalledWithoutStorage = false;
  const storageFailureResponse = await security.handleFaceReading(new Request('https://karma-api.example/api/face-reading', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: jpeg, mimeType: 'image/jpeg', lang: 'en' }),
  }), {
    KARMA_IMAGE_BUCKET: {
      async put() { throw new Error('simulated R2 outage'); },
    },
    AI: {
      async analyze() {
        aiCalledWithoutStorage = true;
        return { text: '{}' };
      },
    },
  }, 'storage-failure-request', null, {});
  assert.equal(storageFailureResponse.status, 503);
  assert.equal(aiCalledWithoutStorage, false);
});

function jsonResponse(data, status) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('AI analysis budgets distinguish photo and text traffic while photo handlers still persist first', () => {
  assert.equal(security.getKarmaRateLimitPolicy('face').bucket, 'photo');
  assert.equal(security.getKarmaRateLimitPolicy('face').limit, 5);
  assert.equal(security.getKarmaRateLimitPolicy('tarot').bucket, 'text');
  assert.equal(security.getKarmaRateLimitPolicy('tarot').limit, 20);
  const loggedHandler = workerSource.slice(
    workerSource.indexOf('async function handleLoggedKarmaAnalysis'),
    workerSource.indexOf('async function recordKarmaImageAnalysis')
  );
  assert.match(loggedHandler, /await enforceKarmaAnalysisRateLimit\(request, env, analysisType\)/);
  assert.match(loggedHandler, /rateLimitError && !isPhotoAnalysis/);
  assert.match(loggedHandler, /handler\(request, env, requestId, rateLimitError, analysisContext\)/);
});
