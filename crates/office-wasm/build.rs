//! The wasm build's stack: 8 MiB instead of the linker's 1 MiB, which a
//! request of about 2,400 levels of JSON overflowed (reading one level takes
//! some 400 bytes of it, and the engine's own recursion more). An overflow
//! leaves the instance unusable; `MAX_ARGUMENT_DEPTH` in lib.rs refuses a
//! deeper request before anything recursive runs.
fn main() {
    if std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() == Ok("wasm32") {
        println!("cargo:rustc-link-arg=-zstack-size=8388608");
    }
}
