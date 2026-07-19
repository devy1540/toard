# 사용자 히스토리 보안 관리형 KMS 화면 설계

## 목표

사용자 설정의 `히스토리 보안` 카드가 현재 저장 방식인 서버 관리형 암호화를 정확히 설명해야 한다. 기존 E2EE의 Recovery Kit, 콘텐츠 키, 승인 기기는 실제 legacy E2EE 데이터나 계정이 남아 있는 사용자에게만 보조 정보로 보여준다.

## 문제

현재 카드는 인증 사용자인지만 확인하고 항상 렌더링된다. 데이터도 `content_accounts`와 `content_devices`만 조회하고 문구도 E2EE 전용이라, 서버가 관리형 KMS를 사용하더라도 사용자에게 `E2EE 꺼짐`으로 보인다. 관리형 KMS 운영 상태는 관리자 시스템 화면에만 있어 일반 사용자 상태와 연결되지 않는다.

## 검토한 접근

### 1. 기존 카드의 E2EE 문구만 관리형 암호화로 교체

변경은 작지만 `content_accounts` 기반 상태를 계속 사용하므로 표시값이 실제 관리형 키와 어긋난다. 채택하지 않는다.

### 2. 사용자 카드 제거, 관리자 화면에만 KMS 상태 유지

잘못된 정보는 사라지지만 사용자는 자신의 히스토리가 어떻게 보호되는지 확인할 수 없다. 채택하지 않는다.

### 3. 관리형 암호화를 기본으로 표시하고 legacy E2EE를 조건부 분리

사용자 상태는 `managed_content_keys`와 본인 기록에서 읽고, 공급자·키 참조·fingerprint·비용 같은 설치 전역 정보는 관리자 화면에만 둔다. legacy E2EE 정보는 실제 legacy 상태가 있을 때만 별도 영역에 표시한다. 이 방식을 채택한다.

## 사용자 화면

카드 제목은 `히스토리 보안`을 유지한다. 기본 설명은 다음 사실을 전달한다.

- 프롬프트와 응답은 서버가 저장 전에 암호화한다.
- DB와 백업에는 암호문으로 저장된다.
- 일반 관리자 화면과 다른 사용자는 본문을 열람할 수 없다.
- 앱 서버와 KMS 권한을 함께 가진 인프라 운영자는 기술적으로 복호화할 수 있다는 신뢰 경계를 숨기지 않는다.

기본 영역에는 두 항목만 표시한다.

1. `보호 방식`: `서버 관리형 암호화`
2. `내 히스토리 키`: 활성 키가 있으면 `v{keyVersion}`, 없으면 `첫 본문 저장 시 자동 생성`

상태 배지는 다음 규칙을 따른다.

- `보호됨`: 사용자의 active managed key가 존재한다.
- `준비됨`: 관리형 본문 수집은 설정됐지만 아직 사용자 키와 본문이 없다.
- `전환 중`: pending 또는 retiring managed key가 있거나 E2EE 마이그레이션이 진행 중이다.
- `확인 필요`: legacy 마이그레이션이 blocked 상태다.
- `사용 안 함`: 서버에 관리형 본문 수집 공급자가 설정되지 않았다.

관리형 상태와 legacy 상태가 함께 있으면 `확인 필요`(managed attention 또는 legacy blocked), `전환 중`(managed transitioning 또는 legacy migrating) 순으로 우선해 배지 문구와 색상을 같은 상태에서 계산한다. 관리형 기록이 있는데 active 키가 없는 비정상 상태도 `확인 필요`로 닫는다.

일반 사용자 화면에는 KMS 공급자명, key ref, provider fingerprint, credential source, 호출 비용을 표시하지 않는다. 이 정보는 기존 관리자 시스템 화면에 유지한다.

## 데이터 조회

새 사용자 단위 상태 조회 함수는 `withUserContext(userId, ...)` 안에서 한 사용자의 행만 읽는다.

- `managed_content_keys`: active, pending, retiring 상태와 key version
- `prompt_records`: `managed_v1`, `e2ee_v1`, `server_v1` 개수
- `content_e2ee_migrations`: pending, running, blocked, complete 상태
- `content_accounts`와 `content_devices`: legacy E2EE 보조 영역에 필요한 계정 및 승인 기기

관리형 공급자 활성 여부는 서버 환경의 `managedContentConfigured()`로 판단한다. 사용자 카드에서는 공급자 식별자를 읽거나 반환하지 않는다.

조회 결과는 UI가 SQL 행 구조에 의존하지 않도록 다음 개념 DTO로 정규화한다.

