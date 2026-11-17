const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const workerPath = path.join(__dirname, '..', 'assets', 'js', 'worker.js');

function loadWorkerSandbox() {
  let source = fs.readFileSync(workerPath, 'utf8');
  source = source.replace('export default {', 'const __workerExport = {');
  source += `
globalThis.__karmaConsistency = {
  handler: __workerExport,
  calculateSaju,
  normalizeFaceAiScores,
  normalizePalmAiGrade,
  computeFaceCategoryScoreFromRubric,
  computePalmLineScoreFromRubric,
  calculateCompatCategoryScores,
  normalizeCompatAiScores,
  calculateFortuneLucky,
  normalizeFortuneLucky,
  calculateDailyLucky,
  normalizeDailyLucky,
  sanitizeAiObjectKeys,
  validateFaceAiResponse,
  validatePalmAiResponse,
  validateKarmaAiContract,
  hammingDistanceHex256,
  extractPhotoDimensions,
  normalizeKarmaBirthDateKey,
  normalizeKarmaBirthTimeKey,
  isCacheableKarmaResult,
  lookupKarmaPhotoConsistencyCache,
  KARMA_CONSISTENCY_SCHEMA_VERSION,
};
`;
  const context = {
    console,
    fetch: global.fetch,
    Request: global.Request,
    Response: global.Response,
    Headers: global.Headers,
    URL: global.URL,
    crypto: global.crypto,
    TextEncoder: global.TextEncoder,
    TextDecoder: global.TextDecoder,
    atob: global.atob,
    btoa: global.btoa,
    setTimeout,
    clearTimeout,
  };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: workerPath });
  return context.__karmaConsistency;
}

const worker = loadWorkerSandbox();

function makeJpegBase64(seedByte = 0x11) {
  const bytes = Uint8Array.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
    0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9, seedByte,
  ]);
  return Buffer.from(bytes).toString('base64');
}

function makeFaceAiFixture(rubrics, overrides = {}) {
  const names = ['이마 (천정)', '눈 (눈매)', '코 (준두)', '입 (입술)', '턱/광대', '피부 (기색)'];
  return {
    forehead_observation: {
      observation: '눈썹 위 이마 피부 중앙이 넓게 드러나며 앞머리 경계는 좌측만 보입니다.',
      limitation: '',
      skin_visible: true,
      hairline_visible: true,
      ...(overrides.forehead_observation || {}),
    },
    quality_assessment: '정면 조명이 균일하고 이목구비 윤곽이 또렷합니다.',
    visual_evidence: [
      '이마 폭이 좌우 균형 있게 열려 있음',
      '눈매가 정면을 향해 또렷함',
      '콧대와 코끝 중심선이 곧음',
      '입술 두께가 위아래 균형 잡힘',
      '턱선이 완만하고 좌우 대칭적임',
      '피부결에 뚜렷한 잡티와 붉은기가 적음',
      '좌우 눈썹 간격이 안정적임',
      '정면 기준 전체 비율이 안정적임',
    ],
    summary: '이목구비 대칭과 정면 윤곽이 고르게 잡힌 인상으로 초년과 중년 기반이 안정적으로 읽힙니다.',
    categories: [
      ...names.map((name, idx) => ({
        name,
        rubric: rubrics[idx],
        score: 77,
        desc: `${name} 부위의 윤곽과 대칭 관찰을 기준으로 해석합니다. 안정적인 흐름을 보입니다. 생활 리듬을 점검하세요.`,
        caution: '과도한 피로 누적을 피하고 주간 루틴을 점검하세요.',
      })),
      {
        name: '전체 인상',
        desc: '여섯 부위 전반의 조화가 안정적으로 이어집니다. 세부 점검 항목만 보완하면 좋습니다.',
        caution: '강한 조명 변화에 따라 컨디션 체감이 달라질 수 있으니 수면을 유지하세요.',
      },
    ],
    fortune: {
      wealth: '코끝과 콧방울의 형태를 기준으로 지출 관리 흐름을 살핍니다. 충동 지출 전에 예산을 점검해 보세요.',
      career: '이마와 눈매의 균형을 기준으로 꾸준한 실행 흐름을 봅니다. 우선순위를 나누어 진행할 때 유리합니다.',
      love: '눈매와 입꼬리의 인상을 기준으로 차분한 소통 방식을 봅니다. 대화 속도를 맞추는 태도가 좋습니다.',
      health: '피부 기색과 눈 주변 긴장도를 기준으로 수면과 수분 섭취를 점검하는 것이 도움이 됩니다.',
    },
    advice: '관찰된 균형감을 살리되 하루 수면 시간을 일정하게 유지해 컨디션을 관리하세요.',
    celebrity_resemblance: '',
    appearance: {
      types: ['단정한 분위기', '안정형 인상'],
      highlights: [
        { feature: '눈매', description: '시선이 또렷하고 가로 비율이 균형적입니다.' },
        { feature: '턱선', description: '하관 윤곽이 안정적으로 이어집니다.' },
      ],
      harmony: '상정·중정·하정의 비율이 고르게 잡혀 차분한 첫인상을 만듭니다.',
      first_impression: '과장되지 않고 정돈된 분위기로 보입니다.',
      style: {
        hair: '이마 중앙을 자연스럽게 드러내는 가르마가 얼굴 비율을 깔끔하게 살립니다.',
        accessories: '',
        photo: '정면 시선을 유지한 구도가 좌우 균형을 가장 잘 보여줍니다.',
        makeup: '눈썹 결을 자연스럽게 정돈하고 차분한 립 톤을 쓰는 편이 어울립니다.',
        grooming: '',
      },
      adult_subject: false,
      sex_appeal: '',
      cosmetic_consultation: [],
    },
    personal_color: {
      season: 'autumn',
      undertone: 'warm',
      observation: '피부 톤과 눈동자·머리카락 명도 대비가 차분한 중간 명도입니다.',
      limitation: '실내 조명의 영향을 받아 자연광에서 한 번 더 비교하는 편이 정확합니다.',
      colors: [
        { name: '따뜻한 카멜', hex: '#C19A6B' },
        { name: '올리브 그린', hex: '#6B8E23' },
        { name: '코랄 베이지', hex: '#D98A6C' },
      ],
      styling_tip: '상의나 아우터에 카멜과 올리브 계열을 비교해 보세요.',
    },
    ...overrides,
  };
}

