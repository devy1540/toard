{{/* 차트 기본 이름 */}}
{{- define "toard.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
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
