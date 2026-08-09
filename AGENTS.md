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
