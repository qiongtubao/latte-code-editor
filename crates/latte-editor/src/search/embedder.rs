use fastembed::{EmbeddingModel, InitOptions, TextEmbedding};

/// Thin wrapper around fastembed's `TextEmbedding` pinned to the
/// BGE-small-zh-v1.5 model (512-dim, Chinese + English).
///
/// `Embedder::new` lazily downloads the model (~50 MB) on first call and
/// caches it in `~/.cache/fastembed` (or `$FASTEMBED_CACHE_DIR`). Subsequent
/// inits are essentially free.
///
/// NOTE on API deviation from the T20 plan: fastembed 5.x's
/// `TextEmbedding::embed` takes `&mut self` (it threads batch state through
/// the session). We mirror that here so callers don't have to do interior
/// mutability gymnastics. T21 should plan to hold the `Embedder` behind a
/// `Mutex` (or take `&mut Embedder` through whatever async path it uses).
pub struct Embedder {
    inner: TextEmbedding,
    dim: usize,
}

impl Embedder {
    pub fn new() -> Result<Self, String> {
        let opts = InitOptions::new(EmbeddingModel::BGESmallZHV15)
            .with_show_download_progress(false);
        let inner = TextEmbedding::try_new(opts).map_err(|e| e.to_string())?;
        Ok(Self { inner, dim: 512 })
    }

    pub fn dim(&self) -> usize {
        self.dim
    }

    pub fn embed(&mut self, texts: &[&str]) -> Result<Vec<Vec<f32>>, String> {
        self.inner
            .embed(texts.to_vec(), None)
            .map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::Embedder;

    /// Smoke test for the embedder. The first run downloads the BGE-small-zh
    /// model (~50 MB) into the local HF Hub cache, so this is `#[ignore]`-gated
    /// to keep CI fast and offline. Run manually with:
    ///
    ///   cargo test -p latte-editor embedder -- --ignored
    #[test]
    #[ignore]
    fn embeds_known_phrase() {
        let mut e = Embedder::new().unwrap();
        let v = e.embed(&["登录验证函数"]).unwrap();
        assert_eq!(v[0].len(), 512);
    }
}
