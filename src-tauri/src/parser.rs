/// 文档解析器 — 支持 PDF / DOCX / PPTX / HTML 文本提取
use std::io::{Cursor, Read};
use std::panic::{catch_unwind, AssertUnwindSafe};
use zip::ZipArchive;

/// 调用 `pdf_extract::extract_text_from_mem`，把 panic / Err 收编为
/// `Ok(String::new())`，便于上层走 lopdf fallback。
///
/// `pdf-extract` 0.7.12 对部分 CJK 嵌入字体（Identity-H 之外的 CMap）
/// 会触发 `assert!(name == "Identity-H")` 直接 panic（src/lib.rs:942），
/// 导致整个 tauri 进程退出（用户报告 STATUS_CONTROL_C_EXIT）。
/// `catch_unwind` 拦下 panic；Err 情况（比如加密 PDF）也一视同仁当空处理，
/// 让 `parse_pdf_pages` 的 lopdf 第二轮兜底能接上，保持 UI 看到正确页数。
/// `data` 在 closure 中只读借用，pdf-extract 内部状态在 panic 后被丢弃，
/// 不会污染外部，AssertUnwindSafe 是安全的。
fn pdf_extract_text_safe(data: &[u8]) -> String {
    let res = catch_unwind(AssertUnwindSafe(|| pdf_extract::extract_text_from_mem(data)));
    match res {
        Ok(Ok(t)) => t,
        Ok(Err(e)) => {
            eprintln!("[parser] pdf-extract returned Err: {e}; falling back");
            String::new()
        }
        Err(_) => {
            eprintln!(
                "[parser] pdf-extract panicked (likely non-Identity-H CJK font); falling back"
            );
            String::new()
        }
    }
}

