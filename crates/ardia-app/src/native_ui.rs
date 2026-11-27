use ardia_ui::NativeMenuItem;

#[cfg(target_os = "macos")]
mod mac {
    use std::cell::{Cell, RefCell};

    use ardia_ui::NativeMenuItem;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, NSObject};
    use objc2::{MainThreadMarker, MainThreadOnly, define_class, msg_send, sel};
    use objc2_app_kit::{
        NSBitmapImageFileType, NSBitmapImageRep, NSControlStateValueOff, NSControlStateValueOn,
        NSEvent, NSEventModifierFlags, NSImage, NSMenu, NSMenuItem, NSWorkspace,
    };
    use objc2_foundation::{NSDictionary, NSFileManager, NSSize, NSString, NSURL};
    use objc2_uniform_type_identifiers::UTType;

    thread_local! {
        static CHOSEN: Cell<isize> = const { Cell::new(-1) };
        static TARGET: RefCell<Option<Retained<MenuChoice>>> = const { RefCell::new(None) };
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "ArdiaGpuiMenuChoice"]
        struct MenuChoice;

        impl MenuChoice {
            #[unsafe(method(choose:))]
            fn choose(&self, sender: &NSMenuItem) {
                CHOSEN.with(|chosen| chosen.set(sender.tag()));
            }
        }
    );

    impl MenuChoice {
        fn new(mtm: MainThreadMarker) -> Retained<Self> {
            unsafe { msg_send![Self::alloc(mtm), init] }
        }
    }

    fn target(mtm: MainThreadMarker) -> Retained<MenuChoice> {
        TARGET.with(|target| {
            target
                .borrow_mut()
                .get_or_insert_with(|| MenuChoice::new(mtm))
                .clone()
        })
    }

    fn build(
        items: &[NativeMenuItem],
        ids: &mut Vec<String>,
        choice: &MenuChoice,
        mtm: MainThreadMarker,
    ) -> Retained<NSMenu> {
        let menu = NSMenu::new(mtm);
        menu.setAutoenablesItems(false);
        for item in items {
            if item.separator {
                menu.addItem(&NSMenuItem::separatorItem(mtm));
                continue;
            }
            let title = NSString::from_str(&item.title);
            let entry = unsafe {
                NSMenuItem::initWithTitle_action_keyEquivalent(
                    NSMenuItem::alloc(mtm),
                    &title,
                    None,
                    &NSString::from_str(&item.key),
                )
            };
            let mask = modifier_mask(&item.modifiers);
            if !mask.is_empty() {
                entry.setKeyEquivalentModifierMask(mask);
            } else if item.alternate {
                entry.setKeyEquivalentModifierMask(NSEventModifierFlags::Option);
            }
            if item.children.is_empty() {
                unsafe {
                    entry.setAction(Some(sel!(choose:)));
                    entry.setTarget(Some(choice as &AnyObject));
                }
                entry.setTag(ids.len() as isize);
                ids.push(item.id.clone());
            } else {
                let submenu = build(&item.children, ids, choice, mtm);
                entry.setSubmenu(Some(&submenu));
            }
            entry.setAlternate(item.alternate);
            entry.setEnabled(item.enabled);
            entry.setState(if item.checked {
                NSControlStateValueOn
            } else {
                NSControlStateValueOff
            });
            let image = match (item.symbol.as_deref(), item.swatch) {
                (Some(symbol), _) => NSImage::imageWithSystemSymbolName_accessibilityDescription(
                    &NSString::from_str(symbol),
                    None,
                ),
                (None, Some(rgb)) => crate::menu_swatch::image(rgb),
                (None, None) => None,
            };
            if let Some(image) = image.as_deref() {
                entry.setImage(Some(image));
                keep_image_visible(&entry);
            }
            menu.addItem(&entry);
        }
        menu
    }

    fn modifier_mask(names: &[String]) -> NSEventModifierFlags {
        let mut mask = NSEventModifierFlags::empty();
        for name in names {
            mask |= match name.as_str() {
                "control" => NSEventModifierFlags::Control,
                "option" => NSEventModifierFlags::Option,
                "shift" => NSEventModifierFlags::Shift,
                "command" => NSEventModifierFlags::Command,
                "function" => NSEventModifierFlags::Function,
                _ => NSEventModifierFlags::empty(),
            };
        }
        mask
    }

    fn keep_image_visible(entry: &NSMenuItem) {
        let visibility = sel!(setPreferredImageVisibility:);
        let responds: bool = unsafe { msg_send![entry, respondsToSelector: visibility] };
        if responds {
            let visible: isize = 1;
            let _: () = unsafe { msg_send![entry, setPreferredImageVisibility: visible] };
        }
    }

    pub fn popup(items: &[NativeMenuItem]) -> Option<String> {
        let mtm = MainThreadMarker::new()?;
        let choice = target(mtm);
        let mut ids = Vec::new();
        let menu = build(items, &mut ids, &choice, mtm);
        CHOSEN.with(|chosen| chosen.set(-1));
        let location = NSEvent::mouseLocation();
        menu.popUpMenuPositioningItem_atLocation_inView(None, location, None);
        let chosen = CHOSEN.with(Cell::get);
        usize::try_from(chosen)
            .ok()
            .and_then(|at| ids.get(at).cloned())
    }

    pub fn file_icon_png(path: &str, points: f64) -> Option<Vec<u8>> {
        MainThreadMarker::new()?;
        let workspace = NSWorkspace::sharedWorkspace();
        let ns_path = NSString::from_str(path);
        let exists = NSFileManager::defaultManager().fileExistsAtPath(&ns_path);
        let icon = if exists {
            workspace.iconForFile(&ns_path)
        } else {
            let extension = std::path::Path::new(path)
                .extension()
                .and_then(|ext| ext.to_str())
                .unwrap_or("");
            let kind = UTType::typeWithFilenameExtension(&NSString::from_str(extension))
                .or_else(|| UTType::typeWithIdentifier(&NSString::from_str("public.data")))?;
            workspace.iconForContentType(&kind)
        };
        icon.setSize(NSSize::new(points * 2.0, points * 2.0));
        let tiff = icon.TIFFRepresentation()?;
        let bitmap = NSBitmapImageRep::imageRepWithData(&tiff)?;
        let properties = NSDictionary::new();
        let png = unsafe {
            bitmap.representationUsingType_properties(NSBitmapImageFileType::PNG, &properties)
        }?;
        Some(png.to_vec())
    }

    pub fn move_to_trash(path: &str) -> bool {
        let manager = NSFileManager::defaultManager();
        let ns_path = NSString::from_str(path);
        if !manager.fileExistsAtPath(&ns_path) {
            return false;
        }
        let url = NSURL::fileURLWithPath(&ns_path);
        manager
            .trashItemAtURL_resultingItemURL_error(&url, None)
            .is_ok()
    }
}

#[cfg(target_os = "macos")]
pub fn popup_menu(items: &[NativeMenuItem]) -> Option<String> {
    mac::popup(items)
}

#[cfg(not(target_os = "macos"))]
pub fn popup_menu(items: &[NativeMenuItem]) -> Option<String> {
    let _ = items;
    None
}

#[cfg(target_os = "macos")]
pub fn file_icon_png(path: &str, points: f64) -> Option<Vec<u8>> {
    mac::file_icon_png(path, points)
}

#[cfg(not(target_os = "macos"))]
pub fn file_icon_png(path: &str, points: f64) -> Option<Vec<u8>> {
    let _ = (path, points);
    None
}

#[cfg(target_os = "macos")]
pub fn move_to_trash(path: &str) -> bool {
    mac::move_to_trash(path)
}

#[cfg(not(target_os = "macos"))]
pub fn move_to_trash(path: &str) -> bool {
    let _ = path;
    false
}
