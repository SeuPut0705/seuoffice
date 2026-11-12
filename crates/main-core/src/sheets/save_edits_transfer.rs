//! `apps/sheets/src/main/save-edits-transfer.ts`.

use serde_json::Value;

/// `MAX_SAVE_EDITS_TOTAL` of shared/ipc-channels.ts
pub const MAX_SAVE_EDITS_TOTAL: f64 = 10_000_000.0;

/// A tab keeps at most this many transfers open at once.
const MAX_OPEN_TRANSFERS: usize = 4;

/// An unfinished upload this old is abandoned.
pub const TRANSFER_IDLE_EXPIRY_MS: f64 = 120_000.0;

/// The `setInterval` / `clearInterval` pair the store keeps its sweep on. The
/// interval fires [`SaveEditsTransferStore::tick`] every `ms` while it is set;
/// a timer that must not keep the process alive (`unref`) is the host's to
/// make.
pub trait SweepTimers {
    /// `setInterval(() => this.sweep(), ms)` and `unref?.()` on it
    fn set_interval(&mut self, ms: f64);
    /// `clearInterval(timer)`
    fn clear_interval(&mut self);
}

/// What the store throws: an `Error` with this message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransferError(pub &'static str);

/// `WorkbookSaveEditsBegin`: the fields the store reads.
#[derive(Debug, Clone, PartialEq)]
pub struct SaveEditsBegin {
    pub session_id: String,
    pub transfer_id: String,
    pub total: f64,
}

/// One chunk of `addChunk`'s request.
#[derive(Debug, Clone, PartialEq)]
pub struct SaveEditsChunk {
    pub session_id: String,
    pub transfer_id: String,
    pub seq: f64,
    pub edits: Vec<Value>,
}

struct PendingTransfer {
    transfer_id: String,
    session_id: String,
    total: f64,
    chunks: Vec<Vec<Value>>,
    received: f64,
    last_activity_ms: f64,
}

/// Accumulates the ordered edit chunks of large saves, one store per sheets
/// tab. The TypeScript re-interns the `sheetId` strings of the edits to save
/// memory; a copy of a string is the same value here.
pub struct SaveEditsTransferStore<T: SweepTimers> {
    transfers: Vec<PendingTransfer>,
    sweep_timer: bool,
    timers: T,
}

impl<T: SweepTimers> SaveEditsTransferStore<T> {
    pub fn new(timers: T) -> Self {
        SaveEditsTransferStore {
            transfers: Vec::new(),
            sweep_timer: false,
            timers,
        }
    }

    pub fn timers(&self) -> &T {
        &self.timers
    }

    fn position(&self, transfer_id: &str) -> Option<usize> {
        self.transfers
            .iter()
            .position(|transfer| transfer.transfer_id == transfer_id)
    }

    pub fn begin(&mut self, request: &SaveEditsBegin, now_ms: f64) -> Result<(), TransferError> {
        self.sweep(now_ms, TRANSFER_IDLE_EXPIRY_MS);
        if self.position(&request.transfer_id).is_some() {
            return Err(TransferError("Save transfer already exists."));
        }
        if self.transfers.len() >= MAX_OPEN_TRANSFERS {
            return Err(TransferError("Too many open save transfers."));
        }
        self.transfers.push(PendingTransfer {
            transfer_id: request.transfer_id.clone(),
            session_id: request.session_id.clone(),
            total: request.total,
            chunks: Vec::new(),
            received: 0.0,
            last_activity_ms: now_ms,
        });
        self.sync_sweep_timer();
        Ok(())
    }

    pub fn add_chunk(&mut self, request: SaveEditsChunk, now_ms: f64) -> Result<(), TransferError> {
        self.sweep(now_ms, TRANSFER_IDLE_EXPIRY_MS);
        let found = self
            .position(&request.transfer_id)
            .filter(|&at| self.transfers[at].session_id == request.session_id);
        let Some(at) = found else {
            return Err(TransferError("Unknown save transfer."));
        };
        if request.seq != self.transfers[at].chunks.len() as f64 {
            self.discard(&request.transfer_id, &request.session_id);
            return Err(TransferError("Save transfer chunk out of order."));
        }
        let received = self.transfers[at].received + request.edits.len() as f64;
        if received > self.transfers[at].total || received > MAX_SAVE_EDITS_TOTAL {
            self.discard(&request.transfer_id, &request.session_id);
            return Err(TransferError("Save transfer exceeds its declared size."));
        }
        let transfer = &mut self.transfers[at];
        transfer.received += request.edits.len() as f64;
        transfer.chunks.push(request.edits);
        transfer.last_activity_ms = now_ms;
        Ok(())
    }

    /// Consumes the transfer: a transfer feeds exactly one save request.
    pub fn take(
        &mut self,
        transfer_id: &str,
        session_id: &str,
    ) -> Result<Vec<Value>, TransferError> {
        let found = self
            .position(transfer_id)
            .filter(|&at| self.transfers[at].session_id == session_id);
        let Some(at) = found else {
            return Err(TransferError("Unknown save transfer."));
        };
        let transfer = self.transfers.remove(at);
        self.sync_sweep_timer();
        if transfer.received != transfer.total {
            return Err(TransferError("Save transfer is incomplete."));
        }
        Ok(transfer.chunks.into_iter().flatten().collect())
    }

    /// Silent no-op when the transfer is already consumed, expired, or owned
    /// by another session.
    pub fn discard(&mut self, transfer_id: &str, session_id: &str) {
        if let Some(at) = self
            .position(transfer_id)
            .filter(|&at| self.transfers[at].session_id == session_id)
        {
            self.transfers.remove(at);
        }
        self.sync_sweep_timer();
    }

    pub fn discard_session(&mut self, session_id: &str) {
        self.transfers
            .retain(|transfer| transfer.session_id != session_id);
        self.sync_sweep_timer();
    }

    pub fn sweep(&mut self, now_ms: f64, idle_expiry_ms: f64) {
        // the TypeScript deletes where `>` holds, so a NaN keeps the transfer
        #[allow(clippy::neg_cmp_op_on_partial_ord)]
        self.transfers
            .retain(|transfer| !(now_ms - transfer.last_activity_ms > idle_expiry_ms));
        self.sync_sweep_timer();
    }

    /// The callback of the sweep interval: `this.sweep()` at the clock's time.
    pub fn tick(&mut self, now_ms: f64) {
        self.sweep(now_ms, TRANSFER_IDLE_EXPIRY_MS);
    }

    /// Tab teardown: drop everything now.
    pub fn dispose(&mut self) {
        self.transfers.clear();
        self.sync_sweep_timer();
    }

    /// `get openTransferCount()`
    pub fn open_transfer_count(&self) -> usize {
        self.transfers.len()
    }

    fn sync_sweep_timer(&mut self) {
        if !self.transfers.is_empty() && !self.sweep_timer {
            self.timers.set_interval(TRANSFER_IDLE_EXPIRY_MS / 4.0);
            self.sweep_timer = true;
        } else if self.transfers.is_empty() && self.sweep_timer {
            self.timers.clear_interval();
            self.sweep_timer = false;
        }
    }
}
