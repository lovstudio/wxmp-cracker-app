#![cfg(target_os = "macos")]

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde_json::Value;
use std::{
    collections::{HashMap, VecDeque},
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

const XWORKER_BLOB_DIR: &str = "weixin_xworker_0.indexeddb.blob";
const INDEXED_DB_WRAPPER: &[u8] = &[0xff, 0x11, 0x02];
const BATCH_RESPONSE_NAME: &[u8] = b"__batch_get_appmsg_data";
const V8_DATA_PROPERTY: &[u8] = &[0x22, 0x04, b'd', b'a', b't', b'a'];
const V8_TWO_BYTE_STRING_TAG: u8 = 0x63;
const V8_ONE_BYTE_STRING_TAG: u8 = 0x22;
const MAX_BLOB_BYTES: u64 = 32 * 1024 * 1024;
const MAX_DECOMPRESSED_BYTES: usize = 64 * 1024 * 1024;
const MAX_BLOBS_TO_SCAN: usize = 64;

// Do not derive `Debug`: `transient_fetch_link` may contain short-lived
// WeChat session parameters and must never be emitted by diagnostic logging.
#[derive(Clone, PartialEq)]
pub struct AccountFeedArticleMetrics {
    pub biz: String,
    pub mid: String,
    pub idx: String,
    pub sn: Option<String>,
    pub link: String,
    /// Authorized article URL from the current WeChat page. It may contain
    /// short-lived session parameters and must stay in memory only.
    pub transient_fetch_link: Option<String>,
    pub title: String,
    pub publisher: Option<String>,
    pub digest: Option<String>,
    pub cover: Option<String>,
    pub create_time: Option<i64>,
    pub update_time_ms: i64,
    pub read_count: Option<i64>,
    pub like_count: Option<i64>,
    pub recommend_count: Option<i64>,
    pub share_count: Option<i64>,
    pub comment_count: Option<i64>,
    pub collect_count: Option<i64>,
}

impl AccountFeedArticleMetrics {
    pub fn has_any_metric(&self) -> bool {
        self.read_count.is_some()
            || self.like_count.is_some()
            || self.recommend_count.is_some()
            || self.share_count.is_some()
            || self.comment_count.is_some()
            || self.collect_count.is_some()
    }
}

/// Reads the batches written by WeChat's account-profile page. The caller
/// supplies the expected account id so similarly named search results can
/// never be persisted as the requested account.
pub fn read_account_feed_metrics(
    expected_fakeid: &str,
    minimum_update_time_ms: i64,
) -> Result<Vec<AccountFeedArticleMetrics>, String> {
    read_account_feed_records(expected_fakeid, minimum_update_time_ms, true)
}

/// Reads article metadata from the target account's profile batches. Unlike
/// `read_account_feed_metrics`, rows remain valid when WeChat omits social
/// counters: the account id plus `(mid, idx)` are the list identity.
pub fn read_account_feed_articles(
    expected_fakeid: &str,
    minimum_update_time_ms: i64,
) -> Result<Vec<AccountFeedArticleMetrics>, String> {
    read_account_feed_records(expected_fakeid, minimum_update_time_ms, false)
}

fn read_account_feed_records(
    expected_fakeid: &str,
    minimum_update_time_ms: i64,
    require_metrics: bool,
) -> Result<Vec<AccountFeedArticleMetrics>, String> {
    let expected_fakeid = expected_fakeid.trim();
    if expected_fakeid.is_empty() {
        return Err("缺少目标公众号 ID，无法读取公众号文章列表数据".to_string());
    }
    let mut candidates = discover_xworker_blobs()?;
    candidates.sort_by_key(|candidate| std::cmp::Reverse(candidate.modified_at_ms));
    candidates.truncate(MAX_BLOBS_TO_SCAN);

    let mut records = HashMap::<(String, String), AccountFeedArticleMetrics>::new();
    for candidate in candidates {
        // Filesystem timestamps are only a pre-filter. The response's own
        // millisecond updateTime remains the freshness authority below.
        if candidate.modified_at_ms.saturating_add(2_000) < minimum_update_time_ms {
            continue;
        }
        let Ok(bytes) = fs::read(&candidate.path) else {
            continue;
        };
        let Ok(batch) = parse_xworker_blob(&bytes, candidate.modified_at_ms) else {
            continue;
        };
        for mut record in batch {
            // WeChat may materialize an IndexedDB response from its own
            // in-process cache without rewriting the JSON-level updateTime.
            // A blob created/rewritten by this account-page operation is still
            // authoritative evidence that the page supplied the batch now.
            record.update_time_ms = record.update_time_ms.max(candidate.modified_at_ms);
            if record.biz != expected_fakeid
                || record.update_time_ms < minimum_update_time_ms
                || (require_metrics && !record.has_any_metric())
            {
                continue;
            }
            let key = (record.mid.clone(), record.idx.clone());
            match records.get_mut(&key) {
                Some(existing) if existing.update_time_ms >= record.update_time_ms => {}
                Some(existing) => *existing = record,
                None => {
                    records.insert(key, record);
                }
            }
        }
    }

    let mut records = records.into_values().collect::<Vec<_>>();
    records.sort_by(|left, right| {
        right
            .create_time
            .cmp(&left.create_time)
            .then_with(|| right.update_time_ms.cmp(&left.update_time_ms))
            .then_with(|| right.mid.cmp(&left.mid))
    });
    Ok(records)
}

#[derive(Debug)]
struct BlobCandidate {
    path: PathBuf,
    modified_at_ms: i64,
}

fn discover_xworker_blobs() -> Result<Vec<BlobCandidate>, String> {
    let home = dirs::home_dir().ok_or_else(|| "无法定位用户目录".to_string())?;
    let profiles_root = home
        .join("Library")
        .join("Containers")
        .join("com.tencent.xinWeChat")
        .join("Data")
        .join("Documents")
        .join("app_data")
        .join("radium")
        .join("web")
        .join("profiles");
    let Ok(profiles) = fs::read_dir(&profiles_root) else {
        return Ok(Vec::new());
    };
    let mut candidates = Vec::new();
    for profile in profiles.flatten() {
        let Ok(file_type) = profile.file_type() else {
            continue;
        };
        if !file_type.is_dir()
            || !profile
                .file_name()
                .to_str()
                .is_some_and(|name| name.starts_with("multitab"))
        {
            continue;
        }
        let blob_root = profile.path().join("IndexedDB").join(XWORKER_BLOB_DIR);
        collect_blob_candidates(&blob_root, &mut candidates);
    }
    Ok(candidates)
}

fn collect_blob_candidates(root: &Path, candidates: &mut Vec<BlobCandidate>) {
    let mut queue = VecDeque::from([(root.to_path_buf(), 0_usize)]);
    while let Some((directory, depth)) = queue.pop_front() {
        if depth > 4 {
            continue;
        }
        let Ok(entries) = fs::read_dir(directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            if metadata.is_dir() {
                queue.push_back((entry.path(), depth + 1));
                continue;
            }
            if !metadata.is_file()
                || metadata.len() <= INDEXED_DB_WRAPPER.len() as u64
                || metadata.len() > MAX_BLOB_BYTES
            {
                continue;
            }
            let modified_at_ms = metadata
                .modified()
                .ok()
                .and_then(system_time_to_millis)
                .unwrap_or_default();
            candidates.push(BlobCandidate {
                path: entry.path(),
                modified_at_ms,
            });
        }
    }
}

fn system_time_to_millis(value: SystemTime) -> Option<i64> {
    let millis = value.duration_since(UNIX_EPOCH).ok()?.as_millis();
    i64::try_from(millis).ok()
}

fn parse_xworker_blob(
    bytes: &[u8],
    fallback_update_time_ms: i64,
) -> Result<Vec<AccountFeedArticleMetrics>, String> {
    if !bytes.starts_with(INDEXED_DB_WRAPPER) {
        return Err("不是微信 XWorker IndexedDB blob".to_string());
    }
    let decompressed = decompress_raw_snappy(&bytes[INDEXED_DB_WRAPPER.len()..])?;
    let data = extract_batch_data_string(&decompressed)?;
    parse_batch_json(&data, fallback_update_time_ms)
}

fn extract_batch_data_string(bytes: &[u8]) -> Result<String, String> {
    if find_subslice(bytes, BATCH_RESPONSE_NAME).is_none() {
        return Err("XWorker blob 不是文章批量响应".to_string());
    }
    let property_offset = find_subslice(bytes, V8_DATA_PROPERTY)
        .ok_or_else(|| "XWorker 批量响应缺少 data 字段".to_string())?;
    let mut cursor = property_offset + V8_DATA_PROPERTY.len();
    while bytes.get(cursor) == Some(&0) {
        cursor += 1;
    }
    let tag = *bytes
        .get(cursor)
        .ok_or_else(|| "XWorker data 字段不完整".to_string())?;
    cursor += 1;
    let (length, next_cursor) = read_varint(bytes, cursor)?;
    cursor = next_cursor;
    if length > MAX_DECOMPRESSED_BYTES || cursor.saturating_add(length) > bytes.len() {
        return Err("XWorker data 字段长度无效".to_string());
    }
    let payload = &bytes[cursor..cursor + length];
    match tag {
        V8_TWO_BYTE_STRING_TAG => {
            if payload.len() % 2 != 0 {
                return Err("XWorker data UTF-16 长度无效".to_string());
            }
            let units = payload
                .chunks_exact(2)
                .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                .collect::<Vec<_>>();
            String::from_utf16(&units).map_err(|_| "XWorker data UTF-16 解码失败".to_string())
        }
        V8_ONE_BYTE_STRING_TAG => String::from_utf8(payload.to_vec())
            .map_err(|_| "XWorker data UTF-8 解码失败".to_string()),
        _ => Err(format!("XWorker data 字符串类型不支持：0x{tag:02x}")),
    }
}

fn parse_batch_json(
    data: &str,
    fallback_update_time_ms: i64,
) -> Result<Vec<AccountFeedArticleMetrics>, String> {
    let entries: Value =
        serde_json::from_str(data).map_err(|_| "微信文章批量响应 JSON 无法解析".to_string())?;
    let entries = entries
        .as_object()
        .ok_or_else(|| "微信文章批量响应不是对象".to_string())?;
    let mut records = Vec::new();
    for (request_url, entry) in entries {
        let Some(content_json) = entry.get("Content").and_then(Value::as_str) else {
            continue;
        };
        let Ok(content) = serde_json::from_str::<Value>(content_json) else {
            continue;
        };
        let Some(title) = content
            .get("title")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        let request_identity = parse_request_identity(request_url);
        let Some(biz) = request_identity
            .as_ref()
            .map(|identity| identity.0.clone())
            .or_else(|| {
                entry
                    .get("BizUin")
                    .and_then(json_decimal)
                    .map(|value| BASE64_STANDARD.encode(value.as_bytes()))
            })
        else {
            continue;
        };
        let Some(mid) = json_decimal(entry.get("MsgId").unwrap_or(&Value::Null))
            .or_else(|| request_identity.as_ref().map(|identity| identity.1.clone()))
        else {
            continue;
        };
        let idx = json_decimal(entry.get("ItemIdx").unwrap_or(&Value::Null))
            .or_else(|| request_identity.as_ref().map(|identity| identity.2.clone()))
            .unwrap_or_else(|| "1".to_string());
        let bar = content
            .pointer("/user_info/appmsg_bar_data")
            .or_else(|| content.get("appmsg_bar_data"));
        let update_time_ms = json_i64(entry.get("updateTime").unwrap_or(&Value::Null))
            .unwrap_or(fallback_update_time_ms);
        let content_link = content.get("link").and_then(Value::as_str);
        let sn = content_link.and_then(parse_sn_from_article_link);
        let Some(link) = canonical_article_url(&biz, &mid, &idx, sn.as_deref()) else {
            continue;
        };
        let transient_fetch_link =
            content_link.and_then(|value| safe_transient_article_link(value, &biz, &mid, &idx));
        records.push(AccountFeedArticleMetrics {
            biz,
            mid,
            idx,
            sn,
            link,
            transient_fetch_link,
            title: title.to_string(),
            publisher: content
                .get("nick_name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string),
            digest: first_trimmed_string(&content, &["digest", "desc"]),
            cover: first_trimmed_string(&content, &["cover", "cover_url", "cdn_url", "thumb_url"]),
            create_time: json_i64(content.get("create_timestamp").unwrap_or(&Value::Null))
                .or_else(|| json_i64(content.get("ori_create_time").unwrap_or(&Value::Null))),
            update_time_ms,
            read_count: bar.and_then(|value| json_i64(value.get("read_num")?)),
            like_count: bar.and_then(|value| json_i64(value.get("old_like_count")?)),
            recommend_count: bar.and_then(|value| json_i64(value.get("like_count")?)),
            share_count: bar.and_then(|value| json_i64(value.get("share_count")?)),
            comment_count: bar.and_then(|value| json_i64(value.get("comment_count")?)),
            collect_count: bar.and_then(|value| json_i64(value.get("collect_count")?)),
        });
    }
    Ok(records)
}

fn canonical_article_url(biz: &str, mid: &str, idx: &str, sn: Option<&str>) -> Option<String> {
    if biz.is_empty()
        || biz.len() > 256
        || !biz.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'=' | b'-' | b'_')
        })
        || mid.is_empty()
        || !mid.bytes().all(|byte| byte.is_ascii_digit())
        || idx.is_empty()
        || !idx.bytes().all(|byte| byte.is_ascii_digit())
        || sn.is_some_and(|value| {
            value.len() > 256
                || !value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        })
    {
        return None;
    }
    let mut url = reqwest::Url::parse("https://mp.weixin.qq.com/s").ok()?;
    {
        let mut pairs = url.query_pairs_mut();
        pairs.append_pair("__biz", biz);
        pairs.append_pair("mid", mid);
        pairs.append_pair("idx", idx);
        if let Some(sn) = sn {
            pairs.append_pair("sn", sn);
        }
    }
    Some(url.to_string())
}

