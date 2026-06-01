use crate::{
    db::GraphDb,
    error::AdapterError,
    model::{Location, Neighbor, Reference},
};
use rusqlite::params;

pub fn definition(db: &GraphDb, symbol: &str) -> Result<Option<Location>, AdapterError> {
    let mut stmt = db.conn().prepare(
        "SELECT file, line, col FROM nodes WHERE name = ?1 AND kind IN ('function','class','method','variable') ORDER BY (kind = 'function') DESC LIMIT 1"
    )?;
    let mut rows = stmt.query(params![symbol])?;
    if let Some(r) = rows.next()? {
        Ok(Some(Location {
            file: r.get(0)?,
            line: r.get(1)?,
            col: r.get(2)?,
        }))
    } else {
        Ok(None)
    }
}

pub fn references(
    db: &GraphDb,
    symbol: &str,
    limit: u32,
) -> Result<Vec<Reference>, AdapterError> {
    let mut stmt = db.conn().prepare(
        "SELECT e.kind, n2.file, n2.line, n2.col
         FROM edges e JOIN nodes n1 ON n1.id = e.from_node
                       JOIN nodes n2 ON n2.id = e.to_node
         WHERE n1.name = ?1 LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![symbol, limit], |r| {
        Ok(Reference {
            kind: r.get(0)?,
            location: Location {
                file: r.get(1)?,
                line: r.get(2)?,
                col: r.get(3)?,
            },
        })
    })?;
    Ok(rows.filter_map(Result::ok).collect())
}

pub fn neighbors(db: &GraphDb, node_id: &str, depth: u32) -> Result<Vec<Neighbor>, AdapterError> {
    let mut stmt = db.conn().prepare(
        "WITH RECURSIVE walk(id, depth) AS (
            SELECT ?1, 0 UNION ALL SELECT e.to_node, walk.depth+1 FROM walk
            JOIN edges e ON e.from_node = walk.id WHERE walk.depth < ?2
        ) SELECT DISTINCT n.id, n.name, n.kind FROM walk JOIN nodes n ON n.id = walk.id
        WHERE walk.depth > 0",
    )?;
    let rows = stmt.query_map(params![node_id, depth], |r| {
        Ok(Neighbor {
            node_id: r.get(0)?,
            name: r.get(1)?,
            kind: r.get(2)?,
            edge: "edge".into(),
        })
    })?;
    Ok(rows.filter_map(Result::ok).collect())
}
