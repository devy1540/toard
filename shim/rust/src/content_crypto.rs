use aes_gcm::{
    aead::{Aead, Payload},
    Aes256Gcm, Key, KeyInit, Nonce,
};
#[cfg(test)]
use hpke::OpModeR;
use hpke::{
    aead::AesGcm256, kdf::HkdfSha256, kem::DhP256HkdfSha256, Deserializable, Kem as KemTrait,
    OpModeS, Serializable,
};
use serde::Serialize;
use zeroize::Zeroizing;

const AES_KEY_LEN: usize = 32;
const AES_NONCE_LEN: usize = 12;
const AES_TAG_LEN: usize = 16;
const HPKE_INFO: &[u8] = b"toard/content-device/v1";
const HPKE_AAD: &[u8] = b"toard/content-key/v1";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContentMetadata {
    pub schema: String,
    pub content_owner_id: String,
    pub dedup_key: String,
    pub provider_key: String,
    pub turn_role: String,
    pub ts: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncryptedPromptRecord {
    pub wrapped_dek: Vec<u8>,
    pub dek_wrap_iv: [u8; AES_NONCE_LEN],
    pub dek_wrap_auth_tag: [u8; AES_TAG_LEN],
    pub iv: [u8; AES_NONCE_LEN],
    pub ciphertext: Vec<u8>,
    pub auth_tag: [u8; AES_TAG_LEN],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceKeypair {
    pub private_key: Zeroizing<Vec<u8>>,
    pub public_key: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceEnvelope {
    pub encapsulated_key: Vec<u8>,
    pub ciphertext: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContentCryptoError {
    InvalidMetadata,
    InvalidKey,
    #[cfg(test)]
    InvalidEnvelope,
    EncryptionFailed,
    #[cfg(test)]
    AuthenticationFailed,
}

impl std::fmt::Display for ContentCryptoError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let message = match self {
            Self::InvalidMetadata => "invalid E2EE metadata",
            Self::InvalidKey => "invalid content key",
            #[cfg(test)]
            Self::InvalidEnvelope => "invalid device envelope",
            Self::EncryptionFailed => "content encryption failed",
            #[cfg(test)]
            Self::AuthenticationFailed => "content authentication failed",
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for ContentCryptoError {}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CanonicalAad<'a> {
    schema: &'a str,
    content_owner_id: &'a str,
    dedup_key: &'a str,
    provider_key: &'a str,
    turn_role: &'a str,
    ts: &'a str,
}

pub fn canonical_aad(metadata: &ContentMetadata) -> Result<Vec<u8>, ContentCryptoError> {
    if metadata.schema != "e2ee_v1"
        || metadata.content_owner_id.is_empty()
        || metadata.dedup_key.is_empty()
        || metadata.provider_key.is_empty()
        || !matches!(
            metadata.turn_role.as_str(),
            "user" | "assistant" | "system" | "tool"
        )
        || metadata.ts.is_empty()
    {
        return Err(ContentCryptoError::InvalidMetadata);
    }

    serde_json::to_vec(&CanonicalAad {
        schema: &metadata.schema,
        content_owner_id: &metadata.content_owner_id,
        dedup_key: &metadata.dedup_key,
        provider_key: &metadata.provider_key,
        turn_role: &metadata.turn_role,
        ts: &metadata.ts,
    })
    .map_err(|_| ContentCryptoError::InvalidMetadata)
}

pub fn encrypt_record(
    uck: &[u8],
    metadata: &ContentMetadata,
    plaintext: &[u8],
) -> Result<EncryptedPromptRecord, ContentCryptoError> {
    let content_iv = rand::random();
    let mut dek_wrap_iv = rand::random();
    while content_iv == dek_wrap_iv {
        dek_wrap_iv = rand::random();
    }
    encrypt_record_with_material(
        uck,
        metadata,
        plaintext,
        rand::random(),
        content_iv,
        dek_wrap_iv,
    )
}

pub fn encrypt_record_with_material(
    uck: &[u8],
    metadata: &ContentMetadata,
    plaintext: &[u8],
    dek: [u8; AES_KEY_LEN],
    content_iv: [u8; AES_NONCE_LEN],
    dek_wrap_iv: [u8; AES_NONCE_LEN],
) -> Result<EncryptedPromptRecord, ContentCryptoError> {
    let aad = canonical_aad(metadata)?;
    let dek = Zeroizing::new(dek);
    let (ciphertext, auth_tag) = seal_detached(&dek[..], &content_iv, plaintext, &aad)?;
    let (wrapped_dek, dek_wrap_auth_tag) = seal_detached(uck, &dek_wrap_iv, &dek[..], &aad)?;

    Ok(EncryptedPromptRecord {
        wrapped_dek,
        dek_wrap_iv,
        dek_wrap_auth_tag,
        iv: content_iv,
        ciphertext,
        auth_tag,
    })
}

#[cfg(test)]
pub fn decrypt_record(
    uck: &[u8],
    metadata: &ContentMetadata,
    record: &EncryptedPromptRecord,
) -> Result<Vec<u8>, ContentCryptoError> {
    let aad = canonical_aad(metadata)?;
    let dek = Zeroizing::new(open_detached(
        uck,
        &record.dek_wrap_iv,
        &record.wrapped_dek,
        &record.dek_wrap_auth_tag,
        &aad,
    )?);
    if dek.len() != AES_KEY_LEN {
        return Err(ContentCryptoError::InvalidKey);
    }
    open_detached(&dek, &record.iv, &record.ciphertext, &record.auth_tag, &aad)
}

pub fn generate_device_keypair() -> Result<DeviceKeypair, ContentCryptoError> {
    type Kem = DhP256HkdfSha256;
    let (private_key, public_key) = Kem::gen_keypair();
    Ok(DeviceKeypair {
        private_key: Zeroizing::new(private_key.to_bytes().to_vec()),
        public_key: public_key.to_bytes().to_vec(),
    })
}

pub fn wrap_for_device(
    public_key: &[u8],
    uck: &[u8],
) -> Result<DeviceEnvelope, ContentCryptoError> {
    type Kem = DhP256HkdfSha256;
    let public_key = <Kem as KemTrait>::PublicKey::from_bytes(public_key)
        .map_err(|_| ContentCryptoError::InvalidKey)?;
    let (encapsulated_key, ciphertext) = hpke::single_shot_seal::<AesGcm256, HkdfSha256, Kem>(
        &OpModeS::Base,
        &public_key,
        HPKE_INFO,
        uck,
        HPKE_AAD,
    )
    .map_err(|_| ContentCryptoError::EncryptionFailed)?;

    Ok(DeviceEnvelope {
        encapsulated_key: encapsulated_key.to_bytes().to_vec(),
        ciphertext,
    })
}

#[cfg(test)]
pub fn open_device_envelope(
    private_key: &[u8],
    envelope: &DeviceEnvelope,
) -> Result<[u8; AES_KEY_LEN], ContentCryptoError> {
    type Kem = DhP256HkdfSha256;
    let private_key = <Kem as KemTrait>::PrivateKey::from_bytes(private_key)
        .map_err(|_| ContentCryptoError::InvalidKey)?;
    let encapsulated_key = <Kem as KemTrait>::EncappedKey::from_bytes(&envelope.encapsulated_key)
        .map_err(|_| ContentCryptoError::InvalidEnvelope)?;
    let plaintext = Zeroizing::new(
        hpke::single_shot_open::<AesGcm256, HkdfSha256, Kem>(
            &OpModeR::Base,
            &private_key,
            &encapsulated_key,
            HPKE_INFO,
            &envelope.ciphertext,
            HPKE_AAD,
        )
        .map_err(|_| ContentCryptoError::AuthenticationFailed)?,
    );
    plaintext
        .as_slice()
        .try_into()
        .map_err(|_| ContentCryptoError::InvalidEnvelope)
}

fn seal_detached(
    key: &[u8],
    nonce: &[u8; AES_NONCE_LEN],
    plaintext: &[u8],
    aad: &[u8],
) -> Result<(Vec<u8>, [u8; AES_TAG_LEN]), ContentCryptoError> {
    let key: &[u8; AES_KEY_LEN] = key.try_into().map_err(|_| ContentCryptoError::InvalidKey)?;
    let cipher = Aes256Gcm::new(&Key::<Aes256Gcm>::from(*key));
    let nonce = Nonce::from(*nonce);
    let mut sealed = cipher
        .encrypt(
            &nonce,
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| ContentCryptoError::EncryptionFailed)?;
    let tag_start = sealed
        .len()
        .checked_sub(AES_TAG_LEN)
        .ok_or(ContentCryptoError::EncryptionFailed)?;
    let tag: [u8; AES_TAG_LEN] = sealed[tag_start..]
        .try_into()
        .map_err(|_| ContentCryptoError::EncryptionFailed)?;
    sealed.truncate(tag_start);
    Ok((sealed, tag))
}

#[cfg(test)]
fn open_detached(
    key: &[u8],
    nonce: &[u8; AES_NONCE_LEN],
    ciphertext: &[u8],
    tag: &[u8; AES_TAG_LEN],
    aad: &[u8],
) -> Result<Vec<u8>, ContentCryptoError> {
    let key: &[u8; AES_KEY_LEN] = key.try_into().map_err(|_| ContentCryptoError::InvalidKey)?;
    let cipher = Aes256Gcm::new(&Key::<Aes256Gcm>::from(*key));
    let nonce = Nonce::from(*nonce);
    let mut sealed = Vec::with_capacity(ciphertext.len() + AES_TAG_LEN);
    sealed.extend_from_slice(ciphertext);
    sealed.extend_from_slice(tag);
    cipher
        .decrypt(&nonce, Payload { msg: &sealed, aad })
        .map_err(|_| ContentCryptoError::AuthenticationFailed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn metadata() -> ContentMetadata {
        ContentMetadata {
            schema: "e2ee_v1".into(),
            content_owner_id: "018f47d0-4d47-7b04-950b-7d18a86e1b43".into(),
            dedup_key: "dedup-1".into(),
            provider_key: "codex".into(),
            turn_role: "user".into(),
            ts: "2026-07-14T00:00:00.000Z".into(),
        }
    }

    #[test]
    fn canonical_aad_has_fixed_field_order() {
        assert_eq!(
            String::from_utf8(canonical_aad(&metadata()).unwrap()).unwrap(),
            r#"{"schema":"e2ee_v1","contentOwnerId":"018f47d0-4d47-7b04-950b-7d18a86e1b43","dedupKey":"dedup-1","providerKey":"codex","turnRole":"user","ts":"2026-07-14T00:00:00.000Z"}"#,
        );
    }

    #[test]
    fn record_round_trip_and_aad_tamper_failure() {
        let uck = [7u8; 32];
        let encrypted = encrypt_record_with_material(
            &uck,
            &metadata(),
            b"secret prompt",
            [9u8; 32],
            [1u8; 12],
            [2u8; 12],
        )
        .unwrap();
        assert_ne!(encrypted.iv, encrypted.dek_wrap_iv);
        assert_eq!(
            decrypt_record(&uck, &metadata(), &encrypted).unwrap(),
            b"secret prompt",
        );

        let mut tampered = metadata();
        tampered.provider_key = "claude".into();
        assert!(decrypt_record(&uck, &tampered, &encrypted).is_err());
        assert!(decrypt_record(&[8u8; 32], &metadata(), &encrypted).is_err());
    }

    #[test]
    fn generated_record_uses_expected_lengths() {
        let encrypted = encrypt_record(&[7u8; 32], &metadata(), b"hello").unwrap();
        assert_eq!(encrypted.wrapped_dek.len(), 32);
        assert_eq!(encrypted.dek_wrap_iv.len(), 12);
        assert_eq!(encrypted.dek_wrap_auth_tag.len(), 16);
        assert_eq!(encrypted.iv.len(), 12);
        assert_eq!(encrypted.auth_tag.len(), 16);
    }

    #[test]
    fn hpke_device_envelope_round_trips() {
        let pair = generate_device_keypair().unwrap();
        let envelope = wrap_for_device(&pair.public_key, &[3u8; 32]).unwrap();
        assert_eq!(envelope.encapsulated_key.len(), 65);
        assert_eq!(
            open_device_envelope(&pair.private_key, &envelope).unwrap(),
            [3u8; 32],
        );
    }

    #[test]
    fn rust_matches_shared_golden_vector() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../../fixtures/e2ee-v1-golden.json")).unwrap();
        let encrypted = encrypt_record_with_material(
            &[7u8; 32],
            &metadata(),
            b"secret prompt",
            [9u8; 32],
            [1u8; 12],
            [2u8; 12],
        )
        .unwrap();

        assert_eq!(b64url(&canonical_aad(&metadata()).unwrap()), fixture["aad"]);
        assert_eq!(b64url(&encrypted.ciphertext), fixture["ciphertext"]);
        assert_eq!(b64url(&encrypted.auth_tag), fixture["authTag"]);
        assert_eq!(b64url(&encrypted.wrapped_dek), fixture["wrappedDek"]);
        assert_eq!(
            b64url(&encrypted.dek_wrap_auth_tag),
            fixture["dekWrapAuthTag"]
        );
    }

    fn b64url(bytes: &[u8]) -> String {
        const ALPHABET: &[u8; 64] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        let mut output = String::with_capacity((bytes.len() * 4).div_ceil(3));
        for chunk in bytes.chunks(3) {
            let first = chunk[0];
            let second = chunk.get(1).copied().unwrap_or(0);
            let third = chunk.get(2).copied().unwrap_or(0);
            output.push(ALPHABET[(first >> 2) as usize] as char);
            output.push(ALPHABET[(((first & 0x03) << 4) | (second >> 4)) as usize] as char);
            if chunk.len() > 1 {
                output.push(ALPHABET[(((second & 0x0f) << 2) | (third >> 6)) as usize] as char);
            }
            if chunk.len() > 2 {
                output.push(ALPHABET[(third & 0x3f) as usize] as char);
            }
        }
        output
    }
}
