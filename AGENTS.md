# AGENTS.md — AI 에이전트용 설치 런북

AI 에이전트(Claude Code·Codex 등)가 toard 를 사람 개입 없이 설치·검증할 수 있도록 쓴 런북이다.
모든 단계는 비대화형 명령이고, 각 단계에 성공 기준이 있다. 사람이 읽는 문서는 [README.md](README.md).

## 0) 전제조건 확인

```bash
docker compose version   # Docker Compose v2.20+ 필요
curl --version           # 검증 단계에서 사용
```

## 1) 설치 (비대화형)

`/setup` 브라우저 단계를 건너뛰도록 관리자를 env 로 선생성한다(headless):

```bash
AUTH_SECRET=$(openssl rand -base64 33) \
BOOTSTRAP_ADMIN_EMAIL=<관리자 이메일> \
BOOTSTRAP_ADMIN_PASSWORD=<초기 비밀번호> \
docker compose up -d
```

- GHCR 프리빌트 이미지(amd64·arm64)를 pull 한다 — 빌드 없음. 버전 고정은 `TOARD_TAG=v…`.
- `AUTH_SECRET` 미설정이면 compose 가 파싱 단계에서 즉시 에러 — 메시지의 안내를 따른다.
- 관리자 이메일·비밀번호를 사용자가 지정하지 않았다면 **반드시 물어보고 진행한다**(임의 생성 금지).

## 2) 검증 — 성공 기준

```bash
curl -fsS http://localhost:3000/api/health   # 200 → 앱 프로세스 정상
curl -fsS http://localhost:3000/api/ready    # 200 → DB 연결 정상
docker compose ps -a                         # app·postgres = running, migrate = exited(0) 이 정상
```

마지막으로 `http://localhost:3000/login` 에서 위 관리자 계정으로 로그인되면 설치 완료다.

## 3) 수집 연결 (선택)

사용량 수집은 각 개발자 머신에서 셀프 온보딩한다(로그인 → 설정 → 설치 · 토큰 탭 → 한 줄 설치).
서버만 세우는 작업이라면 이 단계는 사람에게 안내만 하고 종료한다. 상세: README [팀에 배포하기](README.md#-팀에-배포하기).

## 4) 실패 모드

| 증상 | 원인 | 조치 |
|---|---|---|
| `required variable AUTH_SECRET` 에러 | 시크릿 미전달 | `openssl rand -base64 33` 로 생성해 전달 |
| 포트 3000 바인딩 실패 | 다른 프로세스 점유 | `PORT=3100 docker compose up -d` |
| `/api/ready` 만 실패 | DB 미준비·연결 실패 | `docker compose logs postgres migrate` 확인 |
| 관리자 로그인 실패 | `BOOTSTRAP_*` 없이 기동됨 | env 와 함께 `docker compose --profile seed run --rm seed` |
| 이전 설치 데이터 잔존 | 기존 볼륨 재사용 | 사용자 확인 후에만 `docker compose down -v`(데이터 삭제) |

## 금지 사항

- `docker compose down -v`(볼륨 삭제)는 사용자 확인 없이 실행하지 않는다.
- 비밀값(`AUTH_SECRET`·비밀번호·토큰)을 로그·채팅에 그대로 출력하지 않는다.
- 프로덕션 지향 설치라면 `CRON_SECRET` 미설정 상태로 마무리하지 않는다 — README [스케줄러](README.md#-스케줄러-cron) 참조.
