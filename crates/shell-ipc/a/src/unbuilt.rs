//! What the shell answers on a port whose module is not built yet: every
//! channel of it rejects with "not built yet: <module>", and the first call
//! says so once on stderr, so the shell starts with the ports that are.

use std::sync::Mutex;

use shell_contract::ipc::Responder;
use shell_contract::{IpcError, IpcValue};

pub struct Unbuilt(pub &'static str);

impl Unbuilt {
    pub fn answer(&self, reply: Responder) {
        static SEEN: Mutex<Vec<&'static str>> = Mutex::new(Vec::new());
        let mut seen = SEEN.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if !seen.contains(&self.0) {
            seen.push(self.0);
            eprintln!("shell: not built yet: {}", self.0);
        }
        reply.reply(Err::<IpcValue, _>(IpcError {
            name: Some("Error".into()),
            message: format!("not built yet: {}", self.0),
        }))
    }
}
