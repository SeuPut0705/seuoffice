//! `apps/shell/src/main/result-store-ipc.ts`: Settings > General, the size
//! and delete-all of the PDF result store.
//!
//! The handlers are promises in the TypeScript; here they are calls that
//! return the answer. `ResultStore` of `packages/pdf-structure` is not ported
//! yet: the module reaches it through [`ResultStore`] and [`MakeResultStore`].

use std::rc::Rc;

use serde_json::Value;

/// `RESULT_STORE_CHANNELS.size`
pub const RESULT_STORE_SIZE_CHANNEL: &str = "home:result-store-size";
/// `RESULT_STORE_CHANNELS.deleteAll`
pub const RESULT_STORE_DELETE_ALL_CHANNEL: &str = "home:result-store-delete-all";

/// What a handler throws (or rejects with): the error's message.
#[derive(Debug, Clone, PartialEq)]
pub struct StoreError {
    pub message: String,
}

/// The two methods of `ResultStore` the module calls.
pub trait ResultStore {
    /// `size()`: bytes the store takes on disk; 0 when it does not exist yet
    fn size(&self) -> f64;
    /// `deleteAll()`: remove the whole store folder (and nothing outside it)
    fn delete_all(&self) -> Result<(), StoreError>;
}

/// `new ResultStore(userDataDir)`: throws for a user-data folder it refuses.
pub type MakeResultStore = Rc<dyn Fn(&str) -> Result<Box<dyn ResultStore>, StoreError>>;

/// What an `ipc.handle` handler answers: `Ok(None)` is `undefined`.
pub type IpcHandler = Box<dyn Fn() -> Result<Option<Value>, StoreError>>;

/// `Pick<IpcMain, 'handle'>`
pub trait IpcHandle {
    fn handle(&mut self, channel: &str, handler: IpcHandler);
}

/// `registerResultStoreIpc(ipc, userDataDir)`: the store is built per call,
/// since the user-data folder is only final once the app is ready.
pub fn register_result_store_ipc(
    ipc: &mut dyn IpcHandle,
    user_data_dir: Rc<dyn Fn() -> String>,
    make_store: MakeResultStore,
) {
    let (dir, make) = (user_data_dir.clone(), make_store.clone());
    ipc.handle(
        RESULT_STORE_SIZE_CHANNEL,
        Box::new(move || {
            let store = make(&dir())?;
            Ok(Some(Value::from(store.size())))
        }),
    );
    ipc.handle(
        RESULT_STORE_DELETE_ALL_CHANNEL,
        Box::new(move || {
            let store = make_store(&user_data_dir())?;
            store.delete_all()?;
            Ok(None)
        }),
    );
}
