'use strict';

module.exports = function appearanceFixture(lang = 'en') {
  const text = lang === 'en' ? 'Soft contours and a clear eye line.' : '부드러운 얼굴선과 또렷한 눈매가 보여요.';
  return {
    appearance: {
      types: lang === 'en' ? ['Soft', 'Refined'] : ['부드러운', '세련된'],
      highlights: [
        { feature: lang === 'en' ? 'Eyes' : '눈매', description: text },
        { feature: lang === 'en' ? 'Jawline' : '얼굴선', description: text },
      ],
      harmony: text, first_impression: text,
      style: { hair: text, accessories: text, photo: text, makeup: text, grooming: text },
      adult_subject: true,
      sex_appeal: lang === 'en'
        ? 'The curved lower lip is a sensual feature. A relaxed smile makes its contour more visible.'
        : '둥근 아랫입술 곡선이 성적 매력 포인트예요. 입에 힘을 빼고 살짝 웃으면 그 선이 더 잘 드러나요.',
      cosmetic_consultation: [{ area: lang === 'en' ? 'Face proportions' : '얼굴 비율', observation: text, goal: text,
        options: [{ name: lang === 'en' ? 'Blepharoplasty' : '쌍꺼풀 수술', purpose: text, caution: text }],
        question: text, alternative: text }],
    },
    personal_color: {
      season: 'summer', undertone: 'cool', observation: text,
      limitation: lang === 'en' ? 'Lighting may alter the colors. Compare fabrics in daylight.' : '조명에 따라 색이 달라 보여요. 자연광에서 천을 대고 비교해 보세요.',
      styling_tip: text,
      colors: [
        { name: lang === 'en' ? 'Dusty rose' : '차분한 장미색', hex: '#C98F9E' },
        { name: lang === 'en' ? 'Blue gray' : '푸른 회색', hex: '#859BAA' },
        { name: lang === 'en' ? 'Lavender' : '연보라', hex: '#B8A7CA' },
      ],
    },
  };
};
