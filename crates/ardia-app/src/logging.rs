use std::sync::Once;

pub const LOG_ENV: &str = "ARDIA_LOG";

pub fn init() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let filter = std::env::var(LOG_ENV)
            .or_else(|_| std::env::var("RUST_LOG"))
            .unwrap_or_else(|_| "info,gpui=warn,naga=warn,wgpu=warn".to_owned());
        let _ = env_logger::Builder::new()
            .parse_filters(&filter)
            .format_timestamp_millis()
            .try_init();
    });
}
