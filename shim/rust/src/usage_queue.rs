//! Per-target, metadata-only usage journal. FULL synchronous WAL transactions are
//! committed before source cursors advance. Never stores an ingest credential.

use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::json;
use crate::usage_event::UsageEvent;

pub const DEFAULT_MAX_BYTES: u64 = 64 * 1024 * 1024;
pub const MAX_REQUEST_BYTES: usize = 4 * 1024 * 1024;

fn valid_project_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 256
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueueIdentity {
    pub destination: String,
    pub owner_id: Option<String>,
    pub token_fingerprint: String,
}

impl QueueIdentity {
    pub fn new(destination: &str, owner_id: Option<&str>, token: &str) -> Self {
        Self {
            destination: destination.into(),
            owner_id: owner_id.map(str::to_string),
            token_fingerprint: format!("{:x}", Sha256::digest(token.as_bytes())),
        }
    }

    fn compatible(&self, other: &Self) -> bool {
        self.destination == other.destination
            && match (&self.owner_id, &other.owner_id) {
                (Some(left), Some(right)) => left == right,
                _ => self.token_fingerprint == other.token_fingerprint,
            }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QueueError {
    Storage,
    UnsupportedVersion,
    Corrupt,
    IdentityChanged,
    Full,
    InvalidEvent,
}

impl std::fmt::Display for QueueError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Storage => "local usage queue could not be read or written",
            Self::UnsupportedVersion => "local usage queue requires a newer collector",
            Self::Corrupt => "local usage queue is inconsistent; it has been preserved",
            Self::IdentityChanged => "pending usage belongs to a different connection identity",
            Self::Full => "local usage queue is full; source cursors have not advanced",
            Self::InvalidEvent => "usage record does not satisfy the delivery contract",
        })
    }
}

impl From<rusqlite::Error> for QueueError {
    fn from(_: rusqlite::Error) -> Self {
        Self::Storage
    }
}

impl From<std::io::Error> for QueueError {
    fn from(_: std::io::Error) -> Self {
        Self::Storage
    }
}

pub struct QueueInput {
    pub event: UsageEvent,
    /// Local opaque project identity. Never part of the transmitted usage payload.
    pub project_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct QueuedUsage {
    pub sequence: i64,
    pub provider_key: String,
    pub project_id: Option<String>,
    pub payload: String,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize)]
pub struct QueueStatus {
    pub records: u64,
    pub bytes: u64,
}

/// Doctor/status must never create a journal, bind its identity or read payloads.
pub fn read_status(state_dir: &Path) -> Result<Option<QueueStatus>, QueueError> {
    let path = state_dir.join("usage-queue.sqlite3");
    let metadata = match std::fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(QueueError::Storage),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(QueueError::Storage);
    }
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    connection.busy_timeout(Duration::from_secs(5))?;
    let version: u32 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version != 1 {
        return Err(QueueError::UnsupportedVersion);
    }
    Ok(Some(connection.query_row(
        "SELECT (SELECT count(*) FROM pending_usage), pending_bytes FROM queue_meta WHERE singleton=1", [],
        |row| Ok(QueueStatus { records: row.get(0)?, bytes: row.get(1)? }),
    )?))
}

pub struct UsageQueue {
    path: PathBuf,
    instance_id: String,
    identity: QueueIdentity,
    max_bytes: u64,
}

fn read_identity(connection: &Connection) -> Result<Option<QueueIdentity>, QueueError> {
    Ok(connection
        .query_row(
            "SELECT destination, owner_id, token_fingerprint FROM queue_meta WHERE singleton=1",
            [],
            |row| {
                Ok(QueueIdentity {
                    destination: row.get(0)?,
                    owner_id: row.get(1)?,
                    token_fingerprint: row.get(2)?,
                })
            },
        )
        .optional()?)
}

fn ensure_identity(connection: &Connection, expected: &QueueIdentity) -> Result<(), QueueError> {
    if read_identity(connection)?.is_some_and(|current| expected.compatible(&current)) {
        Ok(())
    } else {
        Err(QueueError::IdentityChanged)
    }
}

