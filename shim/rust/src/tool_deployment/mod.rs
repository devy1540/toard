pub(crate) mod adapters;
pub(crate) mod client;
pub(crate) mod launcher;
pub(crate) mod plan;
pub(crate) mod protocol;
pub(crate) mod reconcile;
pub(crate) mod secrets;
pub(crate) mod source;
pub(crate) mod state;

use std::fmt;

pub(crate) const SPAWN_ARG: &str = "--tool-deploy-spawn";
pub(crate) const RUN_ARG: &str = "--tool-deploy-run";

pub(crate) fn maybe_spawn_background() {
    if crate::bg::throttle("last-tool-reconcile", 60) {
        crate::bg::kick(SPAWN_ARG);
    }
}

pub(crate) fn spawn_detached_reconciler() -> ! {
    crate::bg::detach(RUN_ARG)
}

pub(crate) fn run_once() -> i32 {
    reconcile::run_once()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DeployError {
    code: &'static str,
}

impl DeployError {
    pub(crate) fn new(code: &'static str) -> Self {
        Self { code }
    }

    pub(crate) fn code(&self) -> &'static str {
        self.code
    }
}

impl fmt::Display for DeployError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code)
    }
}

impl std::error::Error for DeployError {}

#[cfg(test)]
mod tests;
