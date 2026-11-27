#[cfg(debug_assertions)]
#[global_allocator]
static ALLOCATIONS: ardia_profile::strict::CountingAlloc = ardia_profile::strict::CountingAlloc;

fn main() {
    std::process::exit(ardia_app::run(std::env::args_os()));
}