impl UsageQueue {
    pub fn open(
        state_dir: &Path,
        requested: QueueIdentity,
        max_bytes: u64,
    ) -> Result<Self, QueueError> {
        // Create only this level: a removed target's parent must never be resurrected.
        match std::fs::create_dir(state_dir) {
            Ok(()) => crate::fsx::set_mode(state_dir, 0o700)?,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(_) => return Err(QueueError::Storage),
        }
        if std::fs::symlink_metadata(state_dir)?
            .file_type()
            .is_symlink()
        {
            return Err(QueueError::Storage);
        }
        crate::fsx::set_mode(state_dir, 0o700)?;
        let path = state_dir.join("usage-queue.sqlite3");
        if std::fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.file_type().is_symlink())
        {
            return Err(QueueError::Storage);
        }
        let mut connection = Connection::open(&path)?;
        crate::fsx::set_mode(&path, 0o600)?;
        connection.busy_timeout(Duration::from_secs(5))?;
        let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if version != 0 && version != 1 {
            return Err(QueueError::UnsupportedVersion);
        }
        if version == 0 {
            let tables: i64 = connection.query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table'",
                [],
                |row| row.get(0),
            )?;
            if tables != 0 {
                return Err(QueueError::UnsupportedVersion);
            }
        }
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "synchronous", "FULL")?;
        connection.pragma_update(None, "journal_size_limit", 4 * 1024 * 1024)?;
        let journal: String =
            connection.pragma_query_value(None, "journal_mode", |row| row.get(0))?;
        if journal != "wal" {
            return Err(QueueError::Storage);
        }
        connection.execute_batch(
            "BEGIN IMMEDIATE;
             CREATE TABLE IF NOT EXISTS queue_meta (
               singleton INTEGER PRIMARY KEY CHECK(singleton=1),
               destination TEXT NOT NULL, owner_id TEXT, token_fingerprint TEXT NOT NULL, instance_id TEXT NOT NULL,
               pending_bytes INTEGER NOT NULL DEFAULT 0 CHECK(pending_bytes >= 0)
             );
             CREATE TABLE IF NOT EXISTS pending_usage (
               sequence INTEGER PRIMARY KEY AUTOINCREMENT,
               event_key TEXT NOT NULL UNIQUE, provider_key TEXT NOT NULL, project_id TEXT,
               payload_bytes INTEGER NOT NULL CHECK(payload_bytes > 0), payload TEXT NOT NULL,
               CHECK(payload_bytes = length(CAST(payload AS BLOB)))
             );
             CREATE INDEX IF NOT EXISTS pending_usage_provider ON pending_usage(provider_key, sequence);
             CREATE TRIGGER IF NOT EXISTS pending_usage_insert AFTER INSERT ON pending_usage
             BEGIN UPDATE queue_meta SET pending_bytes=pending_bytes+NEW.payload_bytes WHERE singleton=1; END;
             CREATE TRIGGER IF NOT EXISTS pending_usage_delete AFTER DELETE ON pending_usage
             BEGIN UPDATE queue_meta SET pending_bytes=pending_bytes-OLD.payload_bytes WHERE singleton=1; END;
             PRAGMA user_version=1;
             COMMIT;",
        )?;

        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (records, actual_bytes): (u64, u64) = transaction.query_row(
            "SELECT count(*), COALESCE(sum(payload_bytes),0) FROM pending_usage",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let previous = read_identity(&transaction)?;
        if records > 0
            && !previous
                .as_ref()
                .is_some_and(|value| value.compatible(&requested))
        {
            return Err(QueueError::IdentityChanged);
        }
        if previous.is_some() {
            let accounted: u64 = transaction.query_row(
                "SELECT pending_bytes FROM queue_meta WHERE singleton=1",
                [],
                |row| row.get(0),
            )?;
            if actual_bytes != accounted {
                return Err(QueueError::Corrupt);
            }
        } else if records > 0 {
            return Err(QueueError::Corrupt);
        }
        let owner_id = requested.owner_id.clone().or_else(|| {
            previous
                .as_ref()
                .filter(|previous| previous.compatible(&requested))
                .and_then(|previous| previous.owner_id.clone())
        });
        let identity = QueueIdentity {
            owner_id,
            ..requested
        };
        let instance_id: String = transaction
            .query_row(
                "SELECT instance_id FROM queue_meta WHERE singleton=1",
                [],
                |row| row.get(0),
            )
            .optional()?
            .unwrap_or_else(|| format!("{:032x}", rand::random::<u128>()));
        transaction.execute(
            "INSERT INTO queue_meta(singleton,destination,owner_id,token_fingerprint,instance_id) VALUES(1,?1,?2,?3,?4)
             ON CONFLICT(singleton) DO UPDATE SET destination=excluded.destination, owner_id=excluded.owner_id, token_fingerprint=excluded.token_fingerprint",
            params![identity.destination, identity.owner_id, identity.token_fingerprint, instance_id],
        )?;
        transaction.commit()?;
        Ok(Self {
            path,
            instance_id,
            identity,
            max_bytes,
        })
    }

    fn connect(&self) -> Result<Connection, QueueError> {
        // Do not recreate a queue removed by uninstall. Handles are closed between
        // operations so Windows can remove a target while an HTTP request is in flight.
        let connection =
            Connection::open_with_flags(&self.path, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
        connection.busy_timeout(Duration::from_secs(5))?;
        let instance: String = connection.query_row(
            "SELECT instance_id FROM queue_meta WHERE singleton=1",
            [],
            |row| row.get(0),
        )?;
        if instance != self.instance_id {
            return Err(QueueError::IdentityChanged);
        }
        ensure_identity(&connection, &self.identity)?;
        connection.pragma_update(None, "synchronous", "FULL")?;
        Ok(connection)
    }

    /// All-or-nothing enqueue. The caller may advance its source cursor only after this returns.
    pub fn enqueue(&mut self, records: &[QueueInput]) -> Result<usize, QueueError> {
        let mut connection = self.connect()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_identity(&transaction, &self.identity)?;
        let mut inserted = 0;
        let mut bytes: u64 = transaction.query_row(
            "SELECT pending_bytes FROM queue_meta WHERE singleton=1",
            [],
            |row| row.get(0),
        )?;
        for record in records {
            let event = &record.event;
            let value = event.to_json();
            if event.user_id.is_some()
                || event.cost_usd != 0.0
                || UsageEvent::from_json(&value).is_err()
                || record
                    .project_id
                    .as_ref()
                    .is_some_and(|id| !valid_project_id(id))
            {
                return Err(QueueError::InvalidEvent);
            }
            let payload = json::to_pretty(&value);
            if payload.len() + 2 > MAX_REQUEST_BYTES {
                return Err(QueueError::InvalidEvent);
            }
            let exists: bool = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM pending_usage WHERE event_key=?1)",
                [&event.dedup_key],
                |row| row.get(0),
            )?;
            if exists {
                continue;
            }
            if bytes.saturating_add(payload.len() as u64) > self.max_bytes {
                return Err(QueueError::Full);
            }
            transaction.execute(
                "INSERT INTO pending_usage(event_key,provider_key,project_id,payload_bytes,payload) VALUES(?1,?2,?3,?4,?5)",
                params![event.dedup_key, event.provider_key, record.project_id, payload.len() as i64, payload],
            )?;
            bytes += payload.len() as u64;
            inserted += 1;
        }
        transaction.commit()?;
        Ok(inserted)
    }

    #[cfg(test)]
    pub fn peek(&self, limit: usize) -> Result<Vec<QueuedUsage>, QueueError> {
        self.peek_provider(None, limit)
    }

    pub fn peek_for(&self, provider: &str, limit: usize) -> Result<Vec<QueuedUsage>, QueueError> {
        self.peek_provider(Some(provider), limit)
    }

    fn peek_provider(
        &self,
        provider: Option<&str>,
        limit: usize,
    ) -> Result<Vec<QueuedUsage>, QueueError> {
        let mut connection = self.connect()?;
        let transaction = connection.transaction()?;
        ensure_identity(&transaction, &self.identity)?;
        let sql = if provider.is_some() {
            "SELECT sequence,provider_key,project_id,payload FROM pending_usage WHERE provider_key=?2 ORDER BY sequence LIMIT ?1"
        } else {
            "SELECT sequence,provider_key,project_id,payload FROM pending_usage WHERE ?2 IS NULL ORDER BY sequence LIMIT ?1"
        };
        let mut statement = transaction.prepare(sql)?;
        let rows = statement.query_map(params![limit.min(500) as i64, provider], |row| {
            Ok(QueuedUsage {
                sequence: row.get(0)?,
                provider_key: row.get(1)?,
                project_id: row.get(2)?,
                payload: row.get(3)?,
            })
        })?;
        let mut bytes = 2;
        let mut result = Vec::new();
        for row in rows {
            let row = row?;
            let parsed = json::parse(&row.payload).map_err(|_| QueueError::Corrupt)?;
            if row.payload.len() + 2 > MAX_REQUEST_BYTES
                || row
                    .project_id
                    .as_ref()
                    .is_some_and(|id| !valid_project_id(id))
                || parsed.get("providerKey").and_then(json::Value::as_str)
                    != Some(row.provider_key.as_str())
            {
                return Err(QueueError::Corrupt);
            }
            let size = row.payload.len() + usize::from(!result.is_empty());
            if bytes + size > MAX_REQUEST_BYTES {
                break;
            }
            bytes += size;
            result.push(row);
        }
        Ok(result)
    }

    /// Delete only the exact leased sequence IDs after a verified ACK (or explicit scope exclusion).
    /// AUTOINCREMENT prevents an old ACK from deleting a newly queued row with the same event key.
    pub fn acknowledge(&mut self, sequences: &[i64]) -> Result<(), QueueError> {
        let mut connection = self.connect()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_identity(&transaction, &self.identity)?;
        for sequence in sequences {
            transaction.execute("DELETE FROM pending_usage WHERE sequence=?1", [sequence])?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn status(&self) -> Result<QueueStatus, QueueError> {
        let mut connection = self.connect()?;
        let transaction = connection.transaction()?;
        ensure_identity(&transaction, &self.identity)?;
        Ok(transaction.query_row(
            "SELECT (SELECT count(*) FROM pending_usage), pending_bytes FROM queue_meta WHERE singleton=1", [],
            |row| Ok(QueueStatus { records: row.get(0)?, bytes: row.get(1)? }),
        )?)
    }

    pub fn pending_for(&self, provider: &str) -> Result<u64, QueueError> {
        let mut connection = self.connect()?;
        let transaction = connection.transaction()?;
        ensure_identity(&transaction, &self.identity)?;
        Ok(transaction.query_row(
            "SELECT count(*) FROM pending_usage WHERE provider_key=?1",
            [provider],
            |row| row.get(0),
        )?)
    }

    pub fn providers(&self) -> Result<Vec<String>, QueueError> {
        let mut connection = self.connect()?;
        let transaction = connection.transaction()?;
        ensure_identity(&transaction, &self.identity)?;
        let mut statement = transaction.prepare(
            "SELECT provider_key FROM pending_usage GROUP BY provider_key ORDER BY min(sequence)",
        )?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn requires_confirmed_receipt(&self) -> bool {
        self.identity.owner_id.is_some()
    }
}

pub fn batch_body(records: &[QueuedUsage]) -> String {
    format!(
        "[{}]",
        records
            .iter()
            .map(|record| record.payload.as_str())
            .collect::<Vec<_>>()
            .join(",")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestDirectory(std::path::PathBuf);
    impl std::ops::Deref for TestDirectory {
        type Target = Path;
        fn deref(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn directory() -> TestDirectory {
        let directory = std::env::temp_dir().join(format!(
            "toard-queue-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        std::fs::create_dir(&directory).unwrap();
        TestDirectory(directory)
    }

    fn identity(token: &str, user: Option<&str>) -> QueueIdentity {
        QueueIdentity::new("destination", user, token)
    }

    fn record(key: &str) -> QueueInput {
        QueueInput {
            event: UsageEvent {
                dedup_key: key.into(),
                provider_key: "codex".into(),
                user_id: None,
                session_id: Some("fixture-session".into()),
                model: Some("fixture-model".into()),
                ts: "2026-09-05T00:00:00Z".into(),
                input_tokens: 10,
                output_tokens: 2,
                cache_read_tokens: 0,
                cache_creation_tokens: 0,
                cache_creation_1h_tokens: 0,
                cost_usd: 0.0,
                log_adapter: Some("codex".into()),
                host: None,
            },
            project_id: Some("opaque-project-id".into()),
        }
    }

    #[test]
    fn committed_records_survive_reopen_and_are_removed_only_after_ack() {
        let directory = directory();
        assert_eq!(read_status(&directory).unwrap(), None);
        assert!(!directory.join("usage-queue.sqlite3").exists());
        let credentials = identity("test-credential", Some("owner-a"));
        {
            let mut queue =
                UsageQueue::open(&directory, credentials.clone(), DEFAULT_MAX_BYTES).unwrap();
            assert_eq!(queue.enqueue(&[record("one"), record("two")]).unwrap(), 2);
            assert_eq!(queue.enqueue(&[record("one")]).unwrap(), 0);
        }
        let mut queue = UsageQueue::open(&directory, credentials, DEFAULT_MAX_BYTES).unwrap();
        assert_eq!(
            read_status(&directory).unwrap().unwrap(),
            queue.status().unwrap()
        );
        let batch = queue.peek(250).unwrap();
        assert_eq!(batch.len(), 2);
        assert!(!batch_body(&batch).contains("test-credential"));
        assert!(!batch_body(&batch).contains("opaque-project-id"));
        queue
            .acknowledge(&batch.iter().map(|row| row.sequence).collect::<Vec<_>>())
            .unwrap();
        assert_eq!(queue.status().unwrap(), QueueStatus::default());
    }

    #[test]
    fn capacity_rejection_rolls_back_the_entire_batch_and_preserves_existing_records() {
        let directory = directory();
        let bytes = json::to_pretty(&record("one").event.to_json()).len() as u64;
        let mut queue = UsageQueue::open(&directory, identity("token", None), bytes + 2).unwrap();
        assert_eq!(
            queue.enqueue(&[record("one"), record("two")]),
            Err(QueueError::Full)
        );
        assert_eq!(queue.status().unwrap().records, 0);
        assert_eq!(queue.enqueue(&[record("one")]).unwrap(), 1);
        assert_eq!(queue.enqueue(&[record("two")]), Err(QueueError::Full));
        assert_eq!(queue.status().unwrap().records, 1);
    }

    #[test]
    fn pending_records_allow_verified_same_owner_rotation_but_never_reassignment() {
        let directory = directory();
        let mut queue = UsageQueue::open(
            &directory,
            identity("old", Some("owner-a")),
            DEFAULT_MAX_BYTES,
        )
        .unwrap();
        queue.enqueue(&[record("one")]).unwrap();
        drop(queue);
        assert!(UsageQueue::open(
            &directory,
            identity("new", Some("owner-a")),
            DEFAULT_MAX_BYTES
        )
        .is_ok());
        assert!(matches!(
            UsageQueue::open(
                &directory,
                identity("new", Some("owner-b")),
                DEFAULT_MAX_BYTES
            ),
            Err(QueueError::IdentityChanged)
        ));
    }

    #[test]
    fn unverified_identity_cannot_be_rebound_after_a_credential_change() {
        let directory = directory();
        let mut queue =
            UsageQueue::open(&directory, identity("old", None), DEFAULT_MAX_BYTES).unwrap();
        queue.enqueue(&[record("one")]).unwrap();
        drop(queue);
        assert!(matches!(
            UsageQueue::open(
                &directory,
                identity("new", Some("owner-a")),
                DEFAULT_MAX_BYTES
            ),
            Err(QueueError::IdentityChanged)
        ));
        assert!(UsageQueue::open(
            &directory,
            identity("old", Some("owner-a")),
            DEFAULT_MAX_BYTES
        )
        .is_ok());
    }

    #[test]
    fn stale_ack_cannot_remove_a_new_instance_of_an_event_key() {
        let directory = directory();
        let mut queue = UsageQueue::open(
            &directory,
            identity("token", Some("owner-a")),
            DEFAULT_MAX_BYTES,
        )
        .unwrap();
        queue.enqueue(&[record("one")]).unwrap();
        let old = queue.peek(1).unwrap()[0].sequence;
        queue.acknowledge(&[old]).unwrap();
        queue.enqueue(&[record("one")]).unwrap();
        queue.acknowledge(&[old]).unwrap();
        assert_eq!(queue.status().unwrap().records, 1);
    }

    #[test]
    fn corruption_is_reported_without_replacing_the_database() {
        let directory = directory();
        let path = directory.join("usage-queue.sqlite3");
        std::fs::write(&path, "not a database").unwrap();
        assert!(UsageQueue::open(&directory, identity("token", None), DEFAULT_MAX_BYTES).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "not a database");
    }
}
