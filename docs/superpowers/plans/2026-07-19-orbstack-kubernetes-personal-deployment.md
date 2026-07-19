# OrbStack Kubernetes Personal Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a tested Kustomize path for a long-running personal toard deployment on OrbStack Kubernetes, plus a separately managed `macmini-k8s` Cloudflare Tunnel workload.

**Architecture:** Refactor the existing raw manifests into a reusable secret-free `k8s/base`, keep the current top-level raw deployment compatible, and add explicit OrbStack overlays for toard and cloudflared. Secrets are generated or fetched into temporary `0600` files and piped to Kubernetes without committing or printing their values.

**Tech Stack:** Kubernetes 1.33 manifest APIs, kubectl Kustomize, Bash, GitHub Actions, PostgreSQL 16, cloudflared 2026.7.2

## Global Constraints

- GitHub release tag is `v0.15.36`; GHCR app and migrator image tags are `0.15.36` without the `v` prefix.
- toard uses namespace `toard-personal`; cloudflared uses namespace `cloudflare-tunnel`.
- `toard-app` remains a ClusterIP Service and no Ingress, NodePort, or LoadBalancer is created by the personal overlay.
- App replicas stay at 2 with `maxUnavailable: 0` and `maxSurge: 1`; PostgreSQL keeps a 10Gi PVC.
- The public URL is `https://toard.devy1540.com`.
- The shared tunnel is named `macmini-k8s`, uses two cloudflared replicas, and routes to `http://toard-app.toard-personal.svc.cluster.local:80` through remotely managed configuration.
- No secret, token, administrator credential, or generated secret manifest may be committed or printed.
- Namespace and PVC deletion are never part of automated failure cleanup.

---

## File Structure

- `k8s/base/`: reusable application ConfigMap, Deployment, PostgreSQL, Service, and Kustomization.
- `k8s/kustomization.yaml`: backward-compatible raw composition with local Secret and example Ingress.
- `k8s/overlays/orbstack-personal/`: `toard-personal` namespace, URL, replicas, and pinned images.
- `k8s/overlays/orbstack-cloudflare/`: `cloudflare-tunnel` namespace and pinned two-replica cloudflared Deployment.
- `scripts/test-k8s-manifests.sh`: render-time regression contracts.
- `scripts/k8s-create-toard-secret.sh`: safe `toard-secrets` generation and apply.
- `scripts/k8s-create-tunnel-secret.sh`: safe `macmini-k8s` token fetch and apply.
- `.github/workflows/ci.yml`: PR-time manifest validation.
- `docs/DEPLOY.md`: installation, setup, tunnel, verification, and update runbook.

### Task 1: Add a failing app Kustomize contract test

**Files:**
- Create: `scripts/test-k8s-manifests.sh`

**Interfaces:**
- Consumes: `kubectl kustomize <directory>`.
- Produces: `scripts/test-k8s-manifests.sh app|cloudflare|all`, returning zero only when the rendered contract is satisfied.

- [ ] **Step 1: Create the app manifest test before the overlay exists**

The `app` mode renders `k8s/base` and `k8s/overlays/orbstack-personal`; rejects Secret and Ingress objects; and asserts `toard-personal`, `TOARD_PUBLIC_URL`, replicas 2, rollout policy, ClusterIP, 10Gi, and both GHCR `0.15.36` images. For backward compatibility it creates `k8s/secret.yaml` from `secret.example.yaml` only when absent, renders top-level `k8s/`, and removes only the file it created through `trap`.

- [ ] **Step 2: Verify the test fails for the missing base**

```bash
./scripts/test-k8s-manifests.sh app
```

Expected: non-zero because `k8s/base` does not exist.

- [ ] **Step 3: Keep the failing test uncommitted for the green implementation**

Do not commit a deliberately failing branch state. Task 2 commits the test together with the implementation that satisfies it.

### Task 2: Refactor the common base and add the personal overlay

