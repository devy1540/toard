use std::collections::HashSet;

use super::cursor::{Cursor, FileStamp, FileState};
use super::ParsedLog;

pub struct ParsedFileBatch {
    pub path: String,
    pub stamp: FileStamp,
    pub parsed: ParsedLog,
}

pub struct TargetCursorPlan<T> {
    pub pending: Vec<T>,
    pub updates: Vec<(String, FileState)>,
    pub alive_paths: HashSet<String>,
}

pub fn plan_records<T: Clone>(
    path: &str,
    stamp: FileStamp,
    cursor: &Cursor,
    records: &[(String, T)],
) -> TargetCursorPlan<T> {
    let keys = records
        .iter()
        .map(|(key, _)| key.as_str())
        .collect::<Vec<_>>();
    let previous = cursor.files.get(path);
    let start = super::resume_index(
        previous.map_or(0, |state| state.sent),
        previous.map_or("", |state| state.sent_hash.as_str()),
        &keys,
    );
    let update = FileState {
        mtime_ms: stamp.mtime_ms,
        size: stamp.size,
        sent: keys.len() as u64,
        sent_hash: super::keys_hash(&keys),
    };
    TargetCursorPlan {
        pending: records
            .iter()
            .skip(start)
            .map(|(_, record)| record.clone())
            .collect(),
        updates: vec![(path.to_string(), update)],
        alive_paths: HashSet::from([path.to_string()]),
    }
}

pub fn commit_cursor_plan<T>(cursor: &mut Cursor, plan: TargetCursorPlan<T>) {
    for (path, state) in plan.updates {
        cursor.files.insert(path, state);
    }
    cursor
        .files
        .retain(|path, _| plan.alive_paths.contains(path));
}

pub fn parse_changed_once(
    adapter: &dyn super::LogAdapter,
    changed_paths: &HashSet<String>,
    include_content: bool,
    include_tools: bool,
) -> Vec<ParsedFileBatch> {
    let files = adapter.discover_files();
    parse_discovered_once(
        adapter,
        &files,
        changed_paths,
        include_content,
        include_tools,
    )
}

pub fn parse_discovered_once(
    adapter: &dyn super::LogAdapter,
    files: &[std::path::PathBuf],
    changed_paths: &HashSet<String>,
    include_content: bool,
    include_tools: bool,
) -> Vec<ParsedFileBatch> {
    files
        .iter()
        .filter_map(|path| {
            let display = path.display().to_string();
            if !changed_paths.contains(&display) {
                return None;
            }
            let stamp = super::cursor::stamp(path)?;
            let parsed = adapter.parse_changed(path, include_content, include_tools);
            Some(ParsedFileBatch {
                path: display,
                stamp,
                parsed,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::collect::cursor::{Cursor, FileStamp, FileState};
    use crate::collect::{LogAdapter, ParsedLog, RawUsage};
    use std::cell::Cell;
    use std::path::{Path, PathBuf};

    struct CountingAdapter {
        file: PathBuf,
        parse_calls: Cell<usize>,
    }

    impl LogAdapter for CountingAdapter {
        fn key(&self) -> &'static str {
            "counting"
        }

        fn discover_files(&self) -> Vec<PathBuf> {
            vec![self.file.clone()]
        }

        fn parse_file(&self, _path: &Path) -> Vec<RawUsage> {
            Vec::new()
        }

        fn parse_changed(
            &self,
            _path: &Path,
            _include_content: bool,
            _include_tools: bool,
        ) -> ParsedLog {
            self.parse_calls.set(self.parse_calls.get() + 1);
            ParsedLog::default()
        }
    }

    #[test]
    fn one_parsed_prefix_produces_independent_target_suffixes() {
        let path = "/tmp/session.jsonl";
        let stamp = FileStamp {
            mtime_ms: 10,
            size: 20,
        };
        let records = vec![
            ("a".to_string(), "event-a"),
            ("b".to_string(), "event-b"),
            ("c".to_string(), "event-c"),
        ];
        let mut company = Cursor::default();
        company.files.insert(
            path.into(),
            FileState {
                mtime_ms: 1,
                size: 2,
                sent: 1,
                sent_hash: super::super::keys_hash(&["a"]),
            },
        );
        let personal = Cursor::default();

        let company_plan = plan_records(path, stamp, &company, &records);
        let personal_plan = plan_records(path, stamp, &personal, &records);

        assert_eq!(company_plan.pending, vec!["event-b", "event-c"]);
        assert_eq!(personal_plan.pending, vec!["event-a", "event-b", "event-c"]);
        assert_eq!(company_plan.updates.len(), 1);
        assert_eq!(personal_plan.updates.len(), 1);
    }

    #[test]
    fn parses_each_changed_file_once_for_all_targets() {
        let file = std::env::temp_dir().join(format!(
            "toard-parse-once-{}-{}",
            std::process::id(),
            crate::bg::now_unix()
        ));
        std::fs::write(&file, "fixture").unwrap();
        let adapter = CountingAdapter {
            file: file.clone(),
            parse_calls: Cell::new(0),
        };
        let changed = std::collections::HashSet::from([file.display().to_string()]);

        let batches = parse_changed_once(&adapter, &changed, true, true);

        assert_eq!(adapter.parse_calls.get(), 1);
        assert_eq!(batches.len(), 1);
        let _ = std::fs::remove_file(file);
    }
}
