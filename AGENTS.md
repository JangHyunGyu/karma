# Repository Agent Rules

## Main-Only Git and Deployment (Permanent)
- 이 저장소에서는 브랜치를 새로 만들지 않는다.
- 모든 `git commit`, `git push`, 운영 배포는 반드시 `main` 브랜치에서만 수행한다.
- 현재 브랜치가 `main`이 아니면 커밋·푸시·배포를 중단하고 사용자에게 알린다. 기능 브랜치나 `agent/*` 브랜치에서 작업을 게시하지 않는다.
- 커밋 직전과 푸시 직전에 각각 `git branch --show-current`로 `main`인지 다시 확인한다.
- 운영 배포 직전에는 작업 트리가 깨끗하고 `HEAD`가 `origin/main`과 같은지 확인한다.
- 별도 브랜치나 Pull Request를 만들지 않고 `main`에 직접 커밋하고 푸시한다.

## Karma Analysis Image Persistence (Permanent)
- 유효한 관상·손금 사진은 AI 호출, 사용량 제한 응답, AI 서비스 연결 확인보다 먼저 전용 비공개 R2에 저장한다.
- AI 성공·거절·오류·429·503을 포함한 모든 분석 결과의 D1 기록에 저장된 사진의 `r2_key`를 남긴다.
- R2 저장이 실패하면 AI 분석을 진행하지 말고 저장 실패로 응답한다. 사진 없이 분석만 진행하는 경로를 만들지 않는다.
- Harem 백업 뷰어의 Karma D1 상세 화면에서 서명된 프록시로 해당 사진을 계속 표시한다.
- 사용자의 명시적 승인 없이 이 선저장·영구 연결 정책을 제거하거나 분석 후 저장으로 되돌리지 않는다.

## Image Asset Storage Optimization & Quality Gate (Permanent, 2026-11-20)
- Apply this rule across every project under `D:\workspace` (including `harem`, `cupid`, `chatbot`) whenever adding, regenerating, editing, or optimizing PNG/WebP image assets.
- **원본 해상도(`width x height`) 절대 축소 금지**: 사용자가 별도로 리사이즈를 명시하지 않는 한 원본 픽셀 해상도를 그대로 유지하고 포맷 압축으로만 용량을 줄인다.
- **불투명 이미지 알파 제거**: 실제 투명이 필요 없는 불투명 이미지(`alpha == 255` 전체)는 불필요한 알파 채널을 제거(`RGBA -> RGB`)해 저장한다.
- **투명 이미지 무손실 PNG 최소 바이트 선택**:
  - 투명 배경(RGBA) PNG는 저장 전 `alpha == 0` 픽셀의 RGB를 반드시 `(0, 0, 0)`으로 초기화한다.
  - Pillow(`format="PNG", optimize=True, compress_level=9`)와 `sharp`(`.png({ compressionLevel: 9, adaptiveFiltering: true, palette: false })` — `palette: false` 누락 시 `sharp@0.35.4`에서 자동 팔레트 양자화가 발생할 수 있으므로 반드시 명시)를 비교해 4채널 무손실(`max_abs_diff == 0`) 검증을 통과한 더 작은 바이트 버퍼를 채택한다.
- **정확 알파 WebP 서빙 인코딩 및 정량 화질 게이트**:
  - 최종 무손실 PNG로부터 `sharp.webp({ quality: q, alphaQuality: 100, effort: 6, smartSubsample: false })`로 인코딩하며, `q`를 `92 -> 95 -> 98` 순으로 상향해 아래 기준을 모두 충족하는 최소 `q`를 채택한다:
    1. PNG와 픽셀 해상도(`width x height`) 100% 일치.
    2. 알파 채널 최대 오차 `alphaMaxDiff == 0` (완전 무손실 알파).
    3. 어두운 배경(`#181824`) 및 흰 배경(`#FFFFFF`) 합성 비교 기준 모두 `SSIM >= 0.99`, `MAE <= 1.5`.
    4. PNG 대비 용량 절감 `>= 15%` 달성(기존 미수정 에셋 최적화 시 기존 WebP가 이미 기준을 통과하고 `<= 250KB`이며 추가 절감 폭이 미미하면 불필요한 교체를 생략할 수 있다).
  - 정량 기준을 1건이라도 통과하지 못한 파일은 R2 게시·커밋·배포하지 않는다.
