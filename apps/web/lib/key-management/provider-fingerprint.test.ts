import assert from "node:assert/strict";
import test from "node:test";
import {
  awsKmsProviderFingerprint,
  azureKeyVaultProviderFingerprint,
  gcpKmsProviderFingerprint,
  localProviderFingerprint,
  transitProviderFingerprint,
} from "./provider-fingerprint";

test("provider fingerprint helper는 provider별 canonical identity 전체를 묶는다", () => {
  const aws = awsKmsProviderFingerprint("arn:key", "ap-northeast-2");
  assert.equal(aws, awsKmsProviderFingerprint("arn:key", "ap-northeast-2"));
  assert.notEqual(
    aws,
    awsKmsProviderFingerprint(
      "arn:key",
      "ap-northeast-2",
      "https://kms.example.com/",
    ),
  );

  assert.notEqual(
    gcpKmsProviderFingerprint("projects/p/keys/k"),
    gcpKmsProviderFingerprint(
      "projects/p/keys/k",
      "privatekms.googleapis.com",
    ),
  );
  assert.notEqual(
    azureKeyVaultProviderFingerprint("https://vault/keys/key/version-1"),
    azureKeyVaultProviderFingerprint("https://vault/keys/key/version-2"),
  );
  assert.notEqual(
    transitProviderFingerprint(
      "vault-transit",
      "https://vault.example.com/",
      "transit",
      "history",
      "team-a",
    ),
    transitProviderFingerprint(
      "vault-transit",
      "https://vault.example.com/",
      "transit",
      "history",
      "team-b",
    ),
  );
  assert.notEqual(
    localProviderFingerprint(Buffer.alloc(32, 1)),
    localProviderFingerprint(Buffer.alloc(32, 2)),
  );
});
