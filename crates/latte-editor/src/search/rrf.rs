/// Reciprocal Rank Fusion: score(d) = Σ 1/(k + rank(d))
pub fn fuse(rankings: &[Vec<u64>], k: f32) -> Vec<(u64, f32)> {
    let mut scores: std::collections::HashMap<u64, f32> = Default::default();
    for list in rankings {
        for (i, id) in list.iter().enumerate() {
            *scores.entry(*id).or_default() += 1.0 / (k + i as f32 + 1.0);
        }
    }
    let mut v: Vec<_> = scores.into_iter().collect();
    v.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
    v
}
