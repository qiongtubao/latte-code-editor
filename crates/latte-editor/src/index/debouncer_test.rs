use crate::index::Debouncer;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use proptest::prelude::*;

proptest! {
    #[test]
    fn only_last_arm_runs(n in 1usize..20) {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let runs = Arc::new(AtomicUsize::new(0));
            let d = Debouncer::new(Duration::from_millis(10));
            for _ in 0..n {
                let runs = runs.clone();
                d.arm(|| async move {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                    runs.fetch_add(1, Ordering::SeqCst);
                }).await;
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
            // only the last should run
            prop_assert_eq!(runs.load(Ordering::SeqCst), 1);
            Ok(())
        })?;
    }
}
