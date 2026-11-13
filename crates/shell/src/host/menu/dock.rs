//! The macOS Dock icon's menu (Electron's `installDockMenu`): Home, then one
//! "New ..." entry per document kind the person did not hide.
//!
//! Tauri 3 has no dock-menu API, so this adds AppKit's
//! `-[NSApplicationDelegate applicationDockMenu:]` to the class of whatever
//! object is the NSApp delegate (tao's, set by Tauri) with the Objective-C
//! runtime. Off macOS [`set_dock_menu`] does nothing.

use std::sync::Arc;

/// What a Dock entry does when clicked
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DockAction {
    /// Open (or focus) the home tab
    Home,
    /// Create a document of a home kind: "docx", "xlsx", "pptx", "md" or "pdf"
    NewDocument(&'static str),
}

/// One row of the Dock menu, already in the app's language
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DockEntry {
    pub label: String,
    pub action: DockAction,
}

/// The action of the entry a clicked menu item stands for. An item's tag is its
/// index in the entry list: tags stay valid because the whole menu is rebuilt
/// whenever the list is replaced.
#[cfg(any(target_os = "macos", test))]
fn action_for_tag(entries: &[DockEntry], tag: isize) -> Option<DockAction> {
    usize::try_from(tag)
        .ok()
        .and_then(|index| entries.get(index))
        .map(|entry| entry.action)
}

/// Installs the delegate method once and sets the entries; calling again
/// replaces them. An empty list leaves the Dock with the system's default menu.
/// May be called from any thread: the AppKit work runs on the UI thread.
#[cfg(target_os = "macos")]
pub(crate) fn set_dock_menu(
    app: &tauri::AppHandle,
    entries: Vec<DockEntry>,
    on_click: Arc<dyn Fn(DockAction) + Send + Sync>,
) {
    use tauri::Manager;

    let result = app.run_on_main_thread(move || {
        // run_on_main_thread only runs on the main thread, but the marker is the
        // proof AppKit calls below need
        if let Some(mtm) = objc2::MainThreadMarker::new() {
            mac::apply(mtm, entries, on_click);
        }
    });
    if let Err(error) = result {
        eprintln!("shell: dock menu not set: {error}");
    }
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn set_dock_menu(
    _app: &tauri::AppHandle,
    _entries: Vec<DockEntry>,
    _on_click: Arc<dyn Fn(DockAction) + Send + Sync>,
) {
}

#[cfg(target_os = "macos")]
mod mac {
    use std::cell::RefCell;
    use std::mem::transmute;
    use std::sync::Arc;

    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
    use objc2::{MainThreadMarker, MainThreadOnly, define_class, ffi, msg_send, sel};
    use objc2_app_kit::{NSApplication, NSMenu, NSMenuItem};
    use objc2_foundation::{NSObject, NSString};

    use super::{DockAction, DockEntry, action_for_tag};

    define_class!(
        /// The target of every Dock menu item: AppKit holds an item's target
        /// weakly, so one instance lives in [`State`] for as long as the menu does
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "SeuOfficeDockMenuTarget"]
        struct DockTarget;

        impl DockTarget {
            #[unsafe(method(dockItem:))]
            fn dock_item(&self, item: &NSMenuItem) {
                click(item.tag());
            }
        }
    );

    impl DockTarget {
        fn new(mtm: MainThreadMarker) -> Retained<Self> {
            let this = mtm.alloc::<Self>().set_ivars(());
            // SAFETY: NSObject's plain `init`
            unsafe { msg_send![super(this), init] }
        }
    }

    /// `applicationDockMenu:`: `(self, _cmd, sender) -> NSMenu *`
    type DockMenuImp =
        unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject) -> *mut AnyObject;

    /// A delegate class that got the method, and what it answered before
    struct Hook {
        class: *const AnyClass,
        /// The implementation the class had (its own or inherited), if any
        previous: Option<Imp>,
    }

    /// Everything here is touched by the main thread only: `apply` runs on it
    /// and so does AppKit when it asks for the menu or an item is clicked
    #[derive(Default)]
    struct State {
        menu: Option<Retained<NSMenu>>,
        target: Option<Retained<DockTarget>>,
        entries: Vec<DockEntry>,
        on_click: Option<Arc<dyn Fn(DockAction) + Send + Sync>>,
        hooks: Vec<Hook>,
    }

    thread_local! {
        static STATE: RefCell<State> = RefCell::new(State::default());
    }

    pub(super) fn apply(
        mtm: MainThreadMarker,
        entries: Vec<DockEntry>,
        on_click: Arc<dyn Fn(DockAction) + Send + Sync>,
    ) {
        // The delegate can be replaced after startup (CEF installs its own), so
        // every call checks the current one instead of installing once
        let delegate = NSApplication::sharedApplication(mtm).delegate();
        if let Some(delegate) = &delegate {
            // SAFETY: a protocol object is an Objective-C object
            let object: &AnyObject = unsafe { &*(Retained::as_ptr(delegate).cast::<AnyObject>()) };
            install(object.class());
        } else {
            eprintln!("shell: the app has no delegate yet, so the Dock menu is not installed");
        }

        let target = target(mtm);
        let menu = (!entries.is_empty()).then(|| build_menu(mtm, &target, &entries));
        STATE.with_borrow_mut(|state| {
            state.menu = menu;
            state.entries = entries;
            state.on_click = Some(on_click);
        });
    }

    /// The one item target, made on first use
    fn target(mtm: MainThreadMarker) -> Retained<DockTarget> {
        STATE.with_borrow_mut(|state| {
            state
                .target
                .get_or_insert_with(|| DockTarget::new(mtm))
                .clone()
        })
    }

    fn build_menu(
        mtm: MainThreadMarker,
        target: &DockTarget,
        entries: &[DockEntry],
    ) -> Retained<NSMenu> {
        let menu = NSMenu::initWithTitle(mtm.alloc(), &NSString::new());
        for (index, entry) in entries.iter().enumerate() {
            // SAFETY: `dockItem:` is defined on `DockTarget` above
            let item = unsafe {
                NSMenuItem::initWithTitle_action_keyEquivalent(
                    mtm.alloc(),
                    &NSString::from_str(&entry.label),
                    Some(sel!(dockItem:)),
                    &NSString::new(),
                )
            };
            // SAFETY: `State` keeps the target alive; AppKit holds it weakly
            unsafe { item.setTarget(Some(target)) };
            item.setTag(isize::try_from(index).unwrap_or(isize::MAX));
            menu.addItem(&item);
        }
        menu
    }

    fn click(tag: isize) {
        let clicked = STATE.with_borrow(|state| {
            let action = action_for_tag(&state.entries, tag)?;
            Some((action, state.on_click.clone()?))
        });
        // outside the borrow: the callback may set the Dock menu again
        if let Some((action, on_click)) = clicked {
            on_click(action);
        }
    }

    /// Adds `applicationDockMenu:` to `class`, or wraps the one it has. A class
    /// that already carries this module's implementation (itself or through a
    /// superclass) is left alone.
    fn install(class: &AnyClass) {
        let selector = sel!(applicationDockMenu:);
        let existing = class.instance_method(selector);
        let ours: Imp = unsafe { transmute::<DockMenuImp, Imp>(dock_menu) };
        if existing.is_some_and(|method| std::ptr::fn_addr_eq(method.implementation(), ours)) {
            return;
        }
        let previous = existing.map(|method| method.implementation());
        // SAFETY: `ours` has the signature of `applicationDockMenu:`
        // ("@@:@"): a method added to a class is only ever called by the runtime
        let added = unsafe {
            ffi::class_addMethod(
                std::ptr::from_ref(class).cast_mut(),
                selector,
                ours,
                c"@@:@".as_ptr(),
            )
        };
        if !added.as_bool() {
            // The class itself defines the method (class_addMethod does not
            // override), so `existing` is that very method: swizzle it
            if let Some(method) = existing {
                // SAFETY: same signature as the method it replaces
                unsafe { method.set_implementation(ours) };
            }
        }
        STATE.with_borrow_mut(|state| {
            state.hooks.push(Hook {
                class: std::ptr::from_ref(class),
                previous,
            });
        });
    }

    /// The previous implementation for the class of `this`: the nearest hooked
    /// class up its chain owns it
    fn previous_for(class: &AnyClass) -> Option<Imp> {
        STATE.with_borrow(|state| {
            let mut class = Some(class);
            while let Some(current) = class {
                if let Some(hook) = state
                    .hooks
                    .iter()
                    .find(|hook| std::ptr::eq(hook.class, current))
                {
                    return hook.previous;
                }
                class = current.superclass();
            }
            None
        })
    }

    /// The injected `applicationDockMenu:`: the menu when there are entries,
    /// otherwise whatever the delegate answered before (nil by default, which
    /// leaves the system menu)
    unsafe extern "C-unwind" fn dock_menu(
        this: *mut AnyObject,
        cmd: Sel,
        sender: *mut AnyObject,
    ) -> *mut AnyObject {
        let ours = STATE.with_borrow(|state| state.menu.clone());
        if let Some(menu) = ours {
            // AppKit does not retain what the delegate returns past the call
            return Retained::autorelease_ptr(menu).cast();
        }
        // SAFETY: AppKit passes a live delegate
        let class = unsafe { &*this }.class();
        match previous_for(class) {
            Some(previous) => {
                // SAFETY: it is the `applicationDockMenu:` implementation of this class chain
                let previous = unsafe { transmute::<Imp, DockMenuImp>(previous) };
                unsafe { previous(this, cmd, sender) }
            }
            None => std::ptr::null_mut(),
        }
    }

    #[cfg(test)]
    mod tests {
        use objc2::ClassType;
        use objc2::runtime::ClassBuilder;

        use super::*;

        /// What a pre-existing delegate method answers: a marker, not an object
        const OLD_ANSWER: usize = 0x51;

        unsafe extern "C-unwind" fn old_dock_menu(
            _this: *mut AnyObject,
            _cmd: Sel,
            _sender: *mut AnyObject,
        ) -> *mut AnyObject {
            OLD_ANSWER as *mut AnyObject
        }

        fn class(name: &std::ffi::CStr, superclass: &AnyClass, old: bool) -> &'static AnyClass {
            let mut builder = ClassBuilder::new(name, superclass).expect("unique test class name");
            if old {
                // SAFETY: `old_dock_menu` matches `applicationDockMenu:`
                unsafe {
                    builder.add_method(sel!(applicationDockMenu:), old_dock_menu as DockMenuImp);
                }
            }
            builder.register()
        }

        fn ask(class: &AnyClass) -> usize {
            let object: Retained<AnyObject> = unsafe { msg_send![class, new] };
            let answer: *mut AnyObject = unsafe {
                msg_send![&*object, applicationDockMenu: std::ptr::null_mut::<AnyObject>()]
            };
            answer as usize
        }

        #[test]
        fn a_class_without_the_method_answers_nil_without_entries() {
            let class = class(c"DockTestNone", NSObject::class(), false);
            install(class);
            assert_eq!(ask(class), 0);
            // a second install is a no-op
            install(class);
            assert_eq!(STATE.with_borrow(|state| state.hooks.len()), 1);
        }

        #[test]
        fn the_own_method_is_wrapped_and_still_answers_without_entries() {
            let class = class(c"DockTestOwn", NSObject::class(), true);
            assert_eq!(ask(class), OLD_ANSWER);
            install(class);
            assert_eq!(ask(class), OLD_ANSWER);
        }

        #[test]
        fn an_inherited_method_stays_reachable_through_the_subclass() {
            let base = class(c"DockTestBase", NSObject::class(), true);
            let sub = class(c"DockTestSub", base, false);
            install(sub);
            assert_eq!(ask(sub), OLD_ANSWER);
            // the base class was not touched
            assert_eq!(ask(base), OLD_ANSWER);
            assert_eq!(STATE.with_borrow(|state| state.hooks.len()), 1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entries() -> Vec<DockEntry> {
        vec![
            DockEntry {
                label: "Home".into(),
                action: DockAction::Home,
            },
            DockEntry {
                label: "New Document".into(),
                action: DockAction::NewDocument("docx"),
            },
            DockEntry {
                label: "New PDF".into(),
                action: DockAction::NewDocument("pdf"),
            },
        ]
    }

    #[test]
    fn a_tag_is_the_entry_index() {
        let entries = entries();
        assert_eq!(action_for_tag(&entries, 0), Some(DockAction::Home));
        assert_eq!(
            action_for_tag(&entries, 1),
            Some(DockAction::NewDocument("docx"))
        );
        assert_eq!(
            action_for_tag(&entries, 2),
            Some(DockAction::NewDocument("pdf"))
        );
    }

    #[test]
    fn a_tag_outside_the_list_is_nothing() {
        let entries = entries();
        assert_eq!(action_for_tag(&entries, 3), None);
        assert_eq!(action_for_tag(&entries, -1), None);
        assert_eq!(action_for_tag(&[], 0), None);
    }
}
