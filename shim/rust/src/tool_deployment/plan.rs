use std::collections::{BTreeMap, BTreeSet};

use super::protocol::DesiredItem;
use super::state::ManagedState;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PlanAction {
    Install {
        slug: String,
        version_id: String,
    },
    Update {
        slug: String,
        from: String,
        to: String,
    },
    Remove {
        slug: String,
        version_id: String,
    },
    Noop {
        slug: String,
    },
}

pub(crate) fn plan(current: &ManagedState, desired: &[DesiredItem]) -> Vec<PlanAction> {
    let desired_by_slug: BTreeMap<&str, &DesiredItem> = desired
        .iter()
        .map(|item| (item.manifest.slug.as_str(), item))
        .collect();
    let mut actions = Vec::new();
    for (slug, item) in &desired_by_slug {
        match current.items.get(*slug) {
            None => actions.push(PlanAction::Install {
                slug: (*slug).to_owned(),
                version_id: item.version_id.clone(),
            }),
            Some(installed) if installed.version_id != item.version_id => {
                actions.push(PlanAction::Update {
                    slug: (*slug).to_owned(),
                    from: installed.version_id.clone(),
                    to: item.version_id.clone(),
                })
            }
            Some(_) => actions.push(PlanAction::Noop {
                slug: (*slug).to_owned(),
            }),
        }
    }
    let desired_slugs: BTreeSet<_> = desired_by_slug.keys().copied().collect();
    for (slug, installed) in &current.items {
        if !desired_slugs.contains(slug.as_str()) {
            actions.push(PlanAction::Remove {
                slug: slug.clone(),
                version_id: installed.version_id.clone(),
            });
        }
    }
    actions
}

pub(crate) fn plan_after_fetch_error(current: &ManagedState) -> Vec<PlanAction> {
    current
        .items
        .keys()
        .map(|slug| PlanAction::Noop { slug: slug.clone() })
        .collect()
}
