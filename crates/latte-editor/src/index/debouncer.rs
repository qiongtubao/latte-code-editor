use std::time::Duration;
use tokio::sync::{oneshot, Mutex};
use std::sync::Arc;

pub struct Debouncer {
    inner: Arc<Mutex<Option<oneshot::Sender<()>>>>,
    delay: Duration,
}

impl Debouncer {
    pub fn new(delay: Duration) -> Self { Self { inner: Arc::new(Mutex::new(None)), delay } }
    pub async fn arm<F, Fut>(&self, work: F)
    where F: FnOnce() -> Fut + Send + 'static,
          Fut: std::future::Future<Output = ()> + Send,
    {
        // cancel previous
        let mut g = self.inner.lock().await;
        if let Some(tx) = g.take() { let _ = tx.send(()); }
        let (tx, mut rx) = oneshot::channel::<()>();
        *g = Some(tx);
        drop(g);

        let delay = self.delay;
        tokio::spawn(async move {
            tokio::select! {
                _ = &mut rx => { /* cancelled */ },
                _ = tokio::time::sleep(delay) => { work().await; }
            }
        });
    }
}
