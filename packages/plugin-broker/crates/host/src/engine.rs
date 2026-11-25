use crate::base64;
use crate::channel::Channel;
use crate::governor::Governor;
use crate::timers::Timers;
use crate::url_parse;
use rquickjs_sys as q;
use std::ffi::{c_char, c_int, c_void, CStr};
use std::ptr;
use std::time::Instant;

pub const MAX_EARLY_LINES: usize = 256;
pub const MAX_RANDOM_BYTES: usize = 65536;

pub struct HostState {
    pub channel: Channel,
    pub timers: Timers,
    line_handler: q::JSValue,
    timer_handler: q::JSValue,
    early_lines: Vec<String>,
}

pub struct Thrown {
    pub description: String,
    pub uncatchable: bool,
    pub stack_overflow: bool,
}

pub struct Engine {
    rt: *mut q::JSRuntime,
    ctx: *mut q::JSContext,
    state: Box<HostState>,
    governor: Box<Governor>,
}

unsafe extern "C" fn heap_malloc(opaque: *mut c_void, size: q::size_t) -> *mut c_void {
    let size = size as usize;
    let governor = &*(opaque as *const Governor);
    let heap = &governor.heap;
    if heap.limit != 0 && heap.used.get().saturating_add(size) > heap.limit {
        heap.exhausted.set(true);
        return ptr::null_mut();
    }
    let block = libc::malloc(size);
    if block.is_null() {
        heap.exhausted.set(true);
        return block;
    }
    heap.used.set(heap.used.get() + libc::malloc_usable_size(block));
    heap.peak.set(heap.peak.get().max(heap.used.get()));
    block
}

unsafe extern "C" fn heap_calloc(opaque: *mut c_void, count: q::size_t, size: q::size_t) -> *mut c_void {
    let Some(total) = (count as usize).checked_mul(size as usize) else {
        (*(opaque as *const Governor)).heap.exhausted.set(true);
        return ptr::null_mut();
    };
    let block = heap_malloc(opaque, total as q::size_t);
    if !block.is_null() {
        ptr::write_bytes(block.cast::<u8>(), 0, total);
    }
    block
}

unsafe extern "C" fn heap_free(opaque: *mut c_void, block: *mut c_void) {
    if block.is_null() {
        return;
    }
    let heap = &(*(opaque as *const Governor)).heap;
    heap.used.set(heap.used.get().saturating_sub(libc::malloc_usable_size(block)));
    libc::free(block);
}

unsafe extern "C" fn heap_realloc(opaque: *mut c_void, block: *mut c_void, size: q::size_t) -> *mut c_void {
    let size = size as usize;
    if block.is_null() {
        return heap_malloc(opaque, size as q::size_t);
    }
    let heap = &(*(opaque as *const Governor)).heap;
    let before = libc::malloc_usable_size(block);
    if heap.limit != 0 && size > before && heap.used.get().saturating_add(size - before) > heap.limit {
        heap.exhausted.set(true);
        return ptr::null_mut();
    }
    let moved = libc::realloc(block, size);
    if moved.is_null() {
        if size != 0 {
            heap.exhausted.set(true);
        } else {
            heap.used.set(heap.used.get().saturating_sub(before));
        }
        return moved;
    }
    heap.used.set(heap.used.get().saturating_sub(before) + libc::malloc_usable_size(moved));
    heap.peak.set(heap.peak.get().max(heap.used.get()));
    moved
}

unsafe extern "C" fn heap_usable_size(block: *const c_void) -> q::size_t {
    libc::malloc_usable_size(block as *mut c_void) as q::size_t
}

static MALLOC_FUNCTIONS: q::JSMallocFunctions = q::JSMallocFunctions {
    js_calloc: Some(heap_calloc),
    js_malloc: Some(heap_malloc),
    js_free: Some(heap_free),
    js_realloc: Some(heap_realloc),
    js_malloc_usable_size: Some(heap_usable_size),
};

unsafe extern "C" fn interrupt(_rt: *mut q::JSRuntime, opaque: *mut c_void) -> c_int {
    c_int::from((*(opaque as *const Governor)).should_interrupt())
}

unsafe fn state<'a>(ctx: *mut q::JSContext) -> &'a mut HostState {
    &mut *(q::JS_GetContextOpaque(ctx) as *mut HostState)
}

unsafe fn arg(argc: c_int, argv: *mut q::JSValue, index: usize) -> q::JSValue {
    if (index as c_int) < argc {
        *argv.add(index)
    } else {
        q::JS_UNDEFINED
    }
}

