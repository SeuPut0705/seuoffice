//! Stage 3 batch D2: Documents 2: docs, hwp, html, markdown, epub, pdf. Registers a handler for every channel whose
//! spec in `shell_contract::CHANNELS` names batch D2; nothing else.
//!
//! One module per app. Each gives its handlers ([`kit::Entry`]) from the
//! services and the hosts it takes, and keeps its per-view state the way the
//! TypeScript's module-level maps kept it. What the handlers reach that is
//! not in Rust yet (engines, `main-core` modules still to port) is a host
//! trait in the app's module; the shell implements it (crates/shell, D2's
//! host file), ipc-probe inserts the module's fakes.

mod docs;
mod epub;
mod html;
mod hwp;
mod kit;
mod markdown;
mod pdf;
#[cfg(test)]
mod testing;
mod text_recovery;

use std::rc::Rc;

use shell_contract::ipc::{RegisterBatch, RegisterError, Registry};
use shell_contract::runtime::Services;
use shell_contract::{Batch, Provided};

/// An app's handlers; it adds its [`shell_contract::DocumentEditors`] to `provided`
type Entries = fn(&Services, &Rc<Provided>) -> Result<Vec<kit::Entry>, RegisterError>;

/// Every app's handlers
const APPS: &[Entries] = &[
    docs::entries,
    epub::entries,
    html::entries,
    hwp::entries,
    markdown::entries,
    pdf::entries,
];

pub fn register(registry: &mut dyn Registry, services: &Services) -> Result<(), RegisterError> {
    let provided = registry.provided();
    for app in APPS {
        for e in app(services, &provided)? {
            registry.register(Batch::D2, e.channel, e.kind, e.handler)?;
        }
    }
    Ok(())
}

const _: RegisterBatch = register;

/// Inserts the fakes of this batch's hosts, answering from the case's
/// `hosts.d2` value (Null when absent; tools/ipc-diff/README.md). Each app
/// reads its own member: `hosts.d2.docs`, `hosts.d2.pdf`, ...
#[cfg(feature = "probe")]
pub fn probe_hosts(hosts: &mut shell_contract::Hosts, case: &serde_json::Value) {
    fakes(hosts, case)
}

#[cfg(any(test, feature = "probe"))]
fn fakes(hosts: &mut shell_contract::Hosts, case: &serde_json::Value) {
    let app = |name: &str| case.get(name).unwrap_or(&serde_json::Value::Null);
    docs::fakes(hosts, app("docs"));
    epub::fakes(hosts, app("epub"));
    html::fakes(hosts, app("html"));
    hwp::fakes(hosts, app("hwp"));
    markdown::fakes(hosts, app("markdown"));
    pdf::fakes(hosts, app("pdf"));
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::sync::{Arc, Mutex};

    use main_core::packages::electron_utils::recovery_store::SharedRecoveryState;
    use shell_contract::ipc::ChannelKind;
    use shell_contract::{Batch, CHANNELS};

    use crate::testing::Rt;

    /// The shell's start-up check for this batch: every D2 channel a renderer
    /// invokes or sends to has a handler of that kind, and nothing else is
    /// registered (the registry refuses unknown, twice, other batches' and
    /// wrong-kind channels)
    #[test]
    fn registers_every_d2_channel_and_nothing_else() {
        let mut rt = Rt::new(|hosts| {
            // the shell inserts the process's one recovery state
            hosts.insert::<Arc<Mutex<SharedRecoveryState>>>(Arc::new(Mutex::new(
                SharedRecoveryState::new("0000000000000000"),
            )));
            super::fakes(hosts, &serde_json::Value::Null)
        });
        for app in super::APPS {
            rt.register(*app).unwrap();
        }
        let got: BTreeSet<_> = rt
            .registered()
            .into_iter()
            .map(|(c, k)| (c, format!("{k:?}")))
            .collect();
        let want: BTreeSet<_> = CHANNELS
            .iter()
            .filter(|s| s.batch == Batch::D2)
            .flat_map(|s| {
                s.kinds
                    .iter()
                    .filter(|k| **k != ChannelKind::Event)
                    .map(move |k| (s.name, format!("{k:?}")))
            })
            .collect();
        let missing: Vec<_> = want.difference(&got).collect();
        let extra: Vec<_> = got.difference(&want).collect();
        assert!(
            missing.is_empty() && extra.is_empty(),
            "missing {missing:?}, extra {extra:?}"
        );
    }
}
