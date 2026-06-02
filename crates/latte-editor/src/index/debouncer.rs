use std::time::Duration;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use std::sync::Arc;

/// Coalescing debouncer: only the most recently `arm()`-ed work runs to
/// completion; every earlier `arm()` is cancelled.
///
/// Cancellation is done by aborting the spawned task's `JoinHandle`. The
/// previous version routed cancel through a `oneshot::Sender`, which
/// required the cancelled task to be polled (and the `select!` arm to
/// see the value) before the next sleep fired. Under load — e.g. the
/// `only_last_arm_runs` proptest with `n=19` — the runtime could not
/// schedule the cancelled task in time and a stale arm's work ran.
/// `JoinHandle::abort` is synchronous and takes effect immediately.
pub struct Debouncer {
    inner: Arc<Mutex<Option<JoinHandle<()>>>>,
    delay: Duration,
}

impl Debouncer {
    pub fn new(delay: Duration) -> Self { Self { inner: Arc::new(Mutex::new(None)), delay } }
    pub async fn arm<F, Fut>(&self, work: F)
    where F: FnOnce() -> Fut + Send + 'static,
          Fut: std::future::Future<Output = ()> + Send,
    {
        // cancel previous, then start a fresh arm — all under the lock so
        // a concurrent arm cannot interleave between abort and spawn.
        let mut g = self.inner.lock().await;
        if let Some(h) = g.take() { h.abort(); }
        let delay = self.delay;
        let handle = tokio::spawn(async move {
            tokio::time::sleep(delay).await;
            work().await;
        });
        *g = Some(handle);
    }
}
