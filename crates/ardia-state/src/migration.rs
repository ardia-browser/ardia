pub use ardia_shell_migration::{
    Counts, Faults, Layout, Outcome, Report, Sealer, Stage, Vault, migrate,
};

pub fn run_shell_migration(layout: &Layout, sealer: &dyn Sealer, vault: &dyn Vault) -> Report {
    migrate(layout, sealer, vault, &Faults::default())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ardia_shell_migration::credentials::StoredCredential;
    use std::io;

    struct NoSeal;

    impl Sealer for NoSeal {
        fn seal(&self, plain: &[u8], _purpose: &str) -> io::Result<Vec<u8>> {
            Ok(plain.to_vec())
        }

        fn open(&self, sealed: &[u8], _purpose: &str) -> Option<zeroize::Zeroizing<Vec<u8>>> {
            Some(zeroize::Zeroizing::new(sealed.to_vec()))
        }
    }

    struct EmptyVault;

    impl Vault for EmptyVault {
        fn list(&self, _prefix: &str) -> io::Result<Vec<StoredCredential>> {
            Ok(Vec::new())
        }
    }

    #[test]
    fn an_empty_old_install_has_nothing_to_migrate() {
        let old = tempfile::tempdir().unwrap();
        let new = tempfile::tempdir().unwrap();
        let layout = Layout::custom(
            old.path().join("missing").to_str().unwrap(),
            new.path(),
            true,
        );
        let report = run_shell_migration(&layout, &NoSeal, &EmptyVault);
        assert!(
            matches!(
                report.outcome,
                Outcome::NothingToMigrate | Outcome::Refused | Outcome::Failed
            ),
            "{:?}",
            report.outcome
        );
    }
}
