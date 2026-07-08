# 최초 팀 선택 온보딩 설계

## 배경

toard는 단일 인스턴스 안에서 사용자를 팀에 배정해 팀별 사용량을 보여준다. 현재 사용자 소속은 `users.team_id`의 현재값으로 관리되고, 수집 이벤트는 수집 시점의 팀을 `usage_events.team_id`에 스냅샷으로 저장한다. 따라서 사용자가 팀 없이 설치를 시작하면 이후 수집분이 미배정 이벤트로 남을 수 있다.

현재 일반 회원가입, 초대 수락, OAuth 최초 로그인은 모두 팀 없이 사용자 row를 만들 수 있다. 팀 화면은 이미 미배정 사용자를 별도 상태로 처리하지만, 최초 진입 시점에 팀을 고르게 하지는 않는다.

## 목표

- 일반 회원가입과 OAuth 최초 로그인 사용자는 최초 한 번 직접 팀을 선택할 수 있다.
- 초대 링크로 들어온 사용자는 관리자가 초대 생성 시 지정한 팀으로 배정될 수 있다.
- 팀이 존재하는데도 신규 사용자가 미배정 상태로 설치를 시작하는 일을 줄인다.
- 기존 관리자의 팀 생성/멤버 팀 변경 권한은 유지한다.

## 범위 제외

- 조직별 완전 분리 멀티테넌시.
- 과거 수집 이벤트의 팀 재귀속.
- 일반 사용자의 팀 생성.
- 팀 이동 이력 기반 집계 전환.

## 사용자 흐름

### 일반 회원가입

1. 사용자가 이메일/비밀번호로 가입한다.
2. 계정 생성 후 로그인한다.
3. 팀이 1개 이상 있고 사용자의 `team_id`와 `team_onboarding_completed_at`이 비어 있으면 `/onboarding/team`으로 이동한다.
4. 사용자가 팀을 선택하면 `users.team_id`를 저장한다.
5. 저장 후 설치 화면(`/settings?tab=install`)로 이동한다.

### OAuth 최초 로그인

1. 사용자가 OAuth provider로 로그인한다.
2. Auth.js adapter가 신규 사용자와 account row를 생성한다.
3. 로그인 후 팀이 1개 이상 있고 사용자의 `team_id`와 `team_onboarding_completed_at`이 비어 있으면 `/onboarding/team`으로 이동한다.
4. 팀 선택 후 기본 대시보드 또는 설치 화면으로 이동한다.

### 초대 수락

1. 관리자가 초대 생성 시 역할과 팀을 선택한다.
2. `invites` row에 `team_id`를 함께 저장한다.
3. 초대 수락 시 사용자 row를 만들면서 `role`과 `team_id`를 함께 저장한다.
4. 초대에 팀이 지정되어 있으면 초대 수락자는 팀 선택 온보딩을 거치지 않는다.

## 화면과 컴포넌트

- `/onboarding/team`
  - 로그인 사용자 전용 서버 페이지.
  - 팀 목록을 조회한다.
  - 팀이 없거나 사용자가 이미 팀에 속해 있거나 팀 선택을 완료했으면 다음 목적지로 redirect한다.
  - 팀 선택 폼은 기존 `Select`/`Button` UI를 사용한다.
- 팀 선택 서버 액션
  - 현재 로그인 사용자만 자신의 팀을 최초 저장할 수 있다.
  - 전달받은 `team_id`가 실제 `teams.id`인지 검증한다.
  - 이미 `team_id`가 있거나 `team_onboarding_completed_at`이 있는 사용자는 덮어쓰지 않는다. 이후 변경은 기존 관리자 멤버 관리 화면에서 한다.
- 초대 생성 폼
  - 관리자 초대 탭에 팀 선택 필드를 추가한다.
  - 팀 선택은 초대 생성 시 필수로 둔다.
  - 팀이 아직 없으면 초대 생성 전에 팀을 먼저 만들도록 안내한다.

## 리다이렉트 정책

- 대시보드 레이아웃에서 로그인 사용자의 `team_id`를 확인한다.
- `role = 'admin'` 사용자는 강제 팀 선택 대상에서 제외한다. 초기 setup admin은 먼저 팀을 만들어야 하기 때문이다.
- `role = 'member'`, `team_id IS NULL`, `team_onboarding_completed_at IS NULL`, 팀 수가 1개 이상이면 `/onboarding/team`으로 보낸다.
- `/onboarding/team`, `/setup`, `/login`, `/signup`, `/invite/*`는 이 가드에서 제외한다.
- `AUTH_MODE=open`의 비로그인 대시보드 폴백은 팀 선택 가드를 적용하지 않는다.

## 데이터 변경

새 마이그레이션을 추가한다.

```sql
ALTER TABLE users ADD COLUMN team_onboarding_completed_at TIMESTAMPTZ;
ALTER TABLE invites ADD COLUMN team_id UUID REFERENCES teams(id) ON DELETE SET NULL;
```

기존 사용자 중 이미 팀이 있거나 admin인 사용자는 마이그레이션에서 `team_onboarding_completed_at = now()`로 채운다. 기존 미배정 member는 null로 남겨 다음 로그인 때 팀 선택을 유도한다.

기존 pending invite는 `team_id = NULL`로 남을 수 있다. 새 UI에서는 팀 선택을 필수로 하지만, 서버 수락 로직은 기존 초대 호환을 위해 null을 허용한다. 기존 초대가 수락되어 사용자가 미배정으로 생성되면 일반 온보딩 가드가 팀 선택을 유도한다.

## 오류 처리

- 팀이 삭제되었거나 존재하지 않는 `team_id`로 제출되면 폼 오류를 보여준다.
- 이미 팀이 있는 사용자가 직접 선택 액션을 호출하면 기존 팀을 유지하고 다음 목적지로 이동한다.
- 이미 팀 선택을 완료한 사용자가 직접 선택 액션을 호출하면 기존 상태를 유지하고 다음 목적지로 이동한다. 관리자가 이후 팀을 해제한 경우에도 다시 직접 선택시키지 않는다.
- 초대 생성 시 팀이 없으면 초대 폼에서 생성 불가 상태를 보여준다.
- 초대 생성 후 지정 팀이 삭제되면 `invites.team_id`는 null이 된다. 이 초대가 수락되어 사용자가 미배정으로 생성되면 일반 온보딩 가드가 팀 선택을 유도한다.

## 테스트 기준

- 일반 회원가입 후 팀이 있으면 `/onboarding/team`으로 이동하고, 선택 후 `users.team_id`가 저장된다.
- 팀 선택 완료 시 `users.team_onboarding_completed_at`이 저장된다.
- OAuth 신규 로그인 후 팀이 있으면 `/onboarding/team`으로 이동한다.
- 이미 `team_id`가 있는 사용자는 온보딩 페이지로 직접 접근해도 다음 화면으로 이동한다.
- 관리자가 팀을 해제한 기존 사용자는 `team_onboarding_completed_at`이 있으면 다시 강제 선택되지 않는다.
- 팀이 없는 설치 초기 상태에서는 setup admin과 일반 흐름이 막히지 않는다.
- 초대 생성 시 팀이 저장되고, 초대 수락으로 생성된 사용자는 지정 팀을 가진다.
- 지정 팀이 삭제된 기존 pending invite는 수락 가능하지만, 생성된 member는 팀 선택 온보딩 대상으로 남는다.
- 기존 관리자 멤버 화면의 팀 변경 기능은 계속 동작한다.
