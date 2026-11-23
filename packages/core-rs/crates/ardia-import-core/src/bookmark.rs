use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum NodeType {
    Folder,
    Url,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookmarkNode {
    #[serde(rename = "type")]
    pub node_type: NodeType,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date_added: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<BookmarkNode>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
}

impl BookmarkNode {
    pub fn folder(title: impl Into<String>, children: Vec<BookmarkNode>, date_added: Option<f64>) -> Self {
        BookmarkNode {
            node_type: NodeType::Folder,
            title: title.into(),
            url: None,
            date_added,
            children: Some(children),
            role: None,
        }
    }

    pub fn link(title: impl Into<String>, url: impl Into<String>, date_added: Option<f64>) -> Self {
        BookmarkNode {
            node_type: NodeType::Url,
            title: title.into(),
            url: Some(url.into()),
            date_added,
            children: None,
            role: None,
        }
    }

    pub fn link_count(&self) -> usize {
        match self.node_type {
            NodeType::Url => 1,
            NodeType::Folder => self.children.iter().flatten().map(BookmarkNode::link_count).sum(),
        }
    }

    pub fn to_json(&self) -> Vec<u8> {
        serde_json::to_vec(self).unwrap_or_default()
    }
}
