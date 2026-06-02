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
}