```ts
type UserHistorySecurityStatus = {
  managed: {
    configured: boolean;
    state: "disabled" | "ready" | "protected" | "transitioning" | "attention";
    activeKeyVersion: number | null;
    managedRecords: number;
  };
  legacy: null | {
    state: "pending" | "active" | "migrating" | "blocked" | "complete";
    hasE2eeContext: boolean;
    e2eeRecords: number;
    serverRecords: number;
    recoveryConfirmedAt: Date | null;
    devices: Array<{
      id: string;
      kind: "shim" | "browser";
      label: string;
      platform: string;
      lastUsedAt: Date | null;
    }>;
  };
};
```

`legacy`는 `pending`/`active` E2EE 계정, `e2ee_v1`/`server_v1` 기록, 미완료 마이그레이션 중 하나라도 존재할 때만 반환한다. 이 중 E2EE 계정·`e2ee_v1` 기록·미완료 E2EE 마이그레이션이 있을 때만 `hasE2eeContext=true`로 반환하고 기기를 조회한다. `server_v1` 기록만 남았으면 전환 건수는 표시하되 Recovery Kit와 승인 기기는 숨긴다. `migrated` 계정만 남았고 legacy 기록과 미완료 마이그레이션이 없으면 `null`로 축약한다.

## Legacy E2EE 영역

legacy 상태가 있을 때만 기본 관리형 암호화 영역 아래에 `기존 암호화 기록` 보조 영역을 표시한다. `server_v1`은 기존 서버 암호화 기록, `e2ee_v1`은 기존 기기 E2EE 기록으로 구분한다.

- 진행 중이면 남은 기록 수를 표시한다.
- blocked면 데이터가 삭제되지 않았고 기존 기기 키가 필요하다는 조치를 표시한다.
- Recovery Kit 확인 시각과 승인 기기 목록은 실제 E2EE 컨텍스트가 남은 경우에만 이 영역에 표시한다.
- 마이그레이션이 완료되고 남은 legacy 기록이 없으면 영역을 제거한다.

기기 폐기, 키 회전, Recovery Kit 재발급 안내도 legacy 영역 안으로 이동한다.

## 오류 처리와 보안

- 사용자 조회는 RLS 사용자 컨텍스트 안에서만 실행한다.
- 조회 오류 시 KMS 세부 오류나 provider 식별자를 사용자에게 노출하지 않는다.
- 설정 페이지 전체를 잘못된 `꺼짐` 상태로 렌더링하지 않고, 카드에 일반적인 `상태를 확인할 수 없습니다`를 표시한다.
- 평문 키, wrapped key, key ref, fingerprint, wrapper metadata는 DTO와 React props에 포함하지 않는다.
- 관리형 공급자가 없는데 managed 기록이 존재하는 비정상 상태는 `확인 필요`로 표시하고 신규 상태를 추측하지 않는다.

## 번역과 기존 온보딩 문구

한국어와 영어 메시지를 같은 구조로 변경한다. 컴퓨터 연결 화면의 본문 수집 설명도 `이 컴퓨터에서 암호화한 뒤 전송`이 아니라 `서버가 저장 전에 암호화`로 수정한다. Recovery Kit 단계 문구는 신규 온보딩에서 제거된 상태를 유지하고 legacy E2EE 보조 영역에서만 사용한다.

## 테스트

1. 관리형 공급자 설정 + 사용자 키 없음은 `준비됨`과 자동 생성 안내를 표시한다.
2. active managed key는 `보호됨`, `서버 관리형 암호화`, key version을 표시한다.
3. 일반 사용자 HTML과 DTO에는 provider, key ref, fingerprint, Recovery Kit가 기본적으로 나타나지 않는다.
4. 실제 legacy 상태가 있을 때만 Recovery Kit와 승인 기기 영역이 나타난다.
5. 완료된 legacy 마이그레이션과 0개 legacy 기록은 legacy 영역을 숨긴다.
6. blocked migration은 `확인 필요`와 데이터 보존 안내를 표시한다.
7. 관리형 공급자 미설정은 `사용 안 함`을 표시한다.
8. 한국어와 영어 메시지 키 구조가 일치한다.
9. 기존 관리자 KMS 패널의 공급자·상태·비용 표시는 유지된다.

## 완료 기준

- 일반 사용자 설정에서 KMS 기반 서버 관리형 암호화가 기본 보안 방식으로 표시된다.
- legacy E2EE가 없는 사용자는 E2EE, Recovery Kit, 승인 기기 문구를 보지 않는다.
- 실제 사용자 키·기록·마이그레이션 상태와 화면 배지가 일치한다.
- 사용자 화면은 KMS 공급자 운영 세부정보나 키 자료를 노출하지 않는다.
- 관련 웹 테스트, 타입 검사, 전체 보안 회귀 테스트가 통과한다.
