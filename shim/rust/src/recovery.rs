use aes_gcm::{
    aead::{Aead, Payload},
    Aes256Gcm, Key, KeyInit, Nonce,
};
use bip39::{Language, Mnemonic};
use hkdf::Hkdf;
use sha2::Sha256;
use zeroize::Zeroizing;

const KEY_LEN: usize = 32;
const NONCE_LEN: usize = 12;
const TAG_LEN: usize = 16;
const RECOVERY_INFO: &[u8] = b"toard/recovery-wrap/v1";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecoveryWrapper {
    pub nonce: [u8; NONCE_LEN],
    pub wrapped_content_key: Vec<u8>,
    pub auth_tag: [u8; TAG_LEN],
}

#[derive(Clone)]
pub struct RecoveryMaterial {
    entropy: Zeroizing<[u8; KEY_LEN]>,
    mnemonic: Zeroizing<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecoveryError {
    InvalidMnemonic,
    InvalidKey,
    DerivationFailed,
    EncryptionFailed,
    #[cfg(test)]
    AuthenticationFailed,
}

impl std::fmt::Display for RecoveryError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let message = match self {
            Self::InvalidMnemonic => "invalid recovery phrase",
            Self::InvalidKey => "invalid recovery key",
            Self::DerivationFailed => "recovery key derivation failed",
            Self::EncryptionFailed => "recovery wrapping failed",
            #[cfg(test)]
            Self::AuthenticationFailed => "recovery authentication failed",
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for RecoveryError {}

impl RecoveryMaterial {
    pub fn generate() -> Result<Self, RecoveryError> {
        Self::from_entropy(rand::random())
    }

    pub fn from_entropy(entropy: [u8; KEY_LEN]) -> Result<Self, RecoveryError> {
        let mnemonic = Mnemonic::from_entropy_in(Language::English, &entropy)
            .map_err(|_| RecoveryError::InvalidMnemonic)?
            .to_string();
        Ok(Self {
            entropy: Zeroizing::new(entropy),
            mnemonic: Zeroizing::new(mnemonic),
        })
    }

    #[cfg(test)]
    pub fn from_mnemonic(phrase: &str) -> Result<Self, RecoveryError> {
        let mnemonic = Mnemonic::parse_in(Language::English, phrase)
            .map_err(|_| RecoveryError::InvalidMnemonic)?;
        if mnemonic.word_count() != 24 {
            return Err(RecoveryError::InvalidMnemonic);
        }
        let entropy = Zeroizing::new(mnemonic.to_entropy());
        let entropy: [u8; KEY_LEN] = entropy
            .as_slice()
            .try_into()
            .map_err(|_| RecoveryError::InvalidMnemonic)?;
        Self::from_entropy(entropy)
    }

    pub fn mnemonic(&self) -> &str {
        &self.mnemonic
    }

    #[cfg(test)]
    pub fn secret(&self) -> Zeroizing<[u8; KEY_LEN]> {
        Zeroizing::new(*self.entropy)
    }

    pub fn wrap_uck(
        &self,
        salt: &[u8],
        uck: &[u8],
        owner_id: &str,
        version: u32,
    ) -> Result<RecoveryWrapper, RecoveryError> {
        self.wrap_uck_with_nonce(salt, uck, owner_id, version, rand::random())
    }

    pub fn wrap_uck_with_nonce(
        &self,
        salt: &[u8],
        uck: &[u8],
        owner_id: &str,
        version: u32,
        nonce: [u8; NONCE_LEN],
    ) -> Result<RecoveryWrapper, RecoveryError> {
        if salt.len() < 16 || uck.len() != KEY_LEN || owner_id.is_empty() {
            return Err(RecoveryError::InvalidKey);
        }
        let key = self.derive_wrap_key(salt)?;
        let aad = recovery_aad(owner_id, version);
        let cipher = Aes256Gcm::new(&Key::<Aes256Gcm>::from(*key));
        let mut sealed = cipher
            .encrypt(
                &Nonce::from(nonce),
                Payload {
                    msg: uck,
                    aad: &aad,
                },
            )
            .map_err(|_| RecoveryError::EncryptionFailed)?;
        let tag_start = sealed
            .len()
            .checked_sub(TAG_LEN)
            .ok_or(RecoveryError::EncryptionFailed)?;
        let auth_tag = sealed[tag_start..]
            .try_into()
            .map_err(|_| RecoveryError::EncryptionFailed)?;
        sealed.truncate(tag_start);

        Ok(RecoveryWrapper {
            nonce,
            wrapped_content_key: sealed,
            auth_tag,
        })
    }