function makePalmAiFixture(lineConfigs, overrides = {}) {
  return {
    overall_score: 70,
    quality_assessment: '손바닥 중앙과 주요 손금이 또렷하게 촬영되었습니다.',
    visual_evidence: [
      '생명선이 손바닥 아래까지 깊게 이어짐',
      '두뇌선이 중앙을 가로지르며 안정적임',
      '감정선 끝이 검지 아래쪽으로 부드럽게 향함',
      '운명선 세로 줄기가 손목 쪽에서 뻗어 올라감',
      '태양선 구역의 주선 형태가 확인됨',
      '손바닥 폭과 손가락 길이가 균형적임',
      '엄지 각도가 자연스럽게 열려 있음',
      '피부 주름 과노출 없이 선 음영이 보임',
    ],
    summary: '주선 흐름이 분명한 손바닥으로 실행력과 생활 리듬의 대비가 뚜렷하게 나타납니다.',
    lines: lineConfigs.map((cfg) => ({
      name: cfg.name,
      rubric: cfg.rubric,
      score: cfg.rawScore ?? 68,
      length: cfg.length,
      desc: `${cfg.name}의 선명도와 이어짐을 관찰한 결과입니다. ${cfg.length} 수준으로 보이며 일상 속 균형을 점검하세요.`,
      caution: '무리한 일정이 겹치지 않도록 주간 회복 시간을 확보하세요.',
    })),
    hand_shape: {
      type: '나무형',
      desc: '손바닥과 손가락 비율이 길게 뻗은 형태로 사고와 계획을 세밀하게 정리하는 기질을 상징합니다.',
    },
    fortune: {
      wealth: '태양선과 운명선 흐름을 기준으로 수입과 지출 기록을 나누어 살피는 습관이 유리합니다.',
      career: '두뇌선과 운명선의 방향을 기준으로 장기 과제를 단계별로 쪼개어 진행할 때 강점이 살아납니다.',
      love: '감정선 곡선을 기준으로 상대의 감정 속도를 먼저 확인하는 대화 방식이 관계를 안정시킵니다.',
      health: '생명선과 손바닥 긴장도를 기준으로 수면 부족과 손목 피로를 주기적으로 관리하세요.',
    },
    advice: '뚜렷한 주선이 가리키는 강점을 살리되 일주일 단위로 일정과 지출을 점검하는 루틴을 실천하세요.',
    ...overrides,
  };
}

function createStatefulMockEnv() {
  const cacheRows = new Map();
  const r2Puts = [];
  const imageAnalysisLogs = [];
  const karmaAnalysisLogs = [];

  const db = {
    prepare(sql) {
      const execute = async (args) => {
        if (sql.includes('INSERT INTO analysis_consistency_cache')) {
          cacheRows.set(args[0], {
            cache_key: args[0],
            analysis_type: args[1],
            schema_version: args[2],
            options_key: args[3],
            perceptual_hash: args[4],
            result_json: args[5],
            expires_at: args[6],
          });
          return { success: true };
        }
        if (sql.includes('INSERT INTO karma_image_analyses')) {
          imageAnalysisLogs.push({ requestId: args[0], r2Key: args[1], analysisType: args[2], status: args[3] });
          return { success: true };
        }
        if (sql.includes('INSERT INTO karma_analyses') || sql.includes('INSERT OR IGNORE INTO karma_analyses')) {
          karmaAnalysisLogs.push({ sql, args });
          return { success: true };
        }
        return { success: true };
      };
      return {
        bind(...args) {
          return {
            async run() { return execute(args); },
            async first() {
              if (sql.includes('FROM analysis_consistency_cache')) {
                const row = cacheRows.get(args[0]);
                if (!row) return null;
                if (sql.includes('expires_at > ?') && !(row.expires_at > args[1])) return null;
                return row;
              }
              if (sql.includes('karma_rate_limits')) {
                return { count: 1 };
              }
              return null;
            },
            async all() {
              if (sql.includes('FROM analysis_consistency_cache')) {
                const [analysisType, schemaVersion, optionsKey, nowMs] = args;
                const results = [...cacheRows.values()].filter(row => (
                  row.analysis_type === analysisType
                  && row.schema_version === schemaVersion
                  && row.options_key === optionsKey
                  && Boolean(row.perceptual_hash)
                  && row.expires_at > nowMs
                )).reverse();
                return { results };
              }
              return { results: [] };
            },
          };
        },
        async run() { return execute([]); },
        async first() { return null; },
        async all() { return { results: [] }; },
      };
    },
    async batch(statements) {
      return Promise.all((statements || []).map(stmt => stmt.run()));
    },
  };

  const bucket = {
    async put(key, bytes, opts) {
      r2Puts.push({ key, bytes, opts });
    },
  };

  return {
    env: { DB: db, KARMA_IMAGE_BUCKET: bucket },
    cacheRows,
    r2Puts,
    imageAnalysisLogs,
    karmaAnalysisLogs,
  };
}

