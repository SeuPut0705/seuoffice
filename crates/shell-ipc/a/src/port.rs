//! A port: the handler bodies of one TypeScript main module, one method per
//! channel. The shell reaches a module through its port until the module is
//! in `main-core`; then the port's implementation is that module.
//!
//! A port lives on the core thread (`Rc`, no `Send`): it wraps `main-core`
//! state that uses `Rc` and `RefCell`. What the shell inserts in its hosts is
//! a [`Factory`] that builds the port there, at registration.
//!
//! [`ports!`] declares a port trait from its channel list and gives it a
//! [`Port`] impl that registers every invoke, send and sendSync channel and
//! names the events the module sends (which have no handler).

use std::rc::Rc;
use std::sync::Arc;

use shell_contract::ipc::{CallContext, ChannelKind, Handler, RegisterError, Registry, Responder};
use shell_contract::runtime::Services;
use shell_contract::{Batch, IpcValue};

/// Builds a port on the core thread from the shell's services
pub type Build<P> = dyn Fn(&Services) -> Rc<P> + Send + Sync;

/// The host that builds port `P` on the core thread: `Hosts` holds
/// `Factory<dyn ports::X>` for every port
pub struct Factory<P: ?Sized>(pub Arc<Build<P>>);

impl<P: ?Sized> Clone for Factory<P> {
    fn clone(&self) -> Self {
        Factory(self.0.clone())
    }
}

impl<P: ?Sized> Factory<P> {
    pub fn new(build: impl Fn(&Services) -> Rc<P> + Send + Sync + 'static) -> Self {
        Factory(Arc::new(build))
    }
}

/// One channel of a port: its name, how renderers use it
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PortChannel {
    pub name: &'static str,
    pub kind: ChannelKind,
}

/// What [`ports!`] implements for `dyn Trait`
pub trait Port {
    /// the TypeScript module the port stands for
    const SOURCE: &'static str;
    const CHANNELS: &'static [PortChannel];
    /// calls the method of `CHANNELS[index]`, which is not an event
    fn dispatch(&self, index: usize, cx: &CallContext, args: Vec<IpcValue>, reply: Responder);
}

struct PortHandler<P: ?Sized> {
    port: Rc<P>,
    index: usize,
}

impl<P: Port + ?Sized> Handler for PortHandler<P> {
    fn call(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        self.port.dispatch(self.index, cx, args, reply)
    }
}

/// Registers every handled channel of `port` for batch A
pub fn register_port<P: Port + ?Sized + 'static>(
    registry: &mut dyn Registry,
    port: Rc<P>,
) -> Result<(), RegisterError> {
    for (index, channel) in P::CHANNELS.iter().enumerate() {
        if channel.kind == ChannelKind::Event {
            continue;
        }
        let handler = Rc::new(PortHandler {
            port: port.clone(),
            index,
        });
        registry.register(Batch::A, channel.name, channel.kind, handler)?;
    }
    Ok(())
}

/// `ports! { /// doc  pub trait Name("source.ts") { invoke "a:b" => a_b; event "a:c"; } }`
///
/// `invoke`, `send` and `send_sync` channels become trait methods; `event`
/// channels are listed only. Under the `probe` feature every port is also
/// implemented by [`crate::probe::Fake`].
macro_rules! ports {
    ($(
        $(#[$doc:meta])*
        pub trait $name:ident($source:literal) {
            $( $kind:ident $channel:literal $(=> $method:ident)? ; )*
        }
    )*) => {$(
        $(#[$doc])*
        pub trait $name {
            $( $crate::port::ports!(@method $kind $channel $(=> $method)?); )*
        }

        impl $crate::port::Port for dyn $name {
            const SOURCE: &'static str = $source;
            const CHANNELS: &'static [$crate::port::PortChannel] = &[$(
                $crate::port::PortChannel {
                    name: $channel,
                    kind: $crate::port::ports!(@kind $kind),
                },
            )*];

            #[allow(unused_variables, unused_assignments, unused_mut)]
            fn dispatch(
                &self,
                index: usize,
                cx: &shell_contract::ipc::CallContext,
                args: Vec<shell_contract::IpcValue>,
                reply: shell_contract::ipc::Responder,
            ) {
                let mut at = 0usize;
                $(
                    $( if index == at { return self.$method(cx, args, reply); } )?
                    at += 1;
                )*
                unreachable!("{} has no handled channel {index}", $source)
            }
        }

        #[cfg(feature = "probe")]
        impl $name for $crate::probe::Fake {
            $( $crate::port::ports!(@fake $kind $channel $(=> $method)?); )*
        }
    )*};

    (@method event $channel:literal) => {};
    (@method $kind:ident $channel:literal => $method:ident) => {
        #[doc = concat!("`", $channel, "`")]
        fn $method(
            &self,
            cx: &shell_contract::ipc::CallContext,
            args: Vec<shell_contract::IpcValue>,
            reply: shell_contract::ipc::Responder,
        );
    };

    (@fake event $channel:literal) => {};
    (@fake $kind:ident $channel:literal => $method:ident) => {
        fn $method(
            &self,
            _cx: &shell_contract::ipc::CallContext,
            _args: Vec<shell_contract::IpcValue>,
            reply: shell_contract::ipc::Responder,
        ) {
            self.answer($channel, reply)
        }
    };

    (@kind invoke) => { shell_contract::ipc::ChannelKind::Invoke };
    (@kind send) => { shell_contract::ipc::ChannelKind::Send };
    (@kind send_sync) => { shell_contract::ipc::ChannelKind::SendSync };
    (@kind event) => { shell_contract::ipc::ChannelKind::Event };
}

pub(crate) use ports;
