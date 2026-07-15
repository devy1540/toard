pub(crate) mod adapters;
pub(crate) mod plan;
pub(crate) mod protocol;
pub(crate) mod source;
pub(crate) mod state;

use std::fmt;

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