test('face rubric computes deterministic scores, hairline visibility cap, skin threshold, and legacy fallback', () => {
  const topRubrics = Array.from({ length: 6 }, () => ({ structure: 5, symmetry: 5, condition: 5, visibility: 3 }));
  const lowRubrics = Array.from({ length: 6 }, () => ({ structure: 1, symmetry: 1, condition: 1, visibility: 3 }));

  const firstRun = worker.normalizeFaceAiScores(makeFaceAiFixture(topRubrics));
  const secondRun = worker.normalizeFaceAiScores(makeFaceAiFixture(topRubrics));
  assert.deepEqual(firstRun, secondRun);
  assert.equal(firstRun.categories[0].score, 95);
  assert.equal(firstRun.overall_score, 95);
  assert.equal(firstRun.overall_grade, 'S');
  assert.equal(firstRun.categories[6].score, 95);

  const lowRun = worker.normalizeFaceAiScores(makeFaceAiFixture(lowRubrics));
  assert.equal(lowRun.categories[0].score, 34);
  assert.equal(lowRun.overall_score, 34);

  const hairlineHidden = worker.normalizeFaceAiScores(makeFaceAiFixture(topRubrics, {
    forehead_observation: {
      observation: '눈썹 위 이마 피부는 넓게 보이나 헤어라인은 앞머리에 가려져 있습니다.',
      limitation: '헤어라인 상단 경계 확인 어려움',
      skin_visible: true,
      hairline_visible: false,
    },
  }));
  assert.equal(hairlineHidden.categories[0].rubric.visibility, 2);
  assert.equal(hairlineHidden.categories[0].score, 92);

  const fullyHiddenForehead = worker.normalizeFaceAiScores(makeFaceAiFixture(topRubrics, {
    forehead_observation: {
      observation: '두꺼운 모자가 눈썹 바로 위까지 덮여 있습니다.',
      limitation: '모자로 이마 전체 가림',
      skin_visible: false,
      hairline_visible: false,
    },
  }));
  assert.equal(fullyHiddenForehead.categories[0].rubric.visibility, 0);
  assert.equal(fullyHiddenForehead.categories[0].score, 48);

  const poorSkinRubrics = [
    ...Array.from({ length: 5 }, () => ({ structure: 4, symmetry: 4, condition: 4, visibility: 3 })),
    { structure: 3, symmetry: 3, condition: 2, visibility: 3 },
  ];
  const avgSkinRubrics = [
    ...Array.from({ length: 5 }, () => ({ structure: 4, symmetry: 4, condition: 4, visibility: 3 })),
    { structure: 3, symmetry: 3, condition: 3, visibility: 3 },
  ];
  const poorSkin = worker.normalizeFaceAiScores(makeFaceAiFixture(poorSkinRubrics));
  const avgSkin = worker.normalizeFaceAiScores(makeFaceAiFixture(avgSkinRubrics));
  assert.equal(poorSkin.categories[5].score, 61);
  assert.equal(avgSkin.categories[5].score, 68);
  assert.ok(poorSkin.categories[5].score <= 65 && avgSkin.categories[5].score > 65);

  const legacyFixture = makeFaceAiFixture(topRubrics);
  legacyFixture.categories = legacyFixture.categories.map((cat, idx) => {
    const { rubric: _ignored, ...rest } = cat;
    return idx < 6 ? { ...rest, score: 70 + idx } : rest;
  });
  const legacyResult = worker.normalizeFaceAiScores(legacyFixture);
  assert.deepEqual(legacyResult.categories.slice(0, 6).map(c => c.score), [70, 71, 72, 73, 74, 75]);
  assert.equal(legacyResult.overall_score, 73);
  assert.equal(legacyResult.overall_grade, 'B');
});

