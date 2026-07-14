use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use zeroize::Zeroizing;

const SERVICE_NAME: &str = "toard";
const CONTENT_KEY_LEN: usize = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyStoreError {
    NotFound,
    InvalidKey,
    Unavailable,
}

impl std::fmt::Display for KeyStoreError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let message = match self {
            Self::NotFound => "content key not found",
            Self::InvalidKey => "invalid content key",
            Self::Unavailable => "secure key store unavailable",
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for KeyStoreError {}

pub trait ContentKeyStore {
    fn put_uck(
        &self,
        owner_id: &str,
        version: u16,
        key: &[u8; CONTENT_KEY_LEN],
    ) -> Result<(), KeyStoreError>;
    fn get_uck(
        &self,
        owner_id: &str,
        version: u16,
    ) -> Result<Zeroizing<[u8; CONTENT_KEY_LEN]>, KeyStoreError>;
    fn put_device_private_key(&self, device_id: &str, key: &[u8]) -> Result<(), KeyStoreError>;
    fn get_device_private_key(&self, device_id: &str) -> Result<Zeroizing<Vec<u8>>, KeyStoreError>;
}

#[derive(Clone, Default)]
pub struct MemoryContentKeyStore {
    secrets: Arc<Mutex<HashMap<String, Zeroizing<Vec<u8>>>>>,
}

impl ContentKeyStore for MemoryContentKeyStore {
    fn put_uck(
        &self,
        owner_id: &str,
        version: u16,
        key: &[u8; CONTENT_KEY_LEN],
    ) -> Result<(), KeyStoreError> {
        validate_secret(owner_id, key)?;
        self.insert(uck_account(owner_id, version), key)
    }

    fn get_uck(
        &self,
        owner_id: &str,
        version: u16,
    ) -> Result<Zeroizing<[u8; CONTENT_KEY_LEN]>, KeyStoreError> {
        let secret = self.get(&uck_account(owner_id, version))?;
        let key = secret
            .as_slice()
            .try_into()
            .map_err(|_| KeyStoreError::InvalidKey)?;
        Ok(Zeroizing::new(key))
    }

    fn put_device_private_key(&self, device_id: &str, key: &[u8]) -> Result<(), KeyStoreError> {
        validate_secret(device_id, key)?;
        self.insert(device_account(device_id), key)
    }

    fn get_device_private_key(&self, device_id: &str) -> Result<Zeroizing<Vec<u8>>, KeyStoreError> {
        self.get(&device_account(device_id))
    }
}

impl MemoryContentKeyStore {
    fn insert(&self, account: String, key: &[u8]) -> Result<(), KeyStoreError> {
        self.secrets
            .lock()
            .map_err(|_| KeyStoreError::Unavailable)?
            .insert(account, Zeroizing::new(key.to_vec()));
        Ok(())
    }

    fn get(&self, account: &str) -> Result<Zeroizing<Vec<u8>>, KeyStoreError> {
        self.secrets
            .lock()
            .map_err(|_| KeyStoreError::Unavailable)?
            .get(account)
            .map(|secret| Zeroizing::new(secret.to_vec()))
            .ok_or(KeyStoreError::NotFound)
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct SystemContentKeyStore;

impl ContentKeyStore for SystemContentKeyStore {
    fn put_uck(
        &self,
        owner_id: &str,
        version: u16,
        key: &[u8; CONTENT_KEY_LEN],
    ) -> Result<(), KeyStoreError> {
        validate_secret(owner_id, key)?;
        put_system_secret(&uck_account(owner_id, version), key)
    }

    fn get_uck(
        &self,
        owner_id: &str,
        version: u16,
    ) -> Result<Zeroizing<[u8; CONTENT_KEY_LEN]>, KeyStoreError> {
        let secret = get_system_secret(&uck_account(owner_id, version))?;
        let key = secret
            .as_slice()
            .try_into()
            .map_err(|_| KeyStoreError::InvalidKey)?;
        Ok(Zeroizing::new(key))
    }

    fn put_device_private_key(&self, device_id: &str, key: &[u8]) -> Result<(), KeyStoreError> {
        validate_secret(device_id, key)?;
        put_system_secret(&device_account(device_id), key)
    }

    fn get_device_private_key(&self, device_id: &str) -> Result<Zeroizing<Vec<u8>>, KeyStoreError> {
        get_system_secret(&device_account(device_id))
    }
}

fn validate_secret(id: &str, key: &[u8]) -> Result<(), KeyStoreError> {
    if id.is_empty() || key.len() != CONTENT_KEY_LEN {
        return Err(KeyStoreError::InvalidKey);
    }
    Ok(())
}

fn uck_account(owner_id: &str, version: u16) -> String {
    format!("content:{owner_id}:uck:{version}")
}

fn device_account(device_id: &str) -> String {
    format!("content-device:{device_id}")
}

fn put_system_secret(account: &str, secret: &[u8]) -> Result<(), KeyStoreError> {
    let entry = keyring::Entry::new(SERVICE_NAME, account).map_err(map_keyring_error)?;
    entry.set_secret(secret).map_err(map_keyring_error)
}

fn get_system_secret(account: &str) -> Result<Zeroizing<Vec<u8>>, KeyStoreError> {
    let entry = keyring::Entry::new(SERVICE_NAME, account).map_err(map_keyring_error)?;
    let secret = Zeroizing::new(entry.get_secret().map_err(map_keyring_error)?);
    if secret.len() != CONTENT_KEY_LEN {
        return Err(KeyStoreError::InvalidKey);
    }
    Ok(secret)
}

fn map_keyring_error(error: keyring::Error) -> KeyStoreError {
    match error {
        keyring::Error::NoEntry => KeyStoreError::NotFound,
        _ => KeyStoreError::Unavailable,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_store_round_trips_and_reports_missing_keys() {
        let store = MemoryContentKeyStore::default();
        store.put_uck("owner-1", 1, &[4u8; 32]).unwrap();
        assert_eq!(&*store.get_uck("owner-1", 1).unwrap(), &[4u8; 32]);
        assert!(matches!(
            store.get_uck("owner-1", 2),
            Err(KeyStoreError::NotFound)
        ));

        store
            .put_device_private_key("device-1", &[5u8; 32])
            .unwrap();
        assert_eq!(
            &**store.get_device_private_key("device-1").unwrap(),
            &[5u8; 32],
        );
    }
}
