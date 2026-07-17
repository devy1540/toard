{{/* 차트 기본 이름 */}}
{{- define "toard.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* migration/seed 전용 non-KMS ServiceAccount 이름 */}}
{{- define "toard.migrationServiceAccountName" -}}
{{- if .Values.migrate.serviceAccount.create -}}
{{- default (printf "%s-migration" (include "toard.fullname" . | trunc 53 | trimSuffix "-")) .Values.migrate.serviceAccount.name -}}
{{- else -}}
{{- required "migrate.serviceAccount.create=false이면 name이 필요합니다" .Values.migrate.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/* migration/seed owner DB Secret. 빈 name은 기존 설치 호환 기본 Secret을 사용한다. */}}
{{- define "toard.migrationDatabaseSecretName" -}}
{{- default (include "toard.secretName" .) .Values.migrate.databaseSecret.name -}}
{{- end -}}

{{/* GitOps는 stable releaseId, Helm CLI는 revision을 completion hash 입력으로 사용한다. */}}
{{- define "toard.effectiveReleaseId" -}}
{{- if .Values.migrate.releaseId -}}
  {{- if or (gt (len .Values.migrate.releaseId) 128) (not (regexMatch "^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$" .Values.migrate.releaseId)) -}}
    {{- fail "migrate.releaseId must match ^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$" -}}
  {{- end -}}
  {{- .Values.migrate.releaseId -}}
{{- else -}}
  {{- printf "helm-revision:%d" .Release.Revision -}}
{{- end -}}
{{- end -}}

{{/* Job/seed 완료에 영향을 주는 비민감 입력을 canonical SHA-256 ID로 묶는다. */}}
{{- define "toard.releaseCompletionId" -}}
{{- $waitSpec := dict "mode" "external" -}}
{{- if .Values.postgres.enabled -}}
  {{- $waitSpec = dict
    "host" (include "toard.postgresHost" .)
    "image" .Values.postgres.image
    "mode" "bundled"
    "user" .Values.postgres.auth.user
  -}}
{{- end -}}
{{- $jobSpec := dict
  "affinity" .Values.affinity
  "backoffLimit" .Values.migrate.backoffLimit
  "imagePullSecrets" .Values.imagePullSecrets
  "nodeSelector" .Values.nodeSelector
  "podSecurityContext" .Values.podSecurityContext
  "resources" .Values.resources
  "serviceAccountName" (include "toard.migrationServiceAccountName" .)
  "tolerations" .Values.tolerations
  "ttlSecondsAfterFinished" .Values.migrate.ttlSecondsAfterFinished
-}}
{{- $completionSpec := dict
  "commandContractVersion" "migrate-seed-marker-v1"
  "completionContractVersion" 1
  "databaseSecret" (dict
    "key" .Values.migrate.databaseSecret.key
    "name" (include "toard.migrationDatabaseSecretName" .)
  )
  "jobSpec" $jobSpec
  "migrateImage" (dict
    "pullPolicy" .Values.image.migrate.pullPolicy
    "repository" .Values.image.migrate.repository
    "tag" .Values.image.migrate.tag
  )
  "release" (dict
    "effectiveId" (include "toard.effectiveReleaseId" .)
    "name" .Release.Name
    "namespace" .Release.Namespace
  )
  "schemaVersion" (include "toard.expectedSchemaVersion" . | int64)
  "waitSpec" $waitSpec
-}}
{{- $completionSpec | mustToJson | sha256sum -}}
{{- end -}}

{{/* immutable Job 이름에는 같은 completion ID의 80-bit prefix를 사용한다. */}}
{{- define "toard.migrationJobName" -}}
{{- $suffix := printf "-migrate-%s" (include "toard.releaseCompletionId" . | trunc 20) -}}
{{- $maxBaseLength := sub 63 (len $suffix) | int -}}
{{- printf "%s%s" (include "toard.fullname" . | trunc $maxBaseLength | trimSuffix "-") $suffix -}}
{{- end -}}

{{/* packages/core/src/deployment-release.ts와 Helm render test가 drift를 차단한다. */}}
{{- define "toard.expectedSchemaVersion" -}}1700000040{{- end -}}

{{- define "toard.deploymentId" -}}
{{- printf "%s/%s" .Release.Namespace .Release.Name -}}
{{- end -}}

{{/* app/content-admin에서 사용할 ServiceAccount 이름 */}}
{{- define "toard.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "toard.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/* 배포/암호화 values의 보안 경계를 fail-fast */}}
{{- define "toard.validateDeploymentValues" -}}
{{- if and .Values.migrate.enabled (eq (include "toard.serviceAccountName" .) (include "toard.migrationServiceAccountName" .)) -}}
  {{- fail "app/content-admin and migration/seed ServiceAccount names must be different" -}}
{{- end -}}
{{- $reservedLabels := list "app.kubernetes.io/name" "app.kubernetes.io/instance" "app.kubernetes.io/component" "app.kubernetes.io/managed-by" "helm.sh/chart" -}}
{{- range $key, $_ := .Values.serviceAccount.podLabels -}}
  {{- if has $key $reservedLabels -}}
    {{- fail (printf "serviceAccount.podLabels reserved label cannot be overridden: %s" $key) -}}
  {{- end -}}
{{- end -}}
{{- $provider := .Values.encryption.provider -}}
{{- $migrationProvider := default "" .Values.encryption.migration.provider -}}
{{- if and (empty $migrationProvider) (gt (len .Values.encryption.migration) 0) -}}
  {{- fail "encryption.migration.provider is required when migration settings are configured" -}}
{{- end -}}
{{- $identityConfigured := or (gt (len .Values.encryption.workloadIdentity.aws) 0) (gt (len .Values.encryption.workloadIdentity.gcp) 0) (gt (len .Values.encryption.workloadIdentity.azure) 0) -}}
{{- if and (empty $provider) (or (gt (len .Values.encryption.active) 0) (gt (len .Values.encryption.migration) 0) (gt (len .Values.encryption.secretMounts) 0) $identityConfigured (not (empty .Values.encryption.cost.per10000Usd)) (not (empty .Values.encryption.cost.monthlyKeyUsd))) -}}
  {{- fail "encryption.provider is required when encryption settings are configured" -}}
{{- end -}}
{{- $names := dict -}}
{{- $paths := dict -}}
{{- range .Values.encryption.secretMounts -}}
  {{- if hasKey $names .name -}}
    {{- fail (printf "encryption.secretMounts duplicate name: %s" .name) -}}
  {{- end -}}
  {{- $_ := set $names .name true -}}
  {{- if hasKey $paths .mountPath -}}
    {{- fail (printf "encryption.secretMounts duplicate mountPath: %s" .mountPath) -}}
  {{- end -}}
  {{- $_ := set $paths .mountPath true -}}
  {{- if or (not (hasPrefix "/" .mountPath)) (ne (clean .mountPath) .mountPath) (eq .mountPath "/") -}}
    {{- fail (printf "encryption.secretMounts mountPath must be a normalized absolute non-root path: %s" .mountPath) -}}
  {{- end -}}
  {{- $itemPaths := dict -}}
  {{- range .items -}}
    {{- if hasKey $itemPaths .path -}}
      {{- fail (printf "encryption.secretMounts duplicate item path: %s" .path) -}}
    {{- end -}}
    {{- $_ := set $itemPaths .path true -}}
  {{- end -}}
{{- end -}}
{{- end -}}

{{/* key-management/config.ts의 한 provider profile을 ConfigMap data로 변환 */}}
{{- define "toard.encryptionProfileData" -}}
{{- $slot := .slot -}}
{{- $provider := .provider -}}
{{- $profile := .profile -}}
{{- $prefix := ternary "TOARD_KEY_ACTIVE" "TOARD_KEY_MIGRATION" (eq $slot "active") -}}
{{ printf "%s_PROVIDER: %s" $prefix ($provider | quote) }}
{{- if eq $provider "local" }}
  {{- $settings := required (printf "encryption.%s.local is required" $slot) $profile.local }}
{{ printf "%s_LOCAL_KEK_FILE: %s" $prefix (required (printf "encryption.%s.local.kekFile is required" $slot) $settings.kekFile | quote) }}
{{- else if eq $provider "aws-kms" }}
  {{- $settings := required (printf "encryption.%s.aws is required" $slot) $profile.aws }}
{{ printf "%s_AWS_KEY_ARN: %s" $prefix (required (printf "encryption.%s.aws.keyArn is required" $slot) $settings.keyArn | quote) }}
{{ printf "%s_AWS_REGION: %s" $prefix (required (printf "encryption.%s.aws.region is required" $slot) $settings.region | quote) }}
  {{- with $settings.endpoint }}
{{ printf "%s_AWS_ENDPOINT: %s" $prefix (. | quote) }}
  {{- end }}
{{- else if eq $provider "gcp-kms" }}
  {{- $settings := required (printf "encryption.%s.gcp is required" $slot) $profile.gcp }}
{{ printf "%s_GCP_KEY_NAME: %s" $prefix (required (printf "encryption.%s.gcp.keyName is required" $slot) $settings.keyName | quote) }}
  {{- with $settings.apiEndpoint }}
{{ printf "%s_GCP_API_ENDPOINT: %s" $prefix (. | quote) }}
  {{- end }}
{{- else if eq $provider "azure-key-vault" }}
  {{- $settings := required (printf "encryption.%s.azure is required" $slot) $profile.azure }}
{{ printf "%s_AZURE_KEY_ID: %s" $prefix (required (printf "encryption.%s.azure.keyId is required" $slot) $settings.keyId | quote) }}
{{ printf "%s_AZURE_CREDENTIAL_MODE: %s" $prefix (required (printf "encryption.%s.azure.credentialMode is required" $slot) $settings.credentialMode | quote) }}
  {{- with $settings.managedIdentityClientId }}
{{ printf "%s_AZURE_MANAGED_IDENTITY_CLIENT_ID: %s" $prefix (. | quote) }}
  {{- end }}
{{- else if or (eq $provider "vault-transit") (eq $provider "openbao-transit") }}
  {{- $profileKey := ternary "vault" "openbao" (eq $provider "vault-transit") -}}
  {{- $settings := required (printf "encryption.%s.%s is required" $slot $profileKey) (index $profile $profileKey) }}
{{ printf "%s_TRANSIT_ADDRESS: %s" $prefix (required (printf "encryption.%s.%s.address is required" $slot $profileKey) $settings.address | quote) }}
{{ printf "%s_TRANSIT_MOUNT: %s" $prefix (required (printf "encryption.%s.%s.mount is required" $slot $profileKey) $settings.mount | quote) }}
{{ printf "%s_TRANSIT_KEY_NAME: %s" $prefix (required (printf "encryption.%s.%s.keyName is required" $slot $profileKey) $settings.keyName | quote) }}
{{ printf "%s_TRANSIT_AUTH_METHOD: %s" $prefix (required (printf "encryption.%s.%s.authMethod is required" $slot $profileKey) $settings.authMethod | quote) }}
  {{- range $key, $suffix := dict "namespace" "TRANSIT_NAMESPACE" "tokenFile" "TRANSIT_TOKEN_FILE" "kubernetesRole" "TRANSIT_KUBERNETES_ROLE" "kubernetesJwtFile" "TRANSIT_KUBERNETES_JWT_FILE" "approleRoleIdFile" "TRANSIT_APPROLE_ROLE_ID_FILE" "approleSecretIdFile" "TRANSIT_APPROLE_SECRET_ID_FILE" }}
    {{- with index $settings $key }}
{{ printf "%s_%s: %s" $prefix $suffix (. | quote) }}
    {{- end }}
  {{- end }}
{{- else }}
  {{- fail (printf "unsupported encryption provider: %s" $provider) -}}
{{- end -}}
{{- end -}}

{{/* fullname — 릴리스명이 차트명을 포함하면 축약(toard-toard → toard) */}}
{{- define "toard.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := include "toard.name" . -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/* 공통 라벨 */}}
{{- define "toard.labels" -}}
app.kubernetes.io/name: {{ include "toard.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end -}}

{{/* 셀렉터 라벨 */}}
{{- define "toard.selectorLabels" -}}
app.kubernetes.io/name: {{ include "toard.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/* Postgres 서비스명 */}}
{{- define "toard.postgresHost" -}}
{{- printf "%s-postgres" (include "toard.fullname" .) -}}
{{- end -}}

{{/* 사용할 Secret 이름 (existingSecret 우선) */}}
{{- define "toard.secretName" -}}
{{- if .Values.secrets.existingSecret -}}
{{- .Values.secrets.existingSecret -}}
{{- else -}}
{{- printf "%s-secrets" (include "toard.fullname" .) -}}
{{- end -}}
{{- end -}}

{{/* DATABASE_URL: 번들 PG 면 조합, 아니면 secrets.databaseUrl(required) */}}
{{- define "toard.databaseUrl" -}}
{{- if .Values.postgres.enabled -}}
{{- printf "postgres://%s:%s@%s:5432/%s" .Values.postgres.auth.user .Values.postgres.auth.password (include "toard.postgresHost" .) .Values.postgres.auth.database -}}
{{- else -}}
{{- required "postgres.enabled=false 이면 secrets.databaseUrl 이 필요합니다." .Values.secrets.databaseUrl -}}
{{- end -}}
{{- end -}}