fn safe_transient_article_link(value: &str, biz: &str, mid: &str, idx: &str) -> Option<String> {
    let decoded = value.replace("&amp;", "&");
    let mut url = reqwest::Url::parse(decoded.trim()).ok()?;
    if url.scheme() == "http" {
        url.set_scheme("https").ok()?;
    }
    if url.scheme() != "https"
        || url.host_str() != Some("mp.weixin.qq.com")
        || !(url.path() == "/s" || url.path().starts_with("/s/"))
    {
        return None;
    }
    let query_value = |name: &str| {
        url.query_pairs()
            .find_map(|(key, value)| (key == name).then(|| value.into_owned()))
    };
    if url.path() == "/s"
        && (query_value("__biz").as_deref() != Some(biz)
            || query_value("mid").as_deref() != Some(mid)
            || query_value("idx").as_deref() != Some(idx))
    {
        return None;
    }
    Some(url.to_string())
}

fn first_trimmed_string(value: &Value, names: &[&str]) -> Option<String> {
    names.iter().find_map(|name| {
        value
            .get(*name)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    })
}

fn parse_request_identity(value: &str) -> Option<(String, String, String)> {
    let value = value.trim();
    let normalized = if value.starts_with("http://") || value.starts_with("https://") {
        value.to_string()
    } else {
        format!("https://{value}")
    };
    let url = reqwest::Url::parse(&normalized).ok()?;
    let mut biz = None;
    let mut mid = None;
    let mut idx = None;
    for (name, value) in url.query_pairs() {
        match name.as_ref() {
            "__biz" => biz = Some(value.into_owned()),
            "mid" | "appmsgid" => mid = Some(value.into_owned()),
            "idx" | "itemidx" => idx = Some(value.into_owned()),
            _ => {}
        }
    }
    Some((biz?, mid?, idx.unwrap_or_else(|| "1".to_string())))
}