unsafe fn utf16_of(ctx: *mut q::JSContext, value: q::JSValue) -> Option<Vec<u16>> {
    let mut len: q::size_t = 0;
    let units = q::JS_ToCStringLenUTF16(ctx, &mut len, value);
    if units.is_null() {
        return None;
    }
    let copy = std::slice::from_raw_parts(units, len as usize).to_vec();
    q::JS_FreeCStringUTF16(ctx, units);
    Some(copy)
}

unsafe fn string_of(ctx: *mut q::JSContext, value: q::JSValue) -> Option<String> {
    utf16_of(ctx, value).map(|units| String::from_utf16_lossy(&units))
}

unsafe fn new_string(ctx: *mut q::JSContext, text: &str) -> q::JSValue {
    q::JS_NewStringLen(ctx, text.as_ptr().cast(), text.len() as q::size_t)
}

unsafe fn new_bool(value: bool) -> q::JSValue {
    if value {
        q::JS_TRUE
    } else {
        q::JS_FALSE
    }
}

unsafe fn number_of(ctx: *mut q::JSContext, value: q::JSValue) -> Option<f64> {
    let mut out = 0f64;
    (q::JS_ToFloat64(ctx, &mut out, value) == 0).then_some(out)
}

unsafe extern "C" fn native_log(ctx: *mut q::JSContext, _this: q::JSValue, argc: c_int, argv: *mut q::JSValue) -> q::JSValue {
    let Some(level) = string_of(ctx, arg(argc, argv, 0)) else { return q::JS_EXCEPTION };
    let Some(text) = string_of(ctx, arg(argc, argv, 1)) else { return q::JS_EXCEPTION };
    if level == "log" {
        crate::stderr::log(&text);
    } else {
        crate::stderr::log(&format!("[{level}] {text}"));
    }
    q::JS_UNDEFINED
}

unsafe extern "C" fn native_on_line(ctx: *mut q::JSContext, _this: q::JSValue, argc: c_int, argv: *mut q::JSValue) -> q::JSValue {
    let handler = arg(argc, argv, 0);
    let host = state(ctx);
    q::JS_FreeValue(ctx, host.line_handler);
    host.line_handler = q::JS_DupValue(ctx, handler);
    let early = std::mem::take(&mut host.early_lines);
    for line in early {
        let mut argument = new_string(ctx, &line);
        let result = q::JS_Call(ctx, handler, q::JS_UNDEFINED, 1, &mut argument);
        q::JS_FreeValue(ctx, argument);
        if q::JS_IsException(result) {
            return result;
        }
        q::JS_FreeValue(ctx, result);
    }
    q::JS_UNDEFINED
}

unsafe extern "C" fn native_on_timer(ctx: *mut q::JSContext, _this: q::JSValue, argc: c_int, argv: *mut q::JSValue) -> q::JSValue {
    let host = state(ctx);
    q::JS_FreeValue(ctx, host.timer_handler);
    host.timer_handler = q::JS_DupValue(ctx, arg(argc, argv, 0));
    q::JS_UNDEFINED
}

unsafe extern "C" fn native_schedule(ctx: *mut q::JSContext, _this: q::JSValue, argc: c_int, argv: *mut q::JSValue) -> q::JSValue {
    let Some(id) = number_of(ctx, arg(argc, argv, 0)) else { return q::JS_EXCEPTION };
    let Some(ms) = number_of(ctx, arg(argc, argv, 1)) else { return q::JS_EXCEPTION };
    new_bool(state(ctx).timers.schedule(Instant::now(), id, ms).is_ok())
}

unsafe extern "C" fn native_cancel(ctx: *mut q::JSContext, _this: q::JSValue, argc: c_int, argv: *mut q::JSValue) -> q::JSValue {
    let Some(id) = number_of(ctx, arg(argc, argv, 0)) else { return q::JS_EXCEPTION };
    new_bool(state(ctx).timers.cancel(id))
}

unsafe extern "C" fn native_send(ctx: *mut q::JSContext, _this: q::JSValue, argc: c_int, argv: *mut q::JSValue) -> q::JSValue {
    let Some(line) = string_of(ctx, arg(argc, argv, 0)) else { return q::JS_EXCEPTION };
    match state(ctx).channel.send(&line) {
        None => q::JS_NULL,
        Some(refusal) => new_string(ctx, refusal.message()),
    }
}

