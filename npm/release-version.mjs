const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/** 기존 0.x 레거시는 v* 태그, 새 0.0.x와 1.x 이상은 무접두 태그를 사용한다. */
export function releaseTagFor(version) {
  if (version === "latest" || version.startsWith("v")) return version;
  const match = SEMVER.exec(version);
  if (!match) throw new Error(`invalid toard release version: ${version}`);
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major === 0 && minor > 0 ? `v${version}` : version;
}