fn parse_sn_from_article_link(value: &str) -> Option<String> {
    let decoded = value.replace("&amp;", "&");
    let url = reqwest::Url::parse(decoded.trim()).ok()?;
    url.query_pairs()
        .find_map(|(name, value)| (name == "sn").then(|| value.into_owned()))
        .filter(|value| !value.is_empty())
}

fn json_decimal(value: &Value) -> Option<String> {
    match value {
        Value::String(value)
            if !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()) =>
        {
            Some(value.clone())
        }
        Value::Number(value) => value.as_u64().map(|value| value.to_string()),
        _ => None,
    }
}

fn json_i64(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_u64().and_then(|value| i64::try_from(value).ok()))
        .or_else(|| value.as_str().and_then(|value| value.parse::<i64>().ok()))
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    (!needle.is_empty())
        .then(|| {
            haystack
                .windows(needle.len())
                .position(|window| window == needle)
        })
        .flatten()
}

fn decompress_raw_snappy(input: &[u8]) -> Result<Vec<u8>, String> {
    let (expected_length, mut cursor) = read_varint(input, 0)?;
    if expected_length > MAX_DECOMPRESSED_BYTES {
        return Err("微信 XWorker 数据解压后过大".to_string());
    }
    let mut output = Vec::with_capacity(expected_length);
    while output.len() < expected_length {
        let tag = *input
            .get(cursor)
            .ok_or_else(|| "微信 XWorker Snappy 数据提前结束".to_string())?;
        cursor += 1;
        match tag & 0x03 {
            0 => {
                let length_code = usize::from(tag >> 2);
                let length = if length_code < 60 {
                    length_code + 1
                } else {
                    let width = length_code - 59;
                    if !(1..=4).contains(&width) || cursor.saturating_add(width) > input.len() {
                        return Err("微信 XWorker Snappy literal 长度无效".to_string());
                    }
                    let mut length_minus_one = 0_usize;
                    for shift in 0..width {
                        length_minus_one |= usize::from(input[cursor + shift]) << (shift * 8);
                    }
                    cursor += width;
                    length_minus_one
                        .checked_add(1)
                        .ok_or_else(|| "微信 XWorker Snappy literal 溢出".to_string())?
                };
                if cursor.saturating_add(length) > input.len()
                    || output.len().saturating_add(length) > expected_length
                {
                    return Err("微信 XWorker Snappy literal 越界".to_string());
                }
                output.extend_from_slice(&input[cursor..cursor + length]);
                cursor += length;
            }
            copy_type => {
                let (length, offset) = match copy_type {
                    1 => {
                        let next = *input
                            .get(cursor)
                            .ok_or_else(|| "微信 XWorker Snappy copy-1 不完整".to_string())?;
                        cursor += 1;
                        (
                            4 + usize::from((tag >> 2) & 0x07),
                            (usize::from(tag & 0xe0) << 3) | usize::from(next),
                        )
                    }
                    2 => {
                        if cursor.saturating_add(2) > input.len() {
                            return Err("微信 XWorker Snappy copy-2 不完整".to_string());
                        }
                        let offset =
                            usize::from(input[cursor]) | (usize::from(input[cursor + 1]) << 8);
                        cursor += 2;
                        (1 + usize::from(tag >> 2), offset)
                    }
                    3 => {
                        if cursor.saturating_add(4) > input.len() {
                            return Err("微信 XWorker Snappy copy-4 不完整".to_string());
                        }
                        let offset = u32::from_le_bytes([
                            input[cursor],
                            input[cursor + 1],
                            input[cursor + 2],
                            input[cursor + 3],
                        ]) as usize;
                        cursor += 4;
                        (1 + usize::from(tag >> 2), offset)
                    }
                    _ => unreachable!(),
                };
                if offset == 0
                    || offset > output.len()
                    || output.len().saturating_add(length) > expected_length
                {
                    return Err("微信 XWorker Snappy copy 越界".to_string());
                }
                for _ in 0..length {
                    let byte = output[output.len() - offset];
                    output.push(byte);
                }
            }
        }
    }
    Ok(output)
}