unsafe extern "C" fn native_btoa(ctx: *mut q::JSContext, _this: q::JSValue, argc: c_int, argv: *mut q::JSValue) -> q::JSValue {
    let Some(units) = utf16_of(ctx, arg(argc, argv, 0)) else { return q::JS_EXCEPTION };
    match base64::btoa(&units) {
        Some(text) => new_string(ctx, &text),
        None => q::JS_NULL,
    }
}

unsafe extern "C" fn native_atob(ctx: *mut q::JSContext, _this: q::JSValue, argc: c_int, argv: *mut q::JSValue) -> q::JSValue {
    let Some(units) = utf16_of(ctx, arg(argc, argv, 0)) else { return q::JS_EXCEPTION };
    match base64::atob(&units) {
        Some(text) => new_string(ctx, &text),
        None => q::JS_NULL,
    }
}

pub fn random_fill(bytes: &mut [u8]) {
    let mut filled = 0;
    while filled < bytes.len() {
        let got = unsafe { libc::getrandom(bytes[filled..].as_mut_ptr().cast(), bytes.len() - filled, 0) };
        if got > 0 {
            filled += got as usize;
        } else if got < 0 && std::io::Error::last_os_error().raw_os_error() != Some(libc::EINTR) {
            crate::host::hard_exit(crate::exit::Exit::SandboxSetup, "getrandom failed, so the plugin host can't make random values");
        }
    }
}

pub fn random_uuid() -> String {
    let mut b = [0u8; 16];
    random_fill(&mut b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let hex: Vec<String> = b.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("{}-{}-{}-{}-{}", hex[0..4].concat(), hex[4..6].concat(), hex[6..8].concat(), hex[8..10].concat(), hex[10..16].concat())
}

unsafe extern "C" fn native_random_uuid(ctx: *mut q::JSContext, _this: q::JSValue, _argc: c_int, _argv: *mut q::JSValue) -> q::JSValue {
    new_string(ctx, &random_uuid())
}

unsafe extern "C" fn native_random_bytes(ctx: *mut q::JSContext, _this: q::JSValue, argc: c_int, argv: *mut q::JSValue) -> q::JSValue {
    let Some(count) = number_of(ctx, arg(argc, argv, 0)) else { return q::JS_EXCEPTION };
    let count = if count.is_finite() { count.max(0.0).min(MAX_RANDOM_BYTES as f64) as usize } else { 0 };
    let mut bytes = vec![0u8; count];
    random_fill(&mut bytes);
    q::JS_NewUint8ArrayCopy(ctx, bytes.as_ptr(), bytes.len() as q::size_t)
}

unsafe fn set_string(ctx: *mut q::JSContext, object: q::JSValue, name: &CStr, value: &str) {
    q::JS_SetPropertyStr(ctx, object, name.as_ptr(), new_string(ctx, value));
}

unsafe extern "C" fn native_parse_url(ctx: *mut q::JSContext, _this: q::JSValue, argc: c_int, argv: *mut q::JSValue) -> q::JSValue {
    let Some(input) = string_of(ctx, arg(argc, argv, 0)) else { return q::JS_EXCEPTION };
    let base_value = arg(argc, argv, 1);
    let base = if q::JS_IsString(base_value) {
        match string_of(ctx, base_value) {
            Some(text) => Some(text),
            None => return q::JS_EXCEPTION,
        }
    } else {
        None
    };
    let Some(parsed) = url_parse::parse(&input, base.as_deref()) else { return q::JS_NULL };
    let object = q::JS_NewObject(ctx);
    if q::JS_IsException(object) {
        return object;
    }
    set_string(ctx, object, c"protocol", &parsed.protocol);
    set_string(ctx, object, c"username", &parsed.username);
    set_string(ctx, object, c"password", &parsed.password);
    set_string(ctx, object, c"hostname", &parsed.hostname);
    set_string(ctx, object, c"port", &parsed.port);
    set_string(ctx, object, c"pathname", &parsed.pathname);
    set_string(ctx, object, c"search", &parsed.search);
    set_string(ctx, object, c"hash", &parsed.hash);
    q::JS_SetPropertyStr(ctx, object, c"authority".as_ptr(), new_bool(parsed.authority));
    q::JS_SetPropertyStr(ctx, object, c"special".as_ptr(), new_bool(parsed.special));
    object
}

type Native = unsafe extern "C" fn(*mut q::JSContext, q::JSValue, c_int, *mut q::JSValue) -> q::JSValue;

pub const NATIVES: [(&str, Native, c_int); 11] = [
    ("log", native_log, 2),
    ("onLine", native_on_line, 1),
    ("onTimer", native_on_timer, 1),
    ("schedule", native_schedule, 2),
    ("cancel", native_cancel, 1),
    ("send", native_send, 1),
    ("btoa", native_btoa, 1),
    ("atob", native_atob, 1),
    ("randomUUID", native_random_uuid, 0),
    ("randomBytes", native_random_bytes, 1),
    ("parseURL", native_parse_url, 2),
];

include!(concat!(env!("OUT_DIR"), "/prelude_hooks.rs"));

const fn same(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut at = 0;
    while at < a.len() {
        if a[at] != b[at] {
            return false;
        }
        at += 1;
    }
    true
}

const fn implements(name: &str) -> bool {
    let mut at = 0;
    while at < NATIVES.len() {
        if same(NATIVES[at].0, name) {
            return true;
        }
        at += 1;
    }
    false
}

const fn prelude_calls(name: &str) -> bool {
    let mut at = 0;
    while at < PRELUDE_HOOKS.len() {
        if same(PRELUDE_HOOKS[at], name) {
            return true;
        }
        at += 1;
    }
    false
}

const fn hooks_match() -> bool {
    let mut at = 0;
    while at < PRELUDE_HOOKS.len() {
        if !implements(PRELUDE_HOOKS[at]) {
            return false;
        }
        at += 1;
    }
    let mut at = 0;
    while at < NATIVES.len() {
        if !prelude_calls(NATIVES[at].0) {
            return false;
        }
        at += 1;
    }
    true
}

const _: () = assert!(hooks_match(), "HostPrelude.swift's native.<hook> set differs from engine::NATIVES; see OUT_DIR/prelude_hooks.rs");

fn nul_terminated(text: &str) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(text.len() + 1);
    bytes.extend_from_slice(text.as_bytes());
    bytes.push(0);
    bytes
}