/// 用 lopdf 按页抽取文本，全部失败时返回空字符串。
///
/// 作为 `pdf-extract` 的 fallback：lopdf 是纯 Rust，对嵌入 CMap 更宽容，
/// 但它无法解 Type3 / 某些 CID 字体——所以即便 lopdf 也抽不出来，也要让
/// 上层生成一条空占位 page，UI 不会漏页。
///
/// 为什么用 panic guard：`Document::extract_text` 内部调 `decode_text`，
/// 遇到非法 bytes 可能 unwrap 失败或 panic，历史版本出过类似问题。
fn lopdf_extract_page_safe(doc: &lopdf::Document, page_num_1based: u32) -> String {
    let res = catch_unwind(AssertUnwindSafe(|| doc.extract_text(&[page_num_1based])));
    match res {
        Ok(Ok(t)) => t,
        Ok(Err(_)) | Err(_) => String::new(),
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ParsedDocument {
    pub title: String,
    pub content: String,
    pub page_count: usize,
}

/// 单页内容
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ParsedPage {
    pub page_index: usize,
    pub content: String,
    pub word_count: usize,
}

/// 按页解析结果
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ParsedDocumentPages {
    pub title: String,
    pub pages: Vec<ParsedPage>,
    pub full_content: String,
}

pub fn parse_bytes(filename: &str, data: &[u8]) -> Result<ParsedDocument, String> {
    let ext = std::path::Path::new(filename)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    match ext.as_str() {
        "pdf" => parse_pdf(filename, data),
        "docx" | "doc" => parse_docx(filename, data),
        "pptx" | "ppt" => parse_pptx(filename, data),
        "html" | "htm" => parse_html(filename, data),
        _ => Err(format!("不支持的文件类型: .{}", ext)),
    }
}

/// 按页解析文档，返回每页独立内容
pub fn parse_pages(filename: &str, data: &[u8]) -> Result<ParsedDocumentPages, String> {
    let ext = std::path::Path::new(filename)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    match ext.as_str() {
        "pdf" => parse_pdf_pages(filename, data),
        "docx" | "doc" => parse_docx_pages(filename, data),
        "pptx" | "ppt" => parse_pptx_pages(filename, data),
        "html" | "htm" => parse_html_pages(filename, data),
        _ => Err(format!("不支持的文件类型: .{}", ext)),
    }
}

fn make_page(index: usize, content: String) -> ParsedPage {
    let word_count = content.chars().filter(|c| !c.is_whitespace()).count();
    ParsedPage {
        page_index: index,
        content,
        word_count,
    }
}

fn stem(filename: &str) -> String {
    std::path::Path::new(filename)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(filename)
        .to_string()
}

// ── PDF ──────────────────────────────────────────────────────────────────────

fn parse_pdf(filename: &str, data: &[u8]) -> Result<ParsedDocument, String> {
    let mut text = pdf_extract_text_safe(data);
    // pdf-extract 抽到空时（panic / CMap 兼容性问题），用 lopdf 整本兜底
    if text.trim().is_empty() {
        if let Ok(doc) = lopdf::Document::load_mem(data) {
            let mut out = String::new();
            for pn in 1..=doc.get_pages().len() as u32 {
                let page_text = lopdf_extract_page_safe(&doc, pn);
                if !page_text.trim().is_empty() {
                    out.push_str(&page_text);
                    out.push('\n');
                }
            }
            text = out;
        }
    }
    let content = clean_text(&text);
    Ok(ParsedDocument {
        title: stem(filename),
        content,
        page_count: 0, // pdf-extract 不暴露页数
    })
}

// ── DOCX ─────────────────────────────────────────────────────────────────────

fn parse_docx(filename: &str, data: &[u8]) -> Result<ParsedDocument, String> {
    let cursor = Cursor::new(data);
    let mut archive = ZipArchive::new(cursor).map_err(|e| format!("DOCX 解压失败: {e}"))?;
    let mut xml_content = String::new();
    {
        let mut entry = archive
            .by_name("word/document.xml")
            .map_err(|_| "找不到 word/document.xml".to_string())?;
        entry
            .read_to_string(&mut xml_content)
            .map_err(|e| format!("读取 docx xml 失败: {e}"))?;
    }
    let content = extract_xml_text(&xml_content);
    Ok(ParsedDocument {
        title: stem(filename),
        content,
        page_count: 0,
    })
}

// ── PPTX ─────────────────────────────────────────────────────────────────────

fn parse_pptx(filename: &str, data: &[u8]) -> Result<ParsedDocument, String> {
    let cursor = Cursor::new(data);
    let mut archive = ZipArchive::new(cursor).map_err(|e| format!("PPTX 解压失败: {e}"))?;

    let mut all_text = Vec::new();
    let slide_names: Vec<String> = (0..archive.len())
        .filter_map(|i| {
            let name = archive.by_index(i).ok()?.name().to_string();
            if name.starts_with("ppt/slides/slide") && name.ends_with(".xml") {
                Some(name)
            } else {
                None
            }
        })
        .collect();

    // 排序：slide1.xml, slide2.xml …
    let mut sorted_names = slide_names;
    sorted_names.sort_by(|a, b| {
        let num = |s: &str| -> usize {
            s.trim_start_matches("ppt/slides/slide")
                .trim_end_matches(".xml")
                .parse()
                .unwrap_or(0)
        };
        num(a).cmp(&num(b))
    });

    for name in &sorted_names {
        let mut xml = String::new();
        if let Ok(mut entry) = archive.by_name(name) {
            let _ = entry.read_to_string(&mut xml);
            let slide_text = extract_xml_text(&xml);
            if !slide_text.trim().is_empty() {
                all_text.push(slide_text);
            }
        }
    }

    let content = all_text.join("\n\n");
    Ok(ParsedDocument {
        title: stem(filename),
        content: clean_text(&content),
        page_count: sorted_names.len(),
    })
}

// ── HTML ─────────────────────────────────────────────────────────────────────

fn parse_html(filename: &str, data: &[u8]) -> Result<ParsedDocument, String> {
    let html = String::from_utf8_lossy(data).into_owned();
    let document = scraper::Html::parse_document(&html);

    // 提取 <title>
    let title_sel = scraper::Selector::parse("title").unwrap();
    let page_title = document
        .select(&title_sel)
        .next()
        .map(|el| el.text().collect::<String>())
        .filter(|t| !t.trim().is_empty())
        .unwrap_or_else(|| stem(filename));

    // 去除 script / style 后提取正文
    let body_sel = scraper::Selector::parse("body").unwrap();
    let mut lines: Vec<String> = Vec::new();
    if let Some(body) = document.select(&body_sel).next() {
        collect_text(&body, &mut lines);
    } else {
        collect_text(&document.root_element(), &mut lines);
    }

    let content = lines.join("\n");
    Ok(ParsedDocument {
        title: page_title,
        content: clean_text(&content),
        page_count: 0,
    })
}

fn collect_text(el: &scraper::ElementRef, out: &mut Vec<String>) {
    let tag = el.value().name();
    if matches!(tag, "script" | "style" | "head") {
        return;
    }
    for child in el.children() {
        if let Some(text_node) = child.value().as_text() {
            let t = text_node.trim().to_string();
            if !t.is_empty() {
                out.push(t);
            }
        } else if let Some(child_el) = scraper::ElementRef::wrap(child) {
            collect_text(&child_el, out);
        }
    }
}

// ── XML text extraction (generic for DOCX / PPTX) ────────────────────────────

fn extract_xml_text(xml: &str) -> String {
    // 用 quick-xml 提取所有文本节点
    use quick_xml::events::Event;
    use quick_xml::Reader;

    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);

    let mut buf = Vec::new();
    let mut lines: Vec<String> = Vec::new();
    let mut in_para = false;
    let mut para_text = String::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) => {
                let local = e.local_name();
                let name = std::str::from_utf8(local.as_ref()).unwrap_or("");
                if matches!(name, "p" | "a:p") {
                    in_para = true;
                    para_text.clear();
                }
            }
            Ok(Event::End(ref e)) => {
                let local = e.local_name();
                let name = std::str::from_utf8(local.as_ref()).unwrap_or("");
                if matches!(name, "p" | "a:p") && in_para {
                    let trimmed = para_text.trim().to_string();
                    if !trimmed.is_empty() {
                        lines.push(trimmed);
                    }
                    in_para = false;
                    para_text.clear();
                }
            }
            Ok(Event::Text(e)) => {
                if let Ok(t) = e.unescape() {
                    if in_para {
                        para_text.push_str(&t);
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    lines.join("\n")
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn clean_text(text: &str) -> String {
    use regex::Regex;
    // 合并多余空行
    let re = Regex::new(r"\n{3,}").unwrap();
    let s = re.replace_all(text, "\n\n");
    // 去除行首尾空格
    s.lines()
        .map(|l| l.trim())
        .collect::<Vec<_>>()
        .join("\n")
}

// ══════════════════════════════════════════════════════════════════════════════
// 按页解析实现
// ══════════════════════════════════════════════════════════════════════════════

// ── PDF 按页 ─────────────────────────────────────────────────────────────────

fn parse_pdf_pages(filename: &str, data: &[u8]) -> Result<ParsedDocumentPages, String> {
    // 1. lopdf 获取 PDF 真实页数——这步若失败直接报错（文件不是合法 PDF）
    let pdf_doc = lopdf::Document::load_mem(data)
        .map_err(|e| format!("PDF 页数读取失败: {e}"))?;
    let real_page_count = pdf_doc.get_pages().len();

    // 2. 先尝试 pdf-extract 全文抽取（有 form-feed 天然分页，多数 PDF 效果好）
    //    注意：不过滤空段、不 trim——必须保留 form-feed 间所有段，否则页索引会整体错位。
    let text = pdf_extract_text_safe(data);
    let ff_pages: Vec<String> = text.split('\x0c').map(clean_text).collect();

    // 3. 三级分页策略（优先级从高到低）：
    //    a) pdf-extract 的 form-feed 段数 **恰好等于** real_page_count → 一一对齐
    //       （宽松一点：相差 1 时大概率是末尾多/少一个空段，也可对齐；
    //         更大偏差说明 form-feed 不可靠，走 b）
    //    b) form-feed 不可靠 → 用 lopdf 按页单独抽（对 CJK 嵌入字体更宽容）
    //    c) lopdf 也抽不出 → 生成 real_page_count 条空占位，索引仍对齐
    //
    // 旧实现用 `skip = ff_pages.len() - real_page_count` 从开头跳段，对于
    // 中间出现额外 form-feed 的 PDF 会让所有靠后页内容整体前移 → AI 看到的
    // 「当前页内容」其实是下一两页的，必须废弃。
    let pages: Vec<ParsedPage> = if real_page_count > 0
        && ff_pages.len() >= real_page_count
        && ff_pages.len() <= real_page_count + 1
    {
        // a) form-feed 段数与真实页数严格对齐（允许末尾多一个空段）
        ff_pages
            .into_iter()
            .take(real_page_count)
            .enumerate()
            .map(|(i, content)| make_page(i, content))
            .collect()
    } else if real_page_count > 0 {
        // b) / c) lopdf 按页抽，失败就空占位
        (0..real_page_count)
            .map(|i| {
                let page_text = lopdf_extract_page_safe(&pdf_doc, (i + 1) as u32);
                make_page(i, clean_text(&page_text))
            })
            .collect()
    } else {
        // 真实页数为 0（极少见），用全文当一页兜底
        vec![make_page(0, clean_text(&text))]
    };

    let full_content = pages
        .iter()
        .map(|p| p.content.as_str())
        .collect::<Vec<_>>()
        .join("\n\n");
    Ok(ParsedDocumentPages {
        title: stem(filename),
        pages,
        full_content,
    })
}

// ── DOCX 按页 ────────────────────────────────────────────────────────────────

fn parse_docx_pages(filename: &str, data: &[u8]) -> Result<ParsedDocumentPages, String> {
    // DOCX 没有物理分页概念，按段落分块（每 ~500 字一页）
    let cursor = Cursor::new(data);
    let mut archive = ZipArchive::new(cursor).map_err(|e| format!("DOCX 解压失败: {e}"))?;
    let mut xml_content = String::new();
    {
        let mut entry = archive
            .by_name("word/document.xml")
            .map_err(|_| "找不到 word/document.xml".to_string())?;
        entry
            .read_to_string(&mut xml_content)
            .map_err(|e| format!("读取 docx xml 失败: {e}"))?;
    }
    let full_text = extract_xml_text(&xml_content);
    let full_content = clean_text(&full_text);

    // 按段落分块，每块约 500 字符
    let paragraphs: Vec<&str> = full_content.split("\n\n").filter(|s| !s.trim().is_empty()).collect();
    let mut pages = Vec::new();
    let mut current_page = String::new();
    let mut char_count = 0;
    let chunk_size = 500;

    for para in &paragraphs {
        current_page.push_str(para);
        current_page.push_str("\n\n");
        char_count += para.chars().count();
        if char_count >= chunk_size {
            pages.push(make_page(pages.len(), current_page.trim().to_string()));
            current_page.clear();
            char_count = 0;
        }
    }
    if !current_page.trim().is_empty() {
        pages.push(make_page(pages.len(), current_page.trim().to_string()));
    }
    if pages.is_empty() {
        pages.push(make_page(0, full_content.clone()));
    }

    Ok(ParsedDocumentPages {
        title: stem(filename),
        pages,
        full_content,
    })
}

// ── PPTX 按页（按 slide）────────────────────────────────────────────────────

fn parse_pptx_pages(filename: &str, data: &[u8]) -> Result<ParsedDocumentPages, String> {
    let cursor = Cursor::new(data);
    let mut archive = ZipArchive::new(cursor).map_err(|e| format!("PPTX 解压失败: {e}"))?;

    // 优先从 presentation.xml 读取真实演示顺序
    // （PowerShell COM 导出图片按此顺序，文本必须与之对齐）
    let mut slide_names: Vec<String> = Vec::new();

    let mut pres_xml = String::new();
    let mut rels_xml = String::new();
    if let Ok(mut entry) = archive.by_name("ppt/presentation.xml") {
        let _ = entry.read_to_string(&mut pres_xml);
    }
    if let Ok(mut entry) = archive.by_name("ppt/_rels/presentation.xml.rels") {
        let _ = entry.read_to_string(&mut rels_xml);
    }

    if !pres_xml.is_empty() && !rels_xml.is_empty() {
        use regex::Regex;
        // 从 <p:sldId ... r:id="rIdX" .../> 提取有序关系 ID
        let sld_re = Regex::new(r#"<p:sldId\s[^>]*?r:id="([^"]+)""#).unwrap();
        let ordered_rids: Vec<String> = sld_re
            .captures_iter(&pres_xml)
            .filter_map(|c| c.get(1).map(|m| m.as_str().to_string()))
            .collect();

        // 从 rels 文件构建 rid → slide 文件路径映射
        let rel_re = Regex::new(r#"<Relationship\s([^>]*?)/?\s*>"#).unwrap();
        let id_re = Regex::new(r#"Id="([^"]+)""#).unwrap();
        let tgt_re = Regex::new(r#"Target="([^"]+)""#).unwrap();
        let mut rid_map: std::collections::HashMap<String, String> =
            std::collections::HashMap::new();
        for cap in rel_re.captures_iter(&rels_xml) {
            if let Some(attrs) = cap.get(1) {
                let a = attrs.as_str();
                if let (Some(id_m), Some(tgt_m)) = (id_re.captures(a), tgt_re.captures(a)) {
                    rid_map.insert(
                        id_m.get(1).unwrap().as_str().to_string(),
                        tgt_m.get(1).unwrap().as_str().to_string(),
                    );
                }
            }
        }

        // 按演示顺序构建幻灯片文件列表
        for rid in &ordered_rids {
            if let Some(target) = rid_map.get(rid) {
                let full_path = if target.starts_with("ppt/") {
                    target.clone()
                } else {
                    format!("ppt/{}", target)
                };
                slide_names.push(full_path);
            }
        }
    }

    // 回退：无法读取演示顺序时按文件名数字排序
    if slide_names.is_empty() {
        slide_names = (0..archive.len())
            .filter_map(|i| {
                let name = archive.by_index(i).ok()?.name().to_string();
                if name.starts_with("ppt/slides/slide") && name.ends_with(".xml") {
                    Some(name)
                } else {
                    None
                }
            })
            .collect();
        slide_names.sort_by(|a, b| {
            let num = |s: &str| -> usize {
                s.trim_start_matches("ppt/slides/slide")
                    .trim_end_matches(".xml")
                    .parse()
                    .unwrap_or(0)
            };
            num(a).cmp(&num(b))
        });
    }

    let mut pages = Vec::new();
    for (i, name) in slide_names.iter().enumerate() {
        let mut xml = String::new();
        if let Ok(mut entry) = archive.by_name(name) {
            let _ = entry.read_to_string(&mut xml);
            let slide_text = clean_text(&extract_xml_text(&xml));
            pages.push(make_page(i, slide_text));
        }
    }

    let full_content = pages.iter().map(|p| p.content.as_str()).collect::<Vec<_>>().join("\n\n");
    Ok(ParsedDocumentPages {
        title: stem(filename),
        pages,
        full_content,
    })
}

// ── HTML 按页 ────────────────────────────────────────────────────────────────

fn parse_html_pages(filename: &str, data: &[u8]) -> Result<ParsedDocumentPages, String> {
    // HTML 作为单页处理
    let doc = parse_html(filename, data)?;
    let page = make_page(0, doc.content.clone());
    Ok(ParsedDocumentPages {
        title: doc.title,
        pages: vec![page],
        full_content: doc.content,
    })
}
