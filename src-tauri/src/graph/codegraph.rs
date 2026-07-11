use rusqlite::{Connection, params};
use serde::Serialize;
use std::path::Path;

/// A node in the code graph
#[derive(Debug, Clone, Serialize)]
pub struct GraphNode {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub qualified_name: String,
    pub file_path: String,
    pub language: String,
    pub start_line: u32,
    pub end_line: u32,
    pub signature: Option<String>,
}

/// An edge between two nodes
#[derive(Debug, Clone, Serialize)]
pub struct GraphEdge {
    pub id: String,
    pub source: String,
    pub target: String,
    pub kind: String,
    pub metadata: Option<String>,
}

/// The full graph data returned to frontend
#[derive(Debug, Clone, Serialize)]
pub struct GraphData {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    pub stats: GraphStats,
}

#[derive(Debug, Clone, Serialize)]
pub struct GraphStats {
    pub total_nodes: usize,
    pub total_edges: usize,
    pub node_kinds: Vec<NodeKindCount>,
    pub edge_kinds: Vec<EdgeKindCount>,
}

#[derive(Debug, Clone, Serialize)]
pub struct NodeKindCount {
    pub kind: String,
    pub count: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct EdgeKindCount {
    pub kind: String,
    pub count: usize,
}

/// Open a codegraph database and return graph data
pub fn load_graph(graph_dir: &Path) -> Result<GraphData, String> {
    let db_path = graph_dir.join("graph.db");
    if !db_path.exists() {
        return Err(format!("Graph database not found at: {}", db_path.display()));
    }

    let conn = Connection::open(&db_path)
        .map_err(|e| format!("Cannot open graph database: {}", e))?;

    // Quick schema validation — check nodes table has qualified_name column
    if conn
        .query_row("SELECT qualified_name FROM nodes LIMIT 1", [], |_| Ok(()))
        .is_err()
    {
        // Table might be empty, so check the column exists in pragma
        let has_col: bool = conn
            .prepare("SELECT qualified_name FROM nodes WHERE 1=0")
            .is_ok();
        if !has_col {
            return Err("Graph database has stale schema (missing qualified_name). Rebuild the graph.".to_string());
        }
    }

    // Query all nodes
    let mut stmt = conn
        .prepare(
            "SELECT id, kind, name, qualified_name, file_path, language, \
             start_line, end_line, signature \
             FROM nodes ORDER BY kind, name",
        )
        .map_err(|e| format!("Cannot prepare node query: {}", e))?;
    let nodes: Vec<GraphNode> = stmt
        .query_map([], |row| {
            Ok(GraphNode {
                id: row.get(0)?,
                kind: row.get(1)?,
                name: row.get(2)?,
                qualified_name: row.get(3)?,
                file_path: row.get(4)?,
                language: row.get(5)?,
                start_line: row.get::<_, i32>(6)? as u32,
                end_line: row.get::<_, i32>(7)? as u32,
                signature: row.get(8)?,
            })
        })
        .map_err(|e| format!("Cannot query nodes: {}", e))?
        .filter_map(|r| r.ok())
        .collect();

    // Query all edges
    let mut edge_stmt = conn
        .prepare(
            "SELECT id, source, target, kind, metadata FROM edges ORDER BY kind",
        )
        .map_err(|e| format!("Cannot prepare edge query: {}", e))?;

    let edges: Vec<GraphEdge> = edge_stmt
        .query_map([], |row| {
            Ok(GraphEdge {
                id: row.get::<_, String>(0)?,
                source: row.get(1)?,
                target: row.get(2)?,
                kind: row.get(3)?,
                metadata: row.get(4)?,
            })
        })
        .map_err(|e| format!("Cannot query edges: {}", e))?
        .filter_map(|r| r.ok())
        .collect();

    // Node kind statistics
    let mut kind_stmt = conn
        .prepare("SELECT kind, COUNT(*) as cnt FROM nodes GROUP BY kind ORDER BY cnt DESC")
        .map_err(|e| format!("Cannot prepare kind stats: {}", e))?;

    let node_kinds: Vec<NodeKindCount> = kind_stmt
        .query_map([], |row| {
            Ok(NodeKindCount {
                kind: row.get(0)?,
                count: row.get::<_, i64>(1)? as usize,
            })
        })
        .map_err(|e| format!("Cannot query kind stats: {}", e))?
        .filter_map(|r| r.ok())
        .collect();

    // Edge kind statistics
    let mut ekind_stmt = conn
        .prepare("SELECT kind, COUNT(*) as cnt FROM edges GROUP BY kind ORDER BY cnt DESC")
        .map_err(|e| format!("Cannot prepare edge kind stats: {}", e))?;

    let edge_kinds: Vec<EdgeKindCount> = ekind_stmt
        .query_map([], |row| {
            Ok(EdgeKindCount {
                kind: row.get(0)?,
                count: row.get::<_, i64>(1)? as usize,
            })
        })
        .map_err(|e| format!("Cannot query edge kind stats: {}", e))?
        .filter_map(|r| r.ok())
        .collect();

    let stats = GraphStats {
        total_nodes: nodes.len(),
        total_edges: edges.len(),
        node_kinds,
        edge_kinds,
    };

    Ok(GraphData { nodes, edges, stats })
}

/// Find nodes matching a search query
pub fn search_nodes(graph_dir: &Path, query: &str, limit: usize) -> Result<Vec<GraphNode>, String> {
    let db_path = graph_dir.join("graph.db");
    if !db_path.exists() {
        return Err("Graph database not found".to_string());
    }

    let conn = Connection::open(&db_path)
        .map_err(|e| format!("Cannot open database: {}", e))?;

    let pattern = format!("%{}%", query);
    let mut stmt = conn
        .prepare(
            "SELECT id, kind, name, qualified_name, file_path, language, \
             start_line, end_line, signature FROM nodes \
             WHERE name LIKE ?1 OR qualified_name LIKE ?1 OR file_path LIKE ?1 \
             LIMIT ?2",
        )
        .map_err(|e| format!("Cannot prepare search: {}", e))?;

    let nodes: Vec<GraphNode> = stmt
        .query_map(params![pattern, limit as i64], |row| {
            Ok(GraphNode {
                id: row.get(0)?,
                kind: row.get(1)?,
                name: row.get(2)?,
                qualified_name: row.get(3)?,
                file_path: row.get(4)?,
                language: row.get(5)?,
                start_line: row.get::<_, i32>(6)? as u32,
                end_line: row.get::<_, i32>(7)? as u32,
                signature: row.get(8)?,
            })
        })
        .map_err(|e| format!("Cannot search: {}", e))?
        .filter_map(|r| r.ok())
        .collect();

    Ok(nodes)
}
/// Find definition nodes with caller-file awareness.
/// `caller_path` = the file the user is currently viewing; results in the caller's
/// file rank first. Short names (len ≤ 3) skip LIKE entirely to avoid noise.
pub fn find_definitions(
    graph_dir: &Path,
    name: &str,
    caller_path: &str,
    limit: usize,
) -> Result<Vec<GraphNode>, String> {
    let db_path = graph_dir.join("graph.db");
    if !db_path.exists() {
        return Err("Graph database not found".to_string());
    }

    let conn = Connection::open(&db_path)
        .map_err(|e| format!("Cannot open database: {}", e))?;

    let pattern = format!("%{}%", name);
    // Short names (≤3 chars) skip LIKE to avoid noise.
    let allow_like: i32 = if name.len() >= 4 { 1 } else { 0 };
    // Compute caller directory prefix for same-tree prioritization.
    // E.g. caller_path = "8.x/src/aof.c" → caller_dir_pattern = "8.x/src/%"
    let caller_dir_pattern = std::path::Path::new(caller_path)
        .parent()
        .and_then(|p| {
            let s = p.to_str().unwrap_or("");
            if s.is_empty() { None } else { Some(format!("{}/%", s)) }
        })
        .unwrap_or_default();
    let mut stmt = conn
        .prepare(
            "SELECT id, kind, name, qualified_name, file_path, language, \
             start_line, end_line, signature FROM nodes \
             WHERE kind NOT IN ('file', 'import', 'export') \
               AND (name = ?1 OR qualified_name = ?1 \
                    OR (?5 = 1 AND (name LIKE ?3 OR qualified_name LIKE ?3))) \
             ORDER BY \
               CASE WHEN file_path = ?4 THEN 0 ELSE 1 END, \
               CASE WHEN ?6 != '' AND file_path LIKE ?6 THEN 0 ELSE 1 END, \
               CASE \
                 WHEN file_path LIKE '%/bench%' \
                   OR file_path LIKE '%/test%' \
                   OR file_path LIKE '%/example%' \
                   OR file_path LIKE '%/deps%' THEN 1 \
                 ELSE 0 \
               END, \
               CASE \
                 WHEN name = ?1 THEN 0 \
                 WHEN qualified_name = ?1 THEN 1 \
                 ELSE 2 \
               END, \
               CASE kind \
                 WHEN 'class' THEN 0 WHEN 'interface' THEN 1 WHEN 'trait' THEN 2 \
                 WHEN 'struct' THEN 3 WHEN 'enum' THEN 4 WHEN 'type' THEN 5 \
                 WHEN 'type_alias' THEN 6 WHEN 'function' THEN 7 \
                 WHEN 'method' THEN 8 WHEN 'constant' THEN 9 WHEN 'variable' THEN 10 \
                 ELSE 99 \
               END, \
             start_line ASC \
             LIMIT ?2",
        )
        .map_err(|e| format!("Cannot prepare definitions query: {}", e))?;

    let nodes: Vec<GraphNode> = stmt
        .query_map(params![name, limit as i64, pattern, caller_path, allow_like, caller_dir_pattern], |row| {
            Ok(GraphNode {
                id: row.get(0)?,
                kind: row.get(1)?,
                name: row.get(2)?,
                qualified_name: row.get(3)?,
                file_path: row.get(4)?,
                language: row.get(5)?,
                start_line: row.get::<_, i32>(6)? as u32,
                end_line: row.get::<_, i32>(7)? as u32,
                signature: row.get(8)?,
            })
        })
        .map_err(|e| format!("Cannot query definitions: {}", e))?
        .filter_map(|r| r.ok())
        .collect();

    Ok(nodes)
}

/// Get subgraph around a specific node (neighbors up to depth)
pub fn get_subgraph(
    graph_dir: &Path,
    node_id: &str,
    _depth: u32,
) -> Result<GraphData, String> {
    let db_path = graph_dir.join("graph.db");
    if !db_path.exists() {
        return Err("Graph database not found".to_string());
    }

    let conn = Connection::open(&db_path)
        .map_err(|e| format!("Cannot open database: {}", e))?;

    // Get the central node first
    let mut node_stmt = conn
        .prepare(
            "SELECT id, kind, name, qualified_name, file_path, language, \
             start_line, end_line, signature FROM nodes WHERE id = ?1",
        )
        .map_err(|e| format!("Cannot prepare node query: {}", e))?;

    let central: Option<GraphNode> = node_stmt
        .query_map(params![node_id], |row| {
            Ok(GraphNode {
                id: row.get(0)?,
                kind: row.get(1)?,
                name: row.get(2)?,
                qualified_name: row.get(3)?,
                file_path: row.get(4)?,
                language: row.get(5)?,
                start_line: row.get::<_, i32>(6)? as u32,
                end_line: row.get::<_, i32>(7)? as u32,
                signature: row.get(8)?,
            })
        })
        .map_err(|e| format!("Cannot query node: {}", e))?
        .filter_map(|r| r.ok())
        .next();

    let central = match central {
        Some(n) => n,
        None => return Err(format!("Node not found: {}", node_id)),
    };

    // Get edges connected to this node (both directions)
    let mut edge_stmt = conn
        .prepare(
            "SELECT id, source, target, kind, metadata FROM edges \
             WHERE source = ?1 OR target = ?1",
        )
        .map_err(|e| format!("Cannot prepare edge query: {}", e))?;

    let edges: Vec<GraphEdge> = edge_stmt
        .query_map(params![node_id], |row| {
            Ok(GraphEdge {
                id: row.get::<_, String>(0)?,
                source: row.get(1)?,
                target: row.get(2)?,
                kind: row.get(3)?,
                metadata: row.get(4)?,
            })
        })
        .map_err(|e| format!("Cannot query edges: {}", e))?
        .filter_map(|r| r.ok())
        .collect();

    // Collect all neighbor node IDs
    let mut neighbor_ids: Vec<String> = Vec::new();
    for edge in &edges {
        if edge.source != node_id {
            neighbor_ids.push(edge.source.clone());
        }
        if edge.target != node_id {
            neighbor_ids.push(edge.target.clone());
        }
    }
    neighbor_ids.dedup();

    // Query neighbor nodes
    let mut nodes = vec![central];
    if !neighbor_ids.is_empty() {
        let placeholders: Vec<String> = neighbor_ids.iter().enumerate()
            .map(|(i, _)| format!("?{}", i + 2))
            .collect();
        let sql = format!(
            "SELECT id, kind, name, qualified_name, file_path, language, \
             start_line, end_line, signature FROM nodes WHERE id IN ({})",
            placeholders.join(",")
        );

        let mut params_vec: Vec<Box<dyn rusqlite::types::ToSql>> = vec![];
        for nid in &neighbor_ids {
            params_vec.push(Box::new(nid.clone()));
        }
        let params_refs: Vec<&dyn rusqlite::types::ToSql> = params_vec.iter()
            .map(|p| p.as_ref())
            .collect();

        let mut stmt = conn.prepare(&sql)
            .map_err(|e| format!("Cannot prepare batch query: {}", e))?;

        let neighbors: Vec<GraphNode> = stmt
            .query_map(params_refs.as_slice(), |row| {
                Ok(GraphNode {
                    id: row.get(0)?,
                    kind: row.get(1)?,
                    name: row.get(2)?,
                    qualified_name: row.get(3)?,
                    file_path: row.get(4)?,
                    language: row.get(5)?,
                    start_line: row.get::<_, i32>(6)? as u32,
                    end_line: row.get::<_, i32>(7)? as u32,
                    signature: row.get(8)?,
                })
            })
            .map_err(|e| format!("Cannot query neighbors: {}", e))?
            .filter_map(|r| r.ok())
            .collect();

        nodes.extend(neighbors);
    }

    let stats = GraphStats {
        total_nodes: nodes.len(),
        total_edges: edges.len(),
        node_kinds: vec![],
        edge_kinds: vec![],
    };

    Ok(GraphData { nodes, edges, stats })
}