**Files:**
- Create: `k8s/base/kustomization.yaml`
- Move: `k8s/configmap.yaml` to `k8s/base/configmap.yaml`
- Move: `k8s/deployment.yaml` to `k8s/base/deployment.yaml`
- Move: `k8s/postgres.yaml` to `k8s/base/postgres.yaml`
- Move: `k8s/service.yaml` to `k8s/base/service.yaml`
- Modify: `k8s/kustomization.yaml`
- Create: `k8s/overlays/orbstack-personal/kustomization.yaml`
- Create: `k8s/overlays/orbstack-personal/namespace.yaml`
- Create: `scripts/k8s-create-toard-secret.sh`

**Interfaces:**
- Consumes: existing names `toard-config`, `toard-secrets`, `postgres`, and `toard-app`.
- Produces: a secret-free base and personal overlay pinned to `ghcr.io/devy1540/toard{,-migrate}:0.15.36`.

- [ ] **Step 1: Move common resources and define the base**

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - configmap.yaml
  - postgres.yaml
  - deployment.yaml
  - service.yaml
```

- [ ] **Step 2: Preserve the top-level raw deployment**

Change `k8s/kustomization.yaml` to compose `base`, `namespace.yaml`, `secret.yaml`, and `ingress.yaml`; retain `namespace: toard`; and retain existing image transformers.

- [ ] **Step 3: Add the personal overlay**

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: toard-personal
resources:
  - ../../base
  - namespace.yaml
replicas:
  - name: toard-app
    count: 2
images:
  - name: toard
    newName: ghcr.io/devy1540/toard
    newTag: 0.15.36
  - name: toard-migrate
    newName: ghcr.io/devy1540/toard-migrate
    newTag: 0.15.36
patches:
  - target:
      kind: ConfigMap
      name: toard-config
    patch: |-
      - op: add
        path: /data/TOARD_PUBLIC_URL
        value: https://toard.devy1540.com
```

`namespace.yaml` defines only a v1 Namespace named `toard-personal`.

- [ ] **Step 4: Add the toard Secret helper**

Require `kubectl` and `openssl`; use `mktemp`, `chmod 600`, and `trap`; generate a hex PostgreSQL password plus `AUTH_SECRET` and `CRON_SECRET`; write `AUTH_SECRET`, `POSTGRES_PASSWORD`, `DATABASE_URL`, and `CRON_SECRET` to the temporary env file; then pipe a client dry-run `toard-secrets` manifest into `kubectl apply -f -`. Print only resource status, never values.

- [ ] **Step 5: Verify the app contract and shell syntax**

```bash
./scripts/test-k8s-manifests.sh app
bash -n scripts/k8s-create-toard-secret.sh
```

Expected: both exit 0.

- [ ] **Step 6: Commit the personal overlay**

```bash
git add k8s scripts/test-k8s-manifests.sh scripts/k8s-create-toard-secret.sh
git commit -m "feat: add OrbStack personal Kustomize overlay"
```

### Task 3: Add the Cloudflare tunnel overlay with a red-green contract

**Files:**
- Modify: `scripts/test-k8s-manifests.sh`
- Create: `k8s/overlays/orbstack-cloudflare/kustomization.yaml`
- Create: `k8s/overlays/orbstack-cloudflare/namespace.yaml`
- Create: `k8s/overlays/orbstack-cloudflare/deployment.yaml`
- Create: `scripts/k8s-create-tunnel-secret.sh`

**Interfaces:**
- Consumes: Secret `cloudflare-tunnel/tunnel-token` key `token` and tunnel `macmini-k8s`.
- Produces: two cloudflared 2026.7.2 replicas with `/ready` liveness checking on port 2000.

- [ ] **Step 1: Extend the test before creating the overlay**

The `cloudflare` mode asserts namespace `cloudflare-tunnel`, Deployment `cloudflared`, replicas 2, image `cloudflare/cloudflared:2026.7.2`, command `tunnel --no-autoupdate --loglevel info --metrics 0.0.0.0:2000 run`, Secret reference `tunnel-token/token`, `/ready`, and absence of a rendered Secret.

- [ ] **Step 2: Verify the expected missing-overlay failure**