impl Engine {
    pub fn new(governor: Governor, channel: Channel) -> Result<Engine, String> {
        let governor = Box::new(governor);
        let mut state = Box::new(HostState {
            channel,
            timers: Timers::default(),
            line_handler: q::JS_UNDEFINED,
            timer_handler: q::JS_UNDEFINED,
            early_lines: Vec::new(),
        });
        unsafe {
            let opaque = &*governor as *const Governor as *mut c_void;
            let rt = q::JS_NewRuntime2(&MALLOC_FUNCTIONS, opaque);
            if rt.is_null() {
                return Err("QuickJS couldn't start".into());
            }
            q::JS_SetMaxStackSize(rt, governor.limits.stack_bytes as q::size_t);
            q::JS_SetInterruptHandler(rt, Some(interrupt), opaque);
            q::JS_SetCanBlock(rt, false);
            let ctx = q::JS_NewContext(rt);
            if ctx.is_null() {
                return Err("QuickJS couldn't make a context".into());
            }
            q::JS_SetContextOpaque(ctx, &mut *state as *mut HostState as *mut c_void);
            Ok(Engine { rt, ctx, state, governor })
        }
    }

    pub fn governor(&self) -> &Governor {
        &self.governor
    }

    pub fn host(&mut self) -> &mut HostState {
        &mut self.state
    }

    pub fn update_stack_top(&self) {
        unsafe { q::JS_UpdateStackTop(self.rt) };
    }

    fn thrown(&self) -> Thrown {
        unsafe {
            let exception = q::JS_GetException(self.ctx);
            let uncatchable = q::JS_IsUncatchableError(exception);
            let text = string_of(self.ctx, exception).unwrap_or_else(|| "exception".into());
            let mut stack = String::new();
            if q::JS_IsObject(exception) {
                let value = q::JS_GetPropertyStr(self.ctx, exception, c"stack".as_ptr());
                if q::JS_IsString(value) {
                    stack = string_of(self.ctx, value).unwrap_or_default();
                } else if q::JS_IsException(value) {
                    q::JS_FreeValue(self.ctx, q::JS_GetException(self.ctx));
                }
                q::JS_FreeValue(self.ctx, value);
            }
            q::JS_FreeValue(self.ctx, exception);
            let stack_overflow = text.contains("Maximum call stack size exceeded") || text.contains("stack overflow");
            let description = if stack.trim().is_empty() { format!("Uncaught {text}") } else { format!("Uncaught {text}\n{}", stack.trim_end()) };
            Thrown { description, uncatchable, stack_overflow }
        }
    }

    fn settle(&self, value: q::JSValue) -> Result<q::JSValue, Thrown> {
        if unsafe { q::JS_IsException(value) } {
            return Err(self.thrown());
        }
        Ok(value)
    }

