use std::path::Path;
fn main() {
    let path = Path::new("SCHEMA_HASH.txt");
    println!("cargo:rerun-if-changed={}", path.display());
    println!("cargo:rerun-if-changed=../../scripts/compute-schema-hash.mjs");
}
