//! The channel table the batches fill at start (the stage 3 shell contract,
//! section 5): it refuses a channel not in `CHANNELS`, a second handler, a
//! channel of another batch and a kind renderers do not use; after every
//! batch, a channel renderers invoke, send or sendSync without a handler
//! stops the shell.

use std::collections::HashMap;
use std::rc::Rc;
use std::sync::LazyLock;

use shell_contract::ipc::{ChannelKind, Handler, RegisterBatch, RegisterError, Registry};
use shell_contract::provided::Provided;
use shell_contract::runtime::Services;
use shell_contract::{Batch, CHANNELS, ChannelSpec};

static BY_NAME: LazyLock<HashMap<&'static str, &'static ChannelSpec>> =
    LazyLock::new(|| CHANNELS.iter().map(|s| (s.name, s)).collect());

/// `CHANNELS` by name
pub fn spec_of(channel: &str) -> Option<&'static ChannelSpec> {
    BY_NAME.get(channel).copied()
}

/// The kinds a handler answers: an event channel has none, a port nobody uses
pub fn handled(kind: ChannelKind) -> bool {
    matches!(
        kind,
        ChannelKind::Invoke | ChannelKind::Send | ChannelKind::SendSync
    )
}

/// The registered handlers, by channel and kind, and what the batches
/// provide each other. Lives on the core thread.
#[derive(Default)]
pub struct Table {
    handlers: HashMap<(&'static str, ChannelKind), Rc<dyn Handler>>,
    provided: Rc<Provided>,
}

impl Registry for Table {
    fn register(
        &mut self,
        by: Batch,
        channel: &'static str,
        kind: ChannelKind,
        handler: Rc<dyn Handler>,
    ) -> Result<(), RegisterError> {
        let spec = spec_of(channel).ok_or(RegisterError::Unknown(channel))?;
        if spec.batch != by {
            return Err(RegisterError::WrongBatch {
                channel,
                owner: spec.batch,
                by,
            });
        }
        if !handled(kind) || !spec.kinds.contains(&kind) {
            return Err(RegisterError::WrongKind { channel, kind });
        }
        if self.handlers.contains_key(&(channel, kind)) {
            return Err(RegisterError::Twice(channel));
        }
        self.handlers.insert((channel, kind), handler);
        Ok(())
    }

    fn provided(&self) -> Rc<Provided> {
        self.provided.clone()
    }
}

impl Table {
    pub fn handler(&self, channel: &str, kind: ChannelKind) -> Option<Rc<dyn Handler>> {
        let spec = spec_of(channel)?;
        self.handlers.get(&(spec.name, kind)).cloned()
    }

    /// Every channel and kind renderers use that has no handler yet
    pub fn missing(&self) -> Vec<(&'static str, ChannelKind)> {
        CHANNELS
            .iter()
            .flat_map(|s| s.kinds.iter().map(move |k| (s.name, *k)))
            .filter(|(name, kind)| handled(*kind) && !self.handlers.contains_key(&(name, *kind)))
            .collect()
    }

    pub fn len(&self) -> usize {
        self.handlers.len()
    }

    pub fn is_empty(&self) -> bool {
        self.handlers.is_empty()
    }
}

/// Why the shell did not start
#[derive(Debug, PartialEq, Eq)]
pub enum StartError {
    Register(RegisterError),
    /// channels renderers use that no batch answers
    Missing(Vec<(&'static str, ChannelKind)>),
}

/// How much of the table must be there. The shell starts only `Complete`;
/// ipc-probe compares the batches as they stand.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Completeness {
    Complete,
    AsRegistered,
}

/// Fills a table from every batch, in order, on the core thread
pub fn build(
    services: &Services,
    batches: &[RegisterBatch],
    completeness: Completeness,
) -> Result<Table, StartError> {
    let mut table = Table::default();
    for register in batches {
        register(&mut table, services).map_err(StartError::Register)?;
    }
    let missing = table.missing();
    if completeness == Completeness::Complete && !missing.is_empty() {
        return Err(StartError::Missing(missing));
    }
    Ok(table)
}

#[cfg(test)]
mod tests {
    use super::*;
    use shell_contract::ipc::{CallContext, Responder};
    use shell_contract::value::IpcValue;

    struct Nothing;
    impl Handler for Nothing {
        fn call(&self, _: &CallContext, _: Vec<IpcValue>, reply: Responder) {
            reply.reply(Ok(IpcValue::Undefined))
        }
    }

    fn spec(batch: Batch, kind: ChannelKind) -> &'static ChannelSpec {
        CHANNELS
            .iter()
            .find(|s| s.batch == batch && s.kinds == [kind])
            .unwrap()
    }

    #[test]
    fn refuses_unknown_twice_wrong_batch_wrong_kind() {
        let mut t = Table::default();
        let h: Rc<dyn Handler> = Rc::new(Nothing);
        let w = spec(Batch::W, ChannelKind::Invoke).name;
        let m = spec(Batch::M, ChannelKind::Invoke).name;
        let event = spec(Batch::W, ChannelKind::Event).name;
        assert_eq!(
            t.register(Batch::W, "no:such", ChannelKind::Invoke, h.clone()),
            Err(RegisterError::Unknown("no:such"))
        );
        assert_eq!(
            t.register(Batch::W, m, ChannelKind::Invoke, h.clone()),
            Err(RegisterError::WrongBatch {
                channel: m,
                owner: Batch::M,
                by: Batch::W
            })
        );
        assert_eq!(
            t.register(Batch::W, w, ChannelKind::Send, h.clone()),
            Err(RegisterError::WrongKind {
                channel: w,
                kind: ChannelKind::Send
            })
        );
        assert_eq!(
            t.register(Batch::W, event, ChannelKind::Event, h.clone()),
            Err(RegisterError::WrongKind {
                channel: event,
                kind: ChannelKind::Event
            })
        );
        assert_eq!(
            t.register(Batch::W, w, ChannelKind::Invoke, h.clone()),
            Ok(())
        );
        assert_eq!(
            t.register(Batch::W, w, ChannelKind::Invoke, h),
            Err(RegisterError::Twice(w))
        );
        assert!(t.handler(w, ChannelKind::Invoke).is_some());
        assert!(t.handler(w, ChannelKind::Send).is_none());
    }

    #[test]
    fn missing_counts_handled_kinds_only() {
        let t = Table::default();
        let expected: usize = CHANNELS
            .iter()
            .map(|s| s.kinds.iter().filter(|k| handled(**k)).count())
            .sum();
        assert_eq!(t.missing().len(), expected);
        assert!(
            t.missing()
                .iter()
                .all(|(_, k)| *k != ChannelKind::Event && *k != ChannelKind::Port)
        );
    }
}
