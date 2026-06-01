use serde::Serialize;

#[derive(Debug, Serialize, Clone)]
pub struct Location {
    pub file: String,
    pub line: u32,
    pub col: u32,
}

#[derive(Debug, Serialize, Clone)]
pub struct Reference {
    pub kind: String, // 'def' | 'ref' | 'call' | 'import'
    pub location: Location,
}

#[derive(Debug, Serialize, Clone)]
pub struct Neighbor {
    pub node_id: String,
    pub name: String,
    pub kind: String,
    pub edge: String,
}