    #[cfg(test)]
    pub fn unwrap_uck(
        &self,
        salt: &[u8],
        owner_id: &str,
        version: u32,
        wrapper: &RecoveryWrapper,
    ) -> Result<[u8; KEY_LEN], RecoveryError> {
        if salt.len() < 16 || owner_id.is_empty() {
            return Err(RecoveryError::InvalidKey);
        }
        let key = self.derive_wrap_key(salt)?;
        let aad = recovery_aad(owner_id, version);
        let mut sealed = Zeroizing::new(Vec::with_capacity(
            wrapper.wrapped_content_key.len() + TAG_LEN,
        ));
        sealed.extend_from_slice(&wrapper.wrapped_content_key);
        sealed.extend_from_slice(&wrapper.auth_tag);
        let cipher = Aes256Gcm::new(&Key::<Aes256Gcm>::from(*key));
        let plaintext = Zeroizing::new(
            cipher
                .decrypt(
                    &Nonce::from(wrapper.nonce),
                    Payload {
                        msg: &sealed,
                        aad: &aad,
                    },
                )
                .map_err(|_| RecoveryError::AuthenticationFailed)?,
        );
        plaintext
            .as_slice()
            .try_into()
            .map_err(|_| RecoveryError::InvalidKey)
    }

    fn derive_wrap_key(&self, salt: &[u8]) -> Result<Zeroizing<[u8; KEY_LEN]>, RecoveryError> {
        let hkdf = Hkdf::<Sha256>::new(Some(salt), &self.entropy[..]);
        let mut key = Zeroizing::new([0u8; KEY_LEN]);
        hkdf.expand(RECOVERY_INFO, &mut key[..])
            .map_err(|_| RecoveryError::DerivationFailed)?;
        Ok(key)
    }
}

fn recovery_aad(owner_id: &str, version: u32) -> Vec<u8> {
    format!("toard/recovery/v1\n{owner_id}\n{version}").into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recovery_is_24_words_and_round_trips_entropy() {
        let recovery = RecoveryMaterial::from_entropy([42u8; 32]).unwrap();
        assert_eq!(recovery.mnemonic().split_whitespace().count(), 24);
        let reparsed = RecoveryMaterial::from_mnemonic(recovery.mnemonic()).unwrap();
        assert_eq!(&*reparsed.secret(), &[42u8; 32]);
    }

    #[test]
    fn bad_mnemonic_checksum_is_rejected() {
        assert!(RecoveryMaterial::from_mnemonic("abandon abandon").is_err());
    }

    #[test]
    fn recovery_wrapper_round_trips_uck_and_binds_owner() {
        let recovery = RecoveryMaterial::from_entropy([42u8; 32]).unwrap();
        let wrapped = recovery
            .wrap_uck_with_nonce(
                &[8u8; 32],
                &[7u8; 32],
                "018f47d0-4d47-7b04-950b-7d18a86e1b43",
                1,
                [6u8; 12],
            )
            .unwrap();
        assert_eq!(
            recovery
                .unwrap_uck(
                    &[8u8; 32],
                    "018f47d0-4d47-7b04-950b-7d18a86e1b43",
                    1,
                    &wrapped,
                )
                .unwrap(),
            [7u8; 32],
        );
        assert!(recovery
            .unwrap_uck(&[8u8; 32], "other-owner", 1, &wrapped)
            .is_err());
    }
}
