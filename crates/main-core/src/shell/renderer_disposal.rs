//! `apps/shell/src/main/renderer-disposal.ts`: ends a closed docs tab or
//! window, its renderer process first, then its webContents.
//!
//! The module-level `closed` set is a [`RendererDisposal`] the caller owns.
//! `webContents` is a [`ReleasableContents`]; every method of it may throw
//! (Electron throws on an object torn down meanwhile), so each answers a
//! [`Failure`]. `setImmediate` and the `render-process-gone` listener are the
//! contents' own methods: both end in [`destroy_closed_view`], which the
//! caller runs when the immediate or the event fires.

use std::collections::HashSet;

/// what a method of a torn-down webContents throws
#[derive(Debug, Clone, PartialEq)]
pub struct Failure(pub String);

/// `ReleasableContents`
pub trait ReleasableContents {
    fn id(&self) -> i64;
    fn is_destroyed(&self) -> Result<bool, Failure>;
    fn get_os_process_id(&self) -> Result<i64, Failure>;
    fn forcefully_crash_renderer(&self) -> Result<(), Failure>;
    /// `target.once('render-process-gone', destroy)`, where `destroy` is
    /// `setImmediate(() => destroy_closed_view(target))` when it fires
    fn once_render_process_gone_destroy(&self) -> Result<(), Failure>;
    /// `setImmediate(() => destroy_closed_view(target))`
    fn destroy_soon(&self) -> Result<(), Failure>;
    fn close(&self) -> Result<(), Failure>;
}

/// what `setImmediate` of `destroyWhenRendererGone` runs
pub fn destroy_closed_view(target: &dyn ReleasableContents) {
    // torn down meanwhile: nothing left to destroy
    let _ = (|| -> Result<(), Failure> {
        if !target.is_destroyed()? {
            target.close()?;
        }
        Ok(())
    })();
}

/// `const closed = new Set<number>()`: webContents ids of closed views handed
/// here, whose process ends on purpose
#[derive(Debug, Default)]
pub struct RendererDisposal {
    closed: HashSet<i64>,
}

impl RendererDisposal {
    pub fn new() -> Self {
        Self::default()
    }

    /// `wasReleasedRenderer`
    pub fn was_released_renderer(&self, web_contents_id: i64) -> bool {
        self.closed.contains(&web_contents_id)
    }

    /// `canEndRendererProcess`
    pub fn can_end_renderer_process(
        &self,
        target: &dyn ReleasableContents,
        peers: &[&dyn ReleasableContents],
    ) -> Result<bool, Failure> {
        if target.is_destroyed()? {
            return Ok(false);
        }
        let pid = target.get_os_process_id()?;
        if pid == 0 {
            return Ok(false);
        }
        for peer in peers {
            if peer.id() != target.id()
                && !peer.is_destroyed()?
                && !self.closed.contains(&peer.id())
                && peer.get_os_process_id()? == pid
            {
                return Ok(false);
            }
        }
        Ok(true)
    }

    /// `releaseClosedRenderer`; `peers` is its `peers()` argument
    pub fn release_closed_renderer(
        &mut self,
        target: &dyn ReleasableContents,
        peers: &mut dyn FnMut() -> Result<Vec<Box<dyn ReleasableContents>>, Failure>,
    ) -> bool {
        if self.closed.contains(&target.id()) {
            return false;
        }
        self.closed.insert(target.id());
        self.release(target, peers).unwrap_or(false)
    }

    fn release(
        &self,
        target: &dyn ReleasableContents,
        peers: &mut dyn FnMut() -> Result<Vec<Box<dyn ReleasableContents>>, Failure>,
    ) -> Result<bool, Failure> {
        if target.is_destroyed()? {
            return Ok(false);
        }
        destroy_when_renderer_gone(target)?;
        let peers = peers()?;
        let peers: Vec<&dyn ReleasableContents> = peers.iter().map(|p| p.as_ref()).collect();
        if !self.can_end_renderer_process(target, &peers)? {
            return Ok(false);
        }
        target.forcefully_crash_renderer()?;
        Ok(true)
    }
}

/// `destroyWhenRendererGone`: no process id means the renderer never started,
/// or it is already gone
fn destroy_when_renderer_gone(target: &dyn ReleasableContents) -> Result<(), Failure> {
    if target.get_os_process_id()? == 0 {
        target.destroy_soon()
    } else {
        target.once_render_process_gone_destroy()
    }
}
