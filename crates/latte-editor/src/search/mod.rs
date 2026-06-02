pub mod embedder;
pub mod loader;
pub mod rrf;
pub mod store;

pub use embedder::Embedder;
pub use loader::ensure_vss0_loaded;
pub use rrf::fuse as rrf_fuse;
pub use store::{build_embedder, EmbeddingStore};
