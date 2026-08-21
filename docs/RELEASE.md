# 릴리스

## 버전 정책

`0.0.1`은 toard의 첫 새 공개 기준선이다. `v`로 시작하는 기존 Git tag와 GitHub Release는 모두
지원이 종료된 레거시 계열이다. 새 공개 태그에는 `v`를 붙이지 않으며 레거시 릴리스는 공개 채널에 보존하지 않는다.

`1.0.0` 전까지 후속 공개 릴리스는 `0.0.2`, `0.0.3`처럼 `0.0.x` patch를 올린다.
기존 레거시 태그와 런타임 버전이 충돌하는 `0.1.0`~`0.15.55` 번호는 재사용하지 않는다. 런타임의 `0.0.0`은
태그가 주입되지 않은 개발 빌드 전용 표식이다.

하나의 공개 릴리스는 다음 산출물이 같은 버전이어야 완료다.

- Git tag와 GitHub Release: `0.0.1`
- GHCR app, migrator, updater, content-admin 이미지: `0.0.1`
- Rust shim 바이너리 출력: `toard-shim 0.0.1`
- workspace/Cargo/Helm/Kustomize의 저장소 버전 표기: `0.0.1`

`latest` GHCR 태그와 GitHub의 latest release는 공개 태그 릴리스만 가리킨다. `main` push는
`main`과 commit SHA 이미지 태그만 갱신한다.

## 발행 전 조건

1. 버전 정합성과 테스트를 통과해야 한다.

```bash
pnpm verify:release-version
pnpm test:release-version
pnpm typecheck
pnpm build
pnpm test
```

2. 변경을 `main`에 병합하고, 병합된 정확한 commit의 CI 성공을 확인한다.

## 발행과 검증

`main`의 검증된 commit에 annotated tag를 만들면 `shim-release`와 `docker-publish`가 실행된다.
태그 push는 외부 배포이므로 실행 전에 별도 승인을 받는다.

```bash
git tag -a 0.0.1 <verified-main-commit> -m "0.0.1"
git push origin 0.0.1
```

두 workflow가 성공한 뒤 다음을 확인한다.

```bash
gh release view 0.0.1 --json tagName,isDraft,isPrerelease,url,assets
docker buildx imagetools inspect ghcr.io/devy1540/toard:0.0.1
docker buildx imagetools inspect ghcr.io/devy1540/toard-migrate:0.0.1
docker buildx imagetools inspect ghcr.io/devy1540/toard-updater:0.0.1
docker buildx imagetools inspect ghcr.io/devy1540/toard-content-admin:0.0.1
```

마지막으로 새 설치와 이미 설치된 레거시 `0.15.55` 환경에서 각각 서버·shim 업데이트를 실행해 보고,
`/api/health`, `/api/ready`, `/api/v1/version`, `toard-shim version`을 확인한다.