```bash
./scripts/test-k8s-manifests.sh cloudflare
```

Expected: non-zero because `k8s/overlays/orbstack-cloudflare` does not exist.

- [ ] **Step 3: Add the tunnel Kustomization and Deployment**

Follow the current Cloudflare Kubernetes guide: two fixed replicas; `TUNNEL_TOKEN` from `tunnel-token/token`; command `cloudflared tunnel --no-autoupdate --loglevel info --metrics 0.0.0.0:2000 run`; `/ready` liveness probe; and image `cloudflare/cloudflared:2026.7.2`. Do not include a Secret resource.

- [ ] **Step 4: Add the tunnel Secret helper**

Default to tunnel `macmini-k8s` and namespace `cloudflare-tunnel`; require `cloudflared` and `kubectl`; fetch the token into a `0600` temporary file; and pipe a client dry-run Secret manifest into `kubectl apply -f -`. Never echo the token.

- [ ] **Step 5: Verify the Cloudflare contract and syntax**

```bash
./scripts/test-k8s-manifests.sh cloudflare
bash -n scripts/k8s-create-tunnel-secret.sh
```

Expected: both exit 0.

- [ ] **Step 6: Commit the tunnel overlay**

```bash
git add k8s/overlays/orbstack-cloudflare scripts
git commit -m "feat: add shared Kubernetes tunnel overlay"
```

### Task 4: Document and continuously validate the deployment path

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `docs/DEPLOY.md`

**Interfaces:**
- Consumes: both overlays and Secret helpers.
- Produces: a reproducible operator runbook and PR-time manifest validation.

- [ ] **Step 1: Add CI manifest validation**

```yaml
      - uses: azure/setup-kubectl@v4
        with:
          version: v1.33.9
      - run: ./scripts/test-k8s-manifests.sh all
```

- [ ] **Step 2: Add the OrbStack runbook**

Document exact commands for context and StorageClass checks, applying `orbstack-personal`, generating `toard-secrets`, rollout checks, port-forward setup before exposure, creating or reusing `macmini-k8s`, generating `tunnel-token`, applying `orbstack-cloudflare`, configuring `toard.devy1540.com` to the internal Service, external health/ready checks, and future image updates. State that Kubernetes does not use the Compose updater and PVC or namespace deletion requires separate confirmation.

- [ ] **Step 3: Run focused verification**

```bash
./scripts/test-k8s-manifests.sh all
bash -n scripts/test-k8s-manifests.sh scripts/k8s-create-toard-secret.sh scripts/k8s-create-tunnel-secret.sh
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 4: Commit docs and CI**

```bash
git add .github/workflows/ci.yml docs/DEPLOY.md docs/superpowers/plans/2026-07-19-orbstack-kubernetes-personal-deployment.md
git commit -m "docs: add OrbStack Kubernetes deployment runbook"
```

### Task 5: Repository-wide verification and integration handoff

**Files:**
- Verify only.

**Interfaces:**
- Consumes: all prior tasks.
- Produces: evidence for review, merge, release, and live deployment.

- [ ] **Step 1: Run manifest and shell verification**

```bash
./scripts/test-k8s-manifests.sh all
bash -n scripts/test-k8s-manifests.sh scripts/k8s-create-toard-secret.sh scripts/k8s-create-tunnel-secret.sh
git diff --check origin/main...HEAD
```

- [ ] **Step 2: Run repository validation**

```bash
corepack pnpm typecheck
corepack pnpm test
```

Expected: all commands exit 0. Any unrelated failure is reported with its exact command and output.

- [ ] **Step 3: Review the final diff against the design**

Confirm no Secret manifest is tracked, no personal Ingress is rendered, both image tags are correct, namespaces are isolated, Cloudflare is separately removable, and `/setup` is exposed only through port-forward before the published route exists.

- [ ] **Step 4: Publish and release**

Push `codex/orbstack-k8s-personal-deploy`, open a PR, wait for CI and review, merge to main, then create `v0.15.36` from merged main. Live OrbStack and Cloudflare changes begin only after both release workflows and GHCR artifacts are verified.
