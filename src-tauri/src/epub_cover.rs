//! EPUB cover image extraction.
//!
//! 实现：解析 EPUB 内置 OPF 元数据，定位封面图片项并写入到指定目录。
//! 失败返回 None（调用方应忽略错误，封面是非关键路径）。

use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use zip::ZipArchive;

/// 尝试从 EPUB 字节流中抽取封面图，写入 `dest_dir/<basename>.<ext>`，返回写入路径。
pub fn extract_epub_cover(
    bytes: &[u8],
    dest_dir: &Path,
    basename: &str,
) -> Option<PathBuf> {
    let mut zip = ZipArchive::new(Cursor::new(bytes)).ok()?;

    // 1) container.xml → rootfile
    let opf_path = read_zip_str(&mut zip, "META-INF/container.xml")
        .and_then(|s| extract_opf_path(&s))?;

    // 2) read OPF
    let opf = read_zip_str(&mut zip, &opf_path)?;
    let cover_href = find_cover_href(&opf)?;

    // OPF 内 href 是相对 OPF 自身目录的路径
    let opf_dir = Path::new(&opf_path).parent().map(|p| p.to_path_buf()).unwrap_or_default();
    let mut full_path = opf_dir.to_string_lossy().to_string();
    if !full_path.is_empty() && !full_path.ends_with('/') {
        full_path.push('/');
    }
    full_path.push_str(&cover_href);
    // EPUB 内部都是 '/'
    let full_path = full_path.replace('\\', "/");
    let full_path = normalize_zip_path(&full_path);

    // 3) read image bytes
    let img_bytes = read_zip_bytes(&mut zip, &full_path)?;
    let ext = Path::new(&full_path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("jpg")
        .to_lowercase();

    std::fs::create_dir_all(dest_dir).ok()?;
    let out = dest_dir.join(format!("{basename}.{ext}"));
    std::fs::write(&out, img_bytes).ok()?;
    Some(out)
}

fn read_zip_str<R: Read + std::io::Seek>(zip: &mut ZipArchive<R>, name: &str) -> Option<String> {
    let mut f = zip.by_name(name).ok()?;
    let mut s = String::new();
    f.read_to_string(&mut s).ok()?;
    Some(s)
}

fn read_zip_bytes<R: Read + std::io::Seek>(zip: &mut ZipArchive<R>, name: &str) -> Option<Vec<u8>> {
    let mut f = zip.by_name(name).ok()?;
    let mut buf = Vec::with_capacity(f.size() as usize);
    f.read_to_end(&mut buf).ok()?;
    Some(buf)
}

/// 从 container.xml 文本中提取 rootfile full-path
fn extract_opf_path(xml: &str) -> Option<String> {
    // 取第一个 full-path="..." 出现位置
    let key = "full-path=\"";
    let i = xml.find(key)?;
    let rest = &xml[i + key.len()..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

/// 解析 OPF 文本，找到 cover image href
/// 兼容 EPUB 2（<meta name="cover" content="id"/> + <item id="id" href="..."/>）
/// 与 EPUB 3（<item properties="cover-image" href="..."/>）
fn find_cover_href(opf: &str) -> Option<String> {
    // EPUB 3 优先
    if let Some(href) = find_item_with_property(opf, "cover-image") {
        return Some(href);
    }
    // EPUB 2：先找 cover id
    if let Some(cover_id) = find_meta_cover_id(opf) {
        if let Some(href) = find_item_href_by_id(opf, &cover_id) {
            return Some(href);
        }
    }
    // 启发式 fallback：item id 或 href 含 "cover" 且为图片
    find_item_heuristic_cover(opf)
}

fn find_meta_cover_id(opf: &str) -> Option<String> {
    // <meta name="cover" content="..."/> 顺序可能颠倒
    for line in opf.split('<') {
        let l = line.trim_start();
        if !l.starts_with("meta") {
            continue;
        }
        let has_cover = l.contains("name=\"cover\"") || l.contains("name='cover'");
        if !has_cover {
            continue;
        }
        if let Some(c) = attr_value(l, "content") {
            return Some(c);
        }
    }
    None
}

fn find_item_with_property(opf: &str, prop: &str) -> Option<String> {
    for tag in opf.split('<') {
        let t = tag.trim_start();
        if !t.starts_with("item ") && !t.starts_with("item\t") {
            continue;
        }
        let props = attr_value(t, "properties").unwrap_or_default();
        if props.split_whitespace().any(|p| p == prop) {
            return attr_value(t, "href");
        }
    }
    None
}

fn find_item_href_by_id(opf: &str, id: &str) -> Option<String> {
    for tag in opf.split('<') {
        let t = tag.trim_start();
        if !t.starts_with("item ") && !t.starts_with("item\t") {
            continue;
        }
        if attr_value(t, "id").as_deref() == Some(id) {
            return attr_value(t, "href");
        }
    }
    None
}

fn find_item_heuristic_cover(opf: &str) -> Option<String> {
    for tag in opf.split('<') {
        let t = tag.trim_start();
        if !t.starts_with("item ") && !t.starts_with("item\t") {
            continue;
        }
        let mt = attr_value(t, "media-type").unwrap_or_default();
        if !mt.starts_with("image/") {
            continue;
        }
        let id = attr_value(t, "id").unwrap_or_default().to_lowercase();
        let href = attr_value(t, "href").unwrap_or_default();
        if id.contains("cover") || href.to_lowercase().contains("cover") {
            return Some(href);
        }
    }
    None
}

/// 提取属性值：返回 attr="value" 或 attr='value' 中的 value
fn attr_value(tag: &str, attr: &str) -> Option<String> {
    // 简单查找 attr= 后跟 " 或 '
    let needle1 = format!("{attr}=\"");
    let needle2 = format!("{attr}='");
    let (start, quote) = if let Some(i) = tag.find(&needle1) {
        (i + needle1.len(), '"')
    } else if let Some(i) = tag.find(&needle2) {
        (i + needle2.len(), '\'')
    } else {
        return None;
    };
    let rest = &tag[start..];
    let end = rest.find(quote)?;
    Some(rest[..end].to_string())
}

/// 处理 EPUB 内部相对路径中的 ./ 和 ../
fn normalize_zip_path(p: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for seg in p.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            s => parts.push(s),
        }
    }
    parts.join("/")
}