test('palm rubric enforces length cross-locks, excludes unreadable lines, and keeps legacy compatibility', () => {
  const withUnreadableMarriage = makePalmAiFixture([
    { name: '생명선', length: '길다', rubric: { depth: 5, continuity: 5, definition: 5, visibility: 3 } },
    { name: '두뇌선', length: '길다', rubric: { depth: 5, continuity: 4, definition: 5, visibility: 3 } },
    { name: '감정선', length: '길다', rubric: { depth: 5, continuity: 5, definition: 4, visibility: 3 } },
    { name: '운명선', length: '뚜렷', rubric: { depth: 5, continuity: 4, definition: 5, visibility: 3 } },
    { name: '태양선', length: '있음', rubric: { depth: 4, continuity: 4, definition: 4, visibility: 3 } },
    { name: '결혼선', length: '확인 어려움', rubric: { depth: 2, continuity: 2, definition: 2, visibility: 2 } },
  ]);
  const palmA = worker.normalizePalmAiGrade(withUnreadableMarriage);
  const palmB = worker.normalizePalmAiGrade(withUnreadableMarriage);
  assert.deepEqual(palmA, palmB);
  assert.equal(palmA.lines[5].score, 50);
  assert.equal(palmA.lines[5].rubric.visibility, 0);
  assert.ok(palmA.overall_score >= 88, `expected unreadable side line not to drag score down, got ${palmA.overall_score}`);
  assert.equal(palmA.overall_grade, 'S');

  const crossLocked = worker.normalizePalmAiGrade(makePalmAiFixture([
    { name: '생명선', length: '길다', rubric: { depth: 4, continuity: 4, definition: 1, visibility: 3 } },
    { name: '두뇌선', length: '짧다', rubric: { depth: 3, continuity: 3, definition: 5, visibility: 3 } },
    { name: '감정선', length: '보통', rubric: { depth: 3, continuity: 3, definition: 3, visibility: 3 } },
    { name: '운명선', length: '뚜렷', rubric: { depth: 1, continuity: 4, definition: 1, visibility: 3 } },
    { name: '태양선', length: '희미', rubric: { depth: 5, continuity: 3, definition: 5, visibility: 3 } },
    { name: '결혼선', length: '없음', rubric: { depth: 5, continuity: 5, definition: 5, visibility: 3 } },
  ]));
  assert.ok(crossLocked.lines[3].score >= 76, `뚜렷 expected >= 76, got ${crossLocked.lines[3].score}`);
  assert.ok(crossLocked.lines[4].score >= 51 && crossLocked.lines[4].score <= 57, `희미 expected 51..57, got ${crossLocked.lines[4].score}`);
  assert.ok(crossLocked.lines[5].score <= 40, `없음 expected <= 40, got ${crossLocked.lines[5].score}`);

  const legacyPalm = makePalmAiFixture([
    { name: '생명선', length: '길다', rawScore: 84 },
    { name: '두뇌선', length: '보통', rawScore: 76 },
    { name: '감정선', length: '보통', rawScore: 80 },
    { name: '운명선', length: '뚜렷', rawScore: 72 },
    { name: '태양선', length: '있음', rawScore: 66 },
    { name: '결혼선', length: '1개', rawScore: 62 },
  ]);
  for (const line of legacyPalm.lines) delete line.rubric;
  const legacyNorm = worker.normalizePalmAiGrade(legacyPalm);
  assert.deepEqual(legacyNorm.lines.map(l => l.score), [84, 76, 80, 72, 66, 62]);
  assert.equal(legacyNorm.overall_grade, 'B');
});

test('compat category scoring, colon-key sanitization, and fortune/daily lucky values are deterministic', () => {
  const sanitized = worker.sanitizeAiObjectKeys({
    ':summary': '조합 요약',
    ':categories': {
      ':personality': { ':score': 82, ':desc': '서술' },
      ':intimacy': { ':score': 74, ':desc': '서술' },
    },
  });
  assert.equal(sanitized.summary, '조합 요약');
  assert.equal(sanitized.categories.personality.score, 82);
  assert.equal(sanitized.categories.intimacy.desc, '서술');

  const degenerate = worker.sanitizeAiObjectKeys({ ':': { ': ': { '': '' } } });
  assert.equal(Object.keys(degenerate)[0], ':');
  assert.equal(worker.validateKarmaAiContract('saju', degenerate, { hasTime: true, daeunCount: 8, lang: 'ko' }).ok, false);

  const sajuA = worker.calculateSaju('1991-02-03', '07:30', 'female', false, 'utc+9');
  const sajuB = worker.calculateSaju('1989-09-14', '19:10', 'male', false, 'utc+9');
  const scores1 = worker.calculateCompatCategoryScores(sajuA, sajuB, '1991-02-03', '1989-09-14', '2026-11-17');
  const scores2 = worker.calculateCompatCategoryScores(sajuA, sajuB, '1991-02-03', '1989-09-14', '2026-11-17');
  assert.deepEqual(scores1, scores2);
  for (const key of ['personality', 'intimacy', 'finance', 'timing']) {
    assert.ok(Number.isInteger(scores1[key]) && scores1[key] >= 20 && scores1[key] <= 96);
  }
  const overridden = worker.normalizeCompatAiScores({
    summary: '요약',
    advice: '조언',
    strengths: ['a', 'b', 'c'],
    cautions: ['a', 'b', 'c'],
    categories: {
      personality: { score: 11, desc: 'a' },
      intimacy: { score: 22, desc: 'b' },
      finance: { score: 33, desc: 'c' },
      timing: { score: 44, desc: 'd' },
    },
  }, scores1);
  assert.deepEqual(
    Object.fromEntries(Object.entries(overridden.categories).map(([k, v]) => [k, v.score])),
    { ...scores1 },
  );

  const fortuneKo1 = worker.calculateFortuneLucky(sajuA, 2026, 'ko');
  const fortuneKo2 = worker.calculateFortuneLucky(sajuA, 2026, 'ko');
  const fortuneEn1 = worker.calculateFortuneLucky(sajuA, 2026, 'en');
  assert.deepEqual(fortuneKo1, fortuneKo2);
  assert.ok(!/[A-Za-z]{2,}/.test(Object.values(fortuneKo1).join(' ')));
  assert.ok(!/[가-힣]/.test(Object.values(fortuneEn1).join(' ')));

  const dailyKo1 = worker.calculateDailyLucky(sajuA, '2026-11-17', 'ko');
  const dailyKo2 = worker.calculateDailyLucky(sajuA, '2026-11-17', 'ko');
  const dailyEn1 = worker.calculateDailyLucky(sajuA, '2026-11-17', 'en');
  assert.deepEqual(dailyKo1, dailyKo2);
  assert.ok(!/[A-Za-z]{2,}/.test(Object.values(dailyKo1).join(' ')));
  assert.ok(!/[가-힣]/.test(Object.values(dailyEn1).join(' ')));
});

