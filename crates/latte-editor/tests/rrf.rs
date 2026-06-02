use latte_editor::search::rrf_fuse;
use proptest::prelude::*;

proptest! {
    #[test]
    fn rrf_combines_lists_consistently(a in prop::collection::vec(0u64..100, 1..20),
                                        b in prop::collection::vec(0u64..100, 1..20)) {
        let fused = rrf_fuse(&[a.clone(), b.clone()], 60.0);
        // No duplicates
        let ids: std::collections::HashSet<_> = fused.iter().map(|(i,_)| *i).collect();
        prop_assert_eq!(ids.len(), fused.len());
        // All items present
        for x in a.iter().chain(b.iter()) { prop_assert!(ids.contains(x)); }
    }

    #[test]
    fn rrf_single_list_preserves_order_and_scores(a in prop::collection::vec(0u64..100, 1..20)) {
        // Deduplicate input preserving first-occurrence order. With unique
        // ranks the single-list score for the i-th input id is exactly
        // 1/(k + i + 1), so the output must appear in the same order.
        let mut seen = std::collections::HashSet::new();
        let a: Vec<u64> = a.into_iter().filter(|x| seen.insert(*x)).collect();

        let fused = rrf_fuse(&[a.clone()], 60.0);
        // Output length matches the (deduped) input length and order is preserved.
        prop_assert_eq!(fused.len(), a.len());
        for (i, (id, _)) in fused.iter().enumerate() {
            prop_assert_eq!(*id, a[i]);
        }
        // Score equals 1/(k + i + 1) for every i.
        for (i, (_, score)) in fused.iter().enumerate() {
            let expected = 1.0 / (60.0 + i as f32 + 1.0);
            prop_assert!(
                (score - expected).abs() < 1e-6,
                "expected {} got {} at rank {}", expected, score, i
            );
        }
    }
}