fn read_varint(input: &[u8], mut cursor: usize) -> Result<(usize, usize), String> {
    let mut value = 0_usize;
    for shift in (0..usize::BITS as usize).step_by(7) {
        let byte = *input
            .get(cursor)
            .ok_or_else(|| "微信 XWorker varint 不完整".to_string())?;
        cursor += 1;
        let part = usize::from(byte & 0x7f)
            .checked_shl(shift as u32)
            .ok_or_else(|| "微信 XWorker varint 溢出".to_string())?;
        value = value
            .checked_add(part)
            .ok_or_else(|| "微信 XWorker varint 溢出".to_string())?;
        if byte & 0x80 == 0 {
            return Ok((value, cursor));
        }
    }
    Err("微信 XWorker varint 过长".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_sanitized_account_feed_batch() {
        let content = serde_json::json!({
            "title": "测试文章",
            "nick_name": "测试公众号",
            "create_timestamp": 1_787_600_000_i64,
            "link": "https://mp.weixin.qq.com/s?__biz=Mzg3NDc2MjQxMg%3D%3D&amp;mid=2247495151&amp;idx=1&amp;sn=abc123",
            "user_info": {"appmsg_bar_data": {
                "read_num": 2212,
                "old_like_count": 51,
                "like_count": 27,
                "share_count": 367,
                "comment_count": 0,
                "collect_count": 125
            }}
        });
        let data = serde_json::json!({
            "mp.weixin.qq.com/s?__biz=Mzg3NDc2MjQxMg%3D%3D&mid=2247495151&idx=1": {
                "BizUin": 3_874_762_412_u64,
                "MsgId": 2_247_495_151_u64,
                "ItemIdx": 1,
                "Content": serde_json::to_string(&content).expect("serialize content"),
                "updateTime": 1_787_732_473_018_i64
            }
        })
        .to_string();
        let serialized = synthetic_v8_batch(&data);
        let mut blob = INDEXED_DB_WRAPPER.to_vec();
        blob.extend(snappy_literal(&serialized));

        let records = parse_xworker_blob(&blob, 0).expect("parse batch blob");

        assert_eq!(records.len(), 1);
        let record = &records[0];
        assert_eq!(record.biz, "Mzg3NDc2MjQxMg==");
        assert_eq!(record.mid, "2247495151");
        assert_eq!(record.idx, "1");
        assert_eq!(record.title, "测试文章");
        assert_eq!(record.sn.as_deref(), Some("abc123"));
        assert_eq!(
            record.link,
            "https://mp.weixin.qq.com/s?__biz=Mzg3NDc2MjQxMg%3D%3D&mid=2247495151&idx=1&sn=abc123"
        );
        assert!(record.transient_fetch_link.is_some());
        assert_eq!(record.read_count, Some(2212));
        assert_eq!(record.like_count, Some(51));
        assert_eq!(record.recommend_count, Some(27));
        assert_eq!(record.share_count, Some(367));
        assert_eq!(record.comment_count, Some(0));
        assert_eq!(record.collect_count, Some(125));
    }

    #[test]
    fn keeps_article_identity_when_social_metrics_are_absent() {
        let content = serde_json::json!({
            "title": "只有列表元数据的文章",
            "nick_name": "测试公众号",
            "digest": "摘要",
            "cdn_url": "https://mmbiz.qpic.cn/cover.jpg",
            "create_timestamp": 1_787_600_000_i64,
            "link": "https://mp.weixin.qq.com/s?__biz=Mzg3NDc2MjQxMg%3D%3D&amp;mid=2247495152&amp;idx=2&amp;sn=def456&amp;key=short-lived-secret&amp;pass_ticket=short-lived-ticket"
        });
        let data = serde_json::json!({
            "mp.weixin.qq.com/s?__biz=Mzg3NDc2MjQxMg%3D%3D&mid=2247495152&idx=2": {
                "Content": serde_json::to_string(&content).expect("serialize content"),
                "updateTime": 1_787_732_473_018_i64
            }
        })
        .to_string();

        let records = parse_batch_json(&data, 0).expect("parse list-only batch");

        assert_eq!(records.len(), 1);
        let record = &records[0];
        assert!(!record.has_any_metric());
        assert_eq!(record.biz, "Mzg3NDc2MjQxMg==");
        assert_eq!(record.mid, "2247495152");
        assert_eq!(record.idx, "2");
        assert_eq!(record.digest.as_deref(), Some("摘要"));
        assert_eq!(
            record.cover.as_deref(),
            Some("https://mmbiz.qpic.cn/cover.jpg")
        );
        assert_eq!(
            record.link,
            "https://mp.weixin.qq.com/s?__biz=Mzg3NDc2MjQxMg%3D%3D&mid=2247495152&idx=2&sn=def456"
        );
        let transient = record
            .transient_fetch_link
            .as_deref()
            .expect("authorized link should remain available in memory");
        assert!(transient.contains("key=short-lived-secret"));
        assert!(transient.contains("pass_ticket=short-lived-ticket"));
        assert!(!record.link.contains("short-lived"));
    }

    #[test]
    fn rejects_a_transient_link_for_another_article_identity() {
        assert!(safe_transient_article_link(
            "https://mp.weixin.qq.com/s?__biz=other&mid=42&idx=1&key=secret",
            "expected",
            "42",
            "1"
        )
        .is_none());
    }

    #[test]
    fn rejects_out_of_bounds_snappy_copy() {
        // output length 4, copy-1 with offset 1 before any literal
        let input = [4_u8, 1_u8, 1_u8];
        assert!(decompress_raw_snappy(&input).is_err());
    }

    #[test]
    #[ignore = "requires a real logged-in WeChat XWorker profile"]
    fn live_xworker_blob_contains_account_metrics() {
        let fakeid = std::env::var("WXMP_TEST_FAKEID")
            .expect("set WXMP_TEST_FAKEID to the target account id");
        let records = read_account_feed_metrics(&fakeid, 0).expect("read live account feed");

        assert!(!records.is_empty());
        assert!(records
            .iter()
            .all(AccountFeedArticleMetrics::has_any_metric));
        assert!(records.iter().all(|record| record.biz == fakeid));
        assert!(records.iter().any(|record| record.read_count.is_some()));
    }

    fn synthetic_v8_batch(data: &str) -> Vec<u8> {
        let mut bytes = vec![0xff, 0x0f, 0x6f, 0x22, 0x04];
        bytes.extend_from_slice(b"name");
        bytes.extend_from_slice(&[0x22, BATCH_RESPONSE_NAME.len() as u8]);
        bytes.extend_from_slice(BATCH_RESPONSE_NAME);
        bytes.extend_from_slice(V8_DATA_PROPERTY);
        bytes.push(0);
        bytes.push(V8_TWO_BYTE_STRING_TAG);
        let payload = data
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>();
        write_varint(payload.len(), &mut bytes);
        bytes.extend(payload);
        bytes
    }

    fn snappy_literal(payload: &[u8]) -> Vec<u8> {
        let mut bytes = Vec::new();
        write_varint(payload.len(), &mut bytes);
        let length_minus_one = payload.len() - 1;
        let width = if length_minus_one <= u8::MAX as usize {
            1
        } else if length_minus_one <= u16::MAX as usize {
            2
        } else if length_minus_one <= 0x00ff_ffff {
            3
        } else {
            4
        };
        bytes.push(((59 + width) << 2) as u8);
        for shift in 0..width {
            bytes.push(((length_minus_one >> (shift * 8)) & 0xff) as u8);
        }
        bytes.extend_from_slice(payload);
        bytes
    }

    fn write_varint(mut value: usize, target: &mut Vec<u8>) {
        loop {
            let mut byte = (value & 0x7f) as u8;
            value >>= 7;
            if value != 0 {
                byte |= 0x80;
            }
            target.push(byte);
            if value == 0 {
                break;
            }
        }
    }
}