test('analysis_consistency_cache reuses identical results while always saving R2 images and logs, and invalidates on input changes', async () => {
  const mock = createStatefulMockEnv();
  let visionCalls = 0;
  let textCalls = 0;

  const faceTemplate = makeFaceAiFixture(Array.from({ length: 6 }, () => ({ structure: 4, symmetry: 4, condition: 4, visibility: 3 })));
  const palmTemplate = makePalmAiFixture([
    { name: '생명선', length: '길다', rubric: { depth: 4, continuity: 5, definition: 4, visibility: 3 } },
    { name: '두뇌선', length: '보통', rubric: { depth: 4, continuity: 4, definition: 4, visibility: 3 } },
    { name: '감정선', length: '길다', rubric: { depth: 4, continuity: 4, definition: 4, visibility: 3 } },
    { name: '운명선', length: '뚜렷', rubric: { depth: 4, continuity: 4, definition: 4, visibility: 3 } },
    { name: '태양선', length: '있음', rubric: { depth: 3, continuity: 4, definition: 3, visibility: 3 } },
    { name: '결혼선', length: '확인 어려움', rubric: { depth: 2, continuity: 2, definition: 2, visibility: 0 } },
  ]);
  const sajuTemplate = {
    pillar_reading: { year: '초년 흐름 설명', month: '사회 활동 흐름 설명', day: '일간 관계 방식 설명', hour: '말년과 목표 설명' },
    personality: '원국 성향 설명입니다. 두 가지 근거를 묶어 봅니다.',
    strengths: ['강점 하나 근거 포함', '강점 둘 근거 포함', '강점 셋 근거 포함'],
    cautions: ['주의 하나 근거 포함', '주의 둘 근거 포함', '주의 셋 근거 포함'],
    love_style: '관계 표현과 조율 방식 설명입니다.',
    career: '업무 환경과 역할 균형 설명입니다.',
    daeun_reading: Array.from({ length: 8 }, (_, idx) => `${idx + 1}번째 대운 흐름 설명입니다.`),
    advice: '지금 실행할 구체적인 행동 조언입니다.',
  };
  const compatTemplate = {
    summary: '서로 속도를 맞추면 안정적인 조합입니다.',
    categories: {
      personality: { score: 99, desc: '성격 대화 설명입니다.' },
      intimacy: { score: 99, desc: '친밀감 리듬 설명입니다.' },
      finance: { score: 11, desc: '재물 합의 설명입니다.' },
      timing: { score: 22, desc: '대운 타이밍 설명입니다.' },
    },
    strengths: ['보완 하나', '보완 둘', '보완 셋'],
    cautions: ['주의 하나', '주의 둘', '주의 셋'],
    advice: '서로 일정과 예산을 먼저 공유하는 행동 조언입니다.',
  };
  const fortuneTemplate = {
    year_summary: '올해 흐름 요약입니다.',
    love: '올해 관계 흐름입니다.',
    money: '올해 재물 점검 흐름입니다.',
    health: '올해 생활 리듬 점검입니다.',
    career: '올해 업무 흐름입니다.',
    lucky: { color: '무작위색', number: '999', direction: '무작위', month: '12월' },
    advice: '올해 실행 조언입니다.',
  };
  const dailyTemplate = {
    overall: '오늘 총운 요약입니다.',
    love: '오늘 관계 흐름입니다.',
    money: '오늘 지출 점검입니다.',
    career: '오늘 업무 집중입니다.',
    study: '오늘 학습 집중입니다.',
    social: '오늘 약속 조율입니다.',
    health: '오늘 컨디션 관리입니다.',
    lucky: { color: '무작위색', number: '999' },
    advice: '오늘 실행 행동입니다.',
  };
  const tarotTemplate = {
    cards: [
      { position: '현재', interpretation: '현재 흐름 해석입니다.' },
      { position: '장애', interpretation: '장애 요소 해석입니다.' },
      { position: '조언', interpretation: '행동 조언 해석입니다.' },
    ],
    overall: '타로 전체 흐름 요약입니다.',
    advice: '오늘 적용할 한 가지 행동입니다.',
    keywords: ['집중', '조율', '균형', '점검', '차분'],
  };

  const env = {
    ...mock.env,
    AI: {
      async analyze(input) {
        visionCalls += 1;
        const prompt = String(input?.prompt || '');
        const payload = prompt.includes('손금 해설가') ? palmTemplate : faceTemplate;
        return { text: JSON.stringify(payload), model: 'google/gemini-3.5-flash-lite', provider: 'test' };
      },
      async complete(input) {
        textCalls += 1;
        const sys = String(input?.messages?.[0]?.content || '');
        let payload = sajuTemplate;
        if (sys.includes('명리 궁합 해설가')) payload = compatTemplate;
        else if (sys.includes('현재 대운·세운의 계산된 관계')) payload = fortuneTemplate;
        else if (sys.includes('일진 해설가')) payload = dailyTemplate;
        else if (sys.includes('카드의 상징, 순서, 정·역방향')) payload = tarotTemplate;
        return { text: JSON.stringify(payload), model: 'google/gemma-4-31b-it', provider: 'test' };
      },
    },
  };

  const waitUntilPromises = [];
  const ctx = { waitUntil: p => waitUntilPromises.push(p) };
  const callRoute = async (pathname, body) => {
    const req = new Request(`https://karma.archerlab.dev${pathname}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' },
      body: JSON.stringify(body),
    });
    const res = await worker.handler.fetch(req, env, ctx);
    await Promise.all(waitUntilPromises.splice(0));
    return { status: res.status, headers: res.headers, data: await res.json() };
  };

  const jpeg1 = makeJpegBase64(0x11);
  const jpeg2 = makeJpegBase64(0x22);

  // 1) Face consistency + R2/D1 always persisted
  const face1 = await callRoute('/api/face-reading', { image: jpeg1, mimeType: 'image/jpeg', gender: '여성', age: '20대', lang: 'ko' });
  const face2 = await callRoute('/api/face-reading', { image: jpeg1, mimeType: 'image/jpeg', gender: 'female', age: '20s', lang: 'ko' });
  assert.equal(face1.status, 200);
  assert.equal(face2.status, 200);
  assert.deepEqual(face1.data, face2.data);
  assert.equal(visionCalls, 1);
  assert.equal(mock.r2Puts.length, 2);
  assert.notEqual(mock.r2Puts[0].key, mock.r2Puts[1].key);
  assert.equal(mock.imageAnalysisLogs.length, 2);

  // Changing gender/image misses cache
  await callRoute('/api/face-reading', { image: jpeg1, mimeType: 'image/jpeg', gender: '남성', age: '20대', lang: 'ko' });
  await callRoute('/api/face-reading', { image: jpeg2, mimeType: 'image/jpeg', gender: '여성', age: '20대', lang: 'ko' });
  assert.equal(visionCalls, 3);
  assert.equal(mock.r2Puts.length, 4);

  // 2) Palm consistency + R2/D1 always persisted + hand option invalidation
  const r2BeforePalm = mock.r2Puts.length;
  const visionBeforePalm = visionCalls;
  const palm1 = await callRoute('/api/palm-reading', { image: jpeg1, mimeType: 'image/jpeg', hand: 'left', dominant: 'right', gender: '여성', lang: 'ko' });
  const palm2 = await callRoute('/api/palm-reading', { image: jpeg1, mimeType: 'image/jpeg', hand: '왼손', dominant: '오른손', gender: 'female', lang: 'ko' });
  assert.equal(palm1.status, 200);
  assert.deepEqual(palm1.data, palm2.data);
  assert.equal(visionCalls, visionBeforePalm + 1);
  assert.equal(mock.r2Puts.length, r2BeforePalm + 2);
  await callRoute('/api/palm-reading', { image: jpeg1, mimeType: 'image/jpeg', hand: 'right', dominant: 'right', gender: '여성', lang: 'ko' });
  assert.equal(visionCalls, visionBeforePalm + 2);

  // 3) Text endpoints consistency cache
  const saju1 = await callRoute('/api/saju', { birth_date: '1991-02-03', birth_time: '07:30', gender: 'female', birth_location: '', lang: 'ko' });
  const saju2 = await callRoute('/api/saju', { birth_date: '1991-02-03', birth_time: '07:30', gender: 'female', birth_location: 'utc+9', lang: 'ko' });
  assert.equal(saju1.status, 200);
  assert.deepEqual(saju1.data, saju2.data);

  const compat1 = await callRoute('/api/compat-quick', {
    personA: { birth_date: '1991-02-03', birth_time: '07:30', gender: 'female', birth_location: '' },
    personB: { birth_date: '1989-09-14', birth_time: '19:10', gender: 'male', birth_location: '' },
    lang: 'ko',
  });
  const compat2 = await callRoute('/api/compat-quick', {
    personA: { birth_date: '1991-02-03', birth_time: '07:30', gender: 'female', birth_location: 'utc+9' },
    personB: { birth_date: '1989-09-14', birth_time: '19:10', gender: 'male', birth_location: 'kr' },
    lang: 'ko',
  });
  assert.equal(compat1.status, 200);
  assert.deepEqual(compat1.data, compat2.data);
  assert.notEqual(compat1.data.ai.categories.finance.score, 11);

  const fortune1 = await callRoute('/api/fortune', { birth_date: '1991-02-03', birth_time: '07:30', gender: 'female', birth_location: '', year: 2026, lang: 'ko' });
  const fortune2 = await callRoute('/api/fortune', { birth_date: '1991-02-03', birth_time: '07:30', gender: 'female', birth_location: 'utc+9', year: 2026, lang: 'ko' });
  assert.equal(fortune1.status, 200);
  assert.deepEqual(fortune1.data, fortune2.data);
  assert.notEqual(fortune1.data.fortune.lucky.color, '무작위색');

  const daily1 = await callRoute('/api/daily', { birth_date: '1991-02-03', birth_time: '07:30', gender: 'female', birth_location: '', target_date: '2026-11-17', lang: 'ko' });
  const daily2 = await callRoute('/api/daily', { birth_date: '1991-02-03', birth_time: '07:30', gender: 'female', birth_location: 'kr', target_date: '2026-11-17', lang: 'ko' });
  assert.equal(daily1.status, 200);
  assert.deepEqual(daily1.data, daily2.data);
  assert.notEqual(daily1.data.daily.lucky.number, '999');

  const tarotCards = [{ id: 0, reversed: false }, { id: 1, reversed: true }, { id: 2, reversed: false }];
  const tarot1 = await callRoute('/api/tarot', { cards: tarotCards, question: '올해  연애운 어때요?', lang: 'ko' });
  const tarot2 = await callRoute('/api/tarot', { cards: tarotCards, question: '  올해 연애운 어때요? ', lang: 'ko' });
  assert.equal(tarot1.status, 200);
  assert.equal(tarot1.headers.get('X-Karma-Cache'), 'MISS');
  assert.equal(tarot2.headers.get('X-Karma-Cache'), 'HIT');
  assert.deepEqual(tarot1.data, tarot2.data);

  assert.equal(textCalls, 5);
});

function makeJpegWithSizeBase64(width, height, seedByte = 0x11) {
  const bytes = Uint8Array.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
    0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08, (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
    seedByte, 0xff, 0xd9,
  ]);
  return Buffer.from(bytes).toString('base64');
}

test('photo 3-tier cache matches Tier 2 source hash and Tier 3 256-bit dHash (<= 8 bits) across re-encoded bytes, and stores partial displayable results', async () => {
  const mock = createStatefulMockEnv();
  let visionCalls = 0;
  let textCalls = 0;

  // Include non-hex personal color string (passes displayable cache check despite strict warning)
  const faceWithNonFatalHex = makeFaceAiFixture(Array.from({ length: 6 }, () => ({ structure: 4, symmetry: 4, condition: 4, visibility: 3 })), {
    personal_color: {
      season: 'autumn',
      undertone: 'warm',
      observation: '차분한 중간 명도입니다.',
      limitation: '자연광 비교를 권장합니다.',
      colors: [{ name: '따뜻한 카멜', hex: '따뜻한 카멜' }, { name: '올리브 그린', hex: '#6B8E23' }, { name: '코랄 베이지', hex: '#D98A6C' }],
      styling_tip: '카멜 계열을 비교해 보세요.',
    },
  });
  // Include 7 daeun items (would fail strict length-8 check) + stray key inside lucky
  const sajuPartialDaeun = {
    pillar_reading: { year: '초년 흐름', month: '청년 흐름', day: '일간 중심', hour: '말년 흐름' },
    personality: '원국 성향 설명입니다.',
    strengths: ['강점 1', '강점 2', '강점 3'],
    cautions: ['주의 1', '주의 2', '주의 3'],
    love_style: '관계 설명입니다.',
    career: '업무 설명입니다.',
    daeun_reading: Array.from({ length: 7 }, (_, i) => `${i + 1}번째 대운 설명`),
    advice: '행동 조언입니다.',
  };
  const dailyWithStrayKey = {
    overall: '오늘 총운입니다.',
    love: '연애 흐름입니다.',
    money: '재물 흐름입니다.',
    career: '업무 흐름입니다.',
    study: '학습 흐름입니다.',
    social: '대인 흐름입니다.',
    health: '건강 흐름입니다.',
    lucky: { ', ': '검정', '::x': '무작위', color: '무작위', number: '999' },
    advice: '실천 행동입니다.',
  };

  const env = {
    ...mock.env,
    AI: {
      async analyze() {
        visionCalls += 1;
        return { text: JSON.stringify(faceWithNonFatalHex), model: 'google/gemini-3.5-flash-lite', provider: 'test' };
      },
      async complete(input) {
        textCalls += 1;
        const sys = String(input?.messages?.[0]?.content || '');
        const payload = sys.includes('일진 해설가') ? dailyWithStrayKey : sajuPartialDaeun;
        return { text: JSON.stringify(payload), model: 'google/gemma-4-31b-it', provider: 'test' };
      },
    },
  };

  const waitUntilPromises = [];
  const ctx = { waitUntil: p => waitUntilPromises.push(p) };
  const callRoute = async (pathname, body) => {
    const req = new Request(`https://karma.archerlab.dev${pathname}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '9.9.9.9' },
      body: JSON.stringify(body),
    });
    const res = await worker.handler.fetch(req, env, ctx);
    await Promise.all(waitUntilPromises.splice(0));
    return { status: res.status, headers: res.headers, data: await res.json() };
  };

  const dims = worker.extractPhotoDimensions(Buffer.from(makeJpegWithSizeBase64(1536, 2048, 0x01), 'base64'), 'image/jpeg');
  assert.deepEqual({ ...dims }, { width: 1536, height: 2048 });
  assert.equal(worker.hammingDistanceHex256('a'.repeat(64), 'a'.repeat(63) + 'b'), 1);

  const sourceShaA = '1'.repeat(64);
  const dhashBase = '0'.repeat(64);
  const dhashNear = '0'.repeat(62) + 'ff'; // 8 bits away
  const dhashFar = 'f'.repeat(64); // 256 bits away

  const upload1 = await callRoute('/api/face-reading', {
    image: makeJpegWithSizeBase64(1536, 2048, 0x01),
    mimeType: 'image/jpeg',
    gender: 'female',
    age: '20s',
    lang: 'ko',
    image_hash: sourceShaA,
    image_dhash: `19:${dhashBase}`,
  });
  assert.equal(upload1.status, 200);
  assert.equal(upload1.headers.get('X-Karma-Cache'), 'MISS');

  // Different canvas compressed bytes, same original file SHA-256 -> Tier 2 hit
  const upload2 = await callRoute('/api/face-reading', {
    image: makeJpegWithSizeBase64(1536, 2048, 0x02),
    mimeType: 'image/jpeg',
    gender: '여성',
    age: '20대',
    lang: 'ko',
    image_hash: sourceShaA,
    image_dhash: `19:${dhashBase}`,
  });
  assert.equal(upload2.status, 200);
  assert.equal(upload2.headers.get('X-Karma-Cache'), 'HIT');
  assert.deepEqual(upload1.data, upload2.data);

  // Different compressed bytes & different file hash, but near-identical dHash (8 bits <= 8) & same aspect/options -> Tier 3 hit
  const upload3 = await callRoute('/api/face-reading', {
    image: makeJpegWithSizeBase64(1536, 2048, 0x03),
    mimeType: 'image/jpeg',
    gender: 'female',
    age: '20s',
    lang: 'ko',
    image_hash: '2'.repeat(64),
    image_dhash: `19:${dhashNear}`,
  });
  assert.equal(upload3.status, 200);
  assert.equal(upload3.headers.get('X-Karma-Cache'), 'HIT');
  assert.deepEqual(upload1.data, upload3.data);
  assert.equal(visionCalls, 1);
  assert.equal(mock.r2Puts.length, 3);

  // Genuinely different photo (256 bits Hamming distance) misses cache
  const uploadDiff = await callRoute('/api/face-reading', {
    image: makeJpegWithSizeBase64(1536, 2048, 0x04),
    mimeType: 'image/jpeg',
    gender: 'female',
    age: '20s',
    lang: 'ko',
    image_hash: '3'.repeat(64),
    image_dhash: `19:${dhashFar}`,
  });
  assert.equal(uploadDiff.status, 200);
  assert.equal(uploadDiff.headers.get('X-Karma-Cache'), 'MISS');
  assert.equal(visionCalls, 2);

  // Canonical birth_date / birth_time helpers and equivalent request normalization + clean lucky keys
  assert.equal(worker.normalizeKarmaBirthDateKey('1991-2-3'), '1991-02-03');
  assert.equal(worker.normalizeKarmaBirthTimeKey('7:30'), '07:30');
  const daily1 = await callRoute('/api/daily', {
    birth_date: '1991-02-03',
    birth_time: '07:30',
    gender: 'female',
    birth_location: '',
    yajasi: false,
    target_date: '2026-11-17',
    lang: 'ko',
  });
  const daily2 = await callRoute('/api/daily', {
    birth_date: '1991-02-03',
    birth_time: '07:30',
    gender: 'FEMALE',
    birth_location: 'utc+9',
    target_date: '2026-11-17',
    lang: 'ko',
  });
  assert.equal(daily1.status, 200);
  assert.equal(daily1.headers.get('X-Karma-Cache'), 'MISS');
  assert.equal(daily2.headers.get('X-Karma-Cache'), 'HIT');
  assert.deepEqual(daily1.data, daily2.data);
  assert.deepEqual(Object.keys(daily1.data.daily.lucky).sort(), ['color', 'number']);

  // Partial displayable saju response (7 daeun items) is cached via isCacheableKarmaResult
  const saju1 = await callRoute('/api/saju', { birth_date: '1991-02-03', birth_time: '07:30', gender: 'female', yajasi: false, birth_location: '', lang: 'ko' });
  const saju2 = await callRoute('/api/saju', { birth_date: '1991-02-03', birth_time: '07:30', gender: 'FEMALE', birth_location: 'kr', lang: 'ko' });
  assert.equal(saju1.status, 200);
  assert.equal(saju1.headers.get('X-Karma-Cache'), 'MISS');
  assert.equal(saju2.headers.get('X-Karma-Cache'), 'HIT');
  assert.deepEqual(saju1.data, saju2.data);
  assert.equal(textCalls, 2);
});