    pub fn eval_global(&self, source: &str, filename: &str) -> Result<(), Thrown> {
        let code = nul_terminated(source);
        let name = std::ffi::CString::new(filename.replace('\0', "")).unwrap_or_default();
        let value = unsafe { q::JS_Eval(self.ctx, code.as_ptr() as *const c_char, source.len() as q::size_t, name.as_ptr(), q::JS_EVAL_TYPE_GLOBAL as c_int) };
        let value = self.settle(value)?;
        unsafe { q::JS_FreeValue(self.ctx, value) };
        Ok(())
    }

    pub fn install_prelude(&self, prelude: &str) -> Result<(), Thrown> {
        let code = nul_terminated(prelude);
        unsafe {
            let installer = self.settle(q::JS_Eval(
                self.ctx,
                code.as_ptr() as *const c_char,
                prelude.len() as q::size_t,
                c"ardia://plugin-host/prelude.js".as_ptr(),
                q::JS_EVAL_TYPE_GLOBAL as c_int,
            ))?;
            let native = self.native_object(&NATIVES);
            self.call_installer(installer, native)?;
        }
        Ok(())
    }

    unsafe fn native_object(&self, functions: &[(&str, Native, c_int)]) -> q::JSValue {
        let object = q::JS_NewObject(self.ctx);
        for (name, function, length) in functions {
            let name = std::ffi::CString::new(*name).unwrap_or_default();
            let value = q::JS_NewCFunction2(self.ctx, Some(*function), name.as_ptr(), *length, q::JSCFunctionEnum_JS_CFUNC_generic, 0);
            q::JS_SetPropertyStr(self.ctx, object, name.as_ptr(), value);
        }
        object
    }

    unsafe fn call_installer(&self, installer: q::JSValue, mut native: q::JSValue) -> Result<(), Thrown> {
        if !q::JS_IsFunction(self.ctx, installer) {
            q::JS_FreeValue(self.ctx, installer);
            q::JS_FreeValue(self.ctx, native);
            return Err(Thrown { description: "an installer didn't evaluate to a function".into(), uncatchable: false, stack_overflow: false });
        }
        let result = q::JS_Call(self.ctx, installer, q::JS_UNDEFINED, 1, &mut native);
        q::JS_FreeValue(self.ctx, native);
        q::JS_FreeValue(self.ctx, installer);
        let result = self.settle(result)?;
        q::JS_FreeValue(self.ctx, result);
        Ok(())
    }

    fn call_handler(&self, handler: q::JSValue, mut argument: q::JSValue) -> Result<(), Thrown> {
        unsafe {
            if !q::JS_IsFunction(self.ctx, handler) {
                q::JS_FreeValue(self.ctx, argument);
                return Ok(());
            }
            let handler = q::JS_DupValue(self.ctx, handler);
            let result = q::JS_Call(self.ctx, handler, q::JS_UNDEFINED, 1, &mut argument);
            q::JS_FreeValue(self.ctx, handler);
            q::JS_FreeValue(self.ctx, argument);
            let result = self.settle(result)?;
            q::JS_FreeValue(self.ctx, result);
        }
        Ok(())
    }

    pub fn deliver_line(&mut self, line: String) -> Result<(), Thrown> {
        let handler = self.state.line_handler;
        if unsafe { q::JS_IsUndefined(handler) } {
            if self.state.early_lines.len() < MAX_EARLY_LINES {
                self.state.early_lines.push(line);
            }
            return Ok(());
        }
        let argument = unsafe { new_string(self.ctx, &line) };
        drop(line);
        self.call_handler(handler, argument)
    }

    pub fn fire_timer(&mut self, id: f64) -> Result<(), Thrown> {
        let handler = self.state.timer_handler;
        self.call_handler(handler, q::JS_NewFloat64(id))
    }

    pub fn drain_jobs(&self) -> Vec<Thrown> {
        let mut failures = Vec::new();
        loop {
            let mut job_ctx: *mut q::JSContext = ptr::null_mut();
            let ran = unsafe { q::JS_ExecutePendingJob(self.rt, &mut job_ctx) };
            if ran == 0 {
                break;
            }
            if ran < 0 {
                let thrown = self.thrown();
                let stop = thrown.uncatchable;
                failures.push(thrown);
                if stop || self.governor.reason().is_some() {
                    break;
                }
            }
        }
        failures
    }

    pub fn heap_peak(&self) -> usize {
        self.governor.heap.peak.get()
    }
}
