use std::collections::{HashMap, HashSet};
use std::fs;
use std::net::IpAddr;
use std::str::FromStr;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use napi_derive::napi;
use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};

#[napi(object)]
pub struct ClientClassResult {
    pub is_bot: bool,
    pub is_human: bool,
    pub client_type: String,
    pub label: String,
    pub risk_score: i32,
}

#[napi(object)]
pub struct EngineMetrics {
    pub version: String,
    pub active_rate_limit_entries: u32,
    pub blocked_tracker_domains_count: u32,
    pub rust_uptime_secs: f64,
    pub indexed_documents_count: u32,
    pub indexed_terms_count: u32,
    pub cleaned_urls_count: u32,
    pub queries_served_count: u32,
}

#[napi(object)]
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RustSearchResult {
    pub title: String,
    pub url: String,
    pub snippet: String,
    pub host: String,
    pub source: String,
    pub category: String,
    pub score: f64,
    pub is_onion: bool,
}

#[napi(object)]
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ExtractedPageData {
    pub title: String,
    pub description: String,
    pub text_excerpt: String,
    pub links: Vec<String>,
    pub onion_links: Vec<String>,
}

static START_TIME: Lazy<Instant> = Lazy::new(Instant::now);
static CLEANED_URLS_COUNT: AtomicU64 = AtomicU64::new(0);
static QUERIES_SERVED_COUNT: AtomicU64 = AtomicU64::new(0);

// =========================================================================
// 1. IP & SSRF SEGURANÇA (MEMORY SAFE & BITWISE VALIDATION)
// =========================================================================

fn is_ip_private_internal(ip_str: &str) -> bool {
    let mut clean = ip_str.trim();
    if let Some(stripped) = clean.strip_prefix("::ffff:") {
        clean = stripped;
    }
    if clean.starts_with('[') && clean.ends_with(']') {
        clean = &clean[1..clean.len() - 1];
    }
    if let Some(zone_idx) = clean.find('%') {
        clean = &clean[..zone_idx];
    }

    if clean == "localhost" || clean == "127.0.0.1" || clean == "::1" || clean == "::" {
        return true;
    }

    if let Ok(ip) = IpAddr::from_str(clean) {
        match ip {
            IpAddr::V4(ipv4) => {
                if ipv4.is_loopback() || ipv4.is_link_local() || ipv4.is_broadcast() || ipv4.is_documentation() {
                    return true;
                }
                let octets = ipv4.octets();
                if octets[0] == 10 {
                    return true;
                }
                if octets[0] == 172 && (16..=31).contains(&octets[1]) {
                    return true;
                }
                if octets[0] == 192 && octets[1] == 168 {
                    return true;
                }
                if octets[0] == 100 && (64..=127).contains(&octets[1]) {
                    return true;
                }
                if octets[0] == 0 {
                    return true;
                }
                false
            }
            IpAddr::V6(ipv6) => {
                if ipv6.is_loopback() || ipv6.is_unspecified() {
                    return true;
                }
                let segments = ipv6.segments();
                if (segments[0] & 0xfe00) == 0xfc00 {
                    return true;
                }
                if (segments[0] & 0xffc0) == 0xfe80 {
                    return true;
                }
                if let Some(mapped_v4) = ipv6.to_ipv4_mapped() {
                    return is_ip_private_internal(&mapped_v4.to_string());
                }
                false
            }
        }
    } else {
        if clean.starts_with("127.") || clean.starts_with("10.") || clean.starts_with("192.168.") {
            return true;
        }
        let lower = clean.to_lowercase();
        if lower.starts_with("fc") || lower.starts_with("fd") || lower.starts_with("fe80:") {
            return true;
        }
        false
    }
}

#[napi]
pub fn is_private_ip(ip: String) -> bool {
    is_ip_private_internal(&ip)
}

#[napi]
pub fn is_safe_proxy_host(host: String) -> bool {
    let clean = host.trim().to_lowercase();
    let host_only = clean.split(':').next().unwrap_or("").trim();
    if host_only.is_empty() {
        return false;
    }
    if host_only == "localhost"
        || host_only.ends_with(".localhost")
        || host_only.ends_with(".local")
        || host_only.ends_with(".internal")
        || host_only == "169.254.169.254"
        || host_only == "metadata.google.internal"
    {
        return false;
    }
    !is_ip_private_internal(host_only)
}

// =========================================================================
// 2. CLASSIFICADOR ULTRARRÁPIDO BOT vs HUMANO (COM REGEX COMPILADO)
// =========================================================================

static BOT_UA_REGEX: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)(bot|crawler|spider|scan|curl|wget|python|axios|postman|go-http|httpclient|zgrab|shodan|censys|nuclei|nikto|sqlmap|masscan|headless|phantom|selenium|puppeteer|googlebot|bingbot|yandex|claudebot|sitewatch|bytespider|duckduckbot|baiduspider|applebot|semrush|ahrefs|mj12bot)").unwrap()
});

static EXPLOIT_PATH_REGEX: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)(wp-|xmlrpc|\.env|\.git|phpmyadmin|actuator|\.aws|config\.json|setup\.php|phpinfo|eval-stdin|console|shell|\.well-known/security\.txt)").unwrap()
});

static INTERACTIVE_PATH_REGEX: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)(musica|filmes|query-ai|favorite-playlists|prewarm-playlist|stream-video|curator|device-telemetry)").unwrap()
});

#[napi]
pub fn classify_client(
    ip: String,
    user_agent: String,
    device: String,
    pages_json: String,
    is_local: bool,
    has_lan_or_screen: bool,
) -> ClientClassResult {
    let ua = user_agent.to_lowercase();
    let dev = device.to_lowercase();

    let pages: Vec<String> = serde_json::from_str(&pages_json).unwrap_or_default();

    if dev.contains("crawler") || dev.contains("robô") || dev.contains("curl") || dev.contains("postman") || BOT_UA_REGEX.is_match(&ua) {
        let label = if ua.contains("googlebot") || dev.contains("google") {
            "🤖 Googlebot".to_string()
        } else if ua.contains("claudebot") {
            "🤖 ClaudeBot (IA)".to_string()
        } else if ua.contains("sitewatch") {
            "📡 SiteWatch (Monitor)".to_string()
        } else if ua.contains("curl") {
            "⚡ Terminal / cURL".to_string()
        } else if ua.contains("python") || ua.contains("go-http") || ua.contains("axios") {
            "🤖 Script / Bot Automatizado".to_string()
        } else if ua.contains("shodan") || ua.contains("censys") || ua.contains("zgrab") {
            "🛡️ Scanner de Rede Conhecido".to_string()
        } else {
            "🤖 Robô / Crawler".to_string()
        };

        return ClientClassResult {
            is_bot: true,
            is_human: false,
            client_type: "bot".to_string(),
            label,
            risk_score: 50,
        };
    }

    let has_exploit = pages.iter().any(|p| EXPLOIT_PATH_REGEX.is_match(p));
    if has_exploit {
        return ClientClassResult {
            is_bot: true,
            is_human: false,
            client_type: "bot".to_string(),
            label: "🛡️ Scanner de Falhas".to_string(),
            risk_score: 95,
        };
    }

    if is_local || is_ip_private_internal(&ip) {
        return ClientClassResult {
            is_bot: false,
            is_human: true,
            client_type: "human".to_string(),
            label: "👤 Usuário Real (Wi-Fi Local)".to_string(),
            risk_score: 0,
        };
    }

    if has_lan_or_screen {
        return ClientClassResult {
            is_bot: false,
            is_human: true,
            client_type: "human".to_string(),
            label: "👤 Usuário Real (Dispositivo Confirmado)".to_string(),
            risk_score: 5,
        };
    }

    let has_interactive = pages.iter().any(|p| INTERACTIVE_PATH_REGEX.is_match(p));
    let is_residential_ipv6 = ip.starts_with("2804:") || ip.starts_with("2800:");

    if has_interactive || (is_residential_ipv6 && pages.len() >= 2) {
        return ClientClassResult {
            is_bot: false,
            is_human: true,
            client_type: "human".to_string(),
            label: "👤 Usuário Real (Navegação Ativa)".to_string(),
            risk_score: 10,
        };
    }

    if pages.len() <= 2
        && (pages.iter().any(|p| p == "/" || p == "/robots.txt" || p == "/favicon.ico" || p == "/ads.txt"))
    {
        return ClientClassResult {
            is_bot: true,
            is_human: false,
            client_type: "bot".to_string(),
            label: "🤖 Varredura Web (Scanner)".to_string(),
            risk_score: 60,
        };
    }

    if pages.len() >= 3 && !is_residential_ipv6 {
        return ClientClassResult {
            is_bot: true,
            is_human: false,
            client_type: "bot".to_string(),
            label: "🤖 Scraper / Bot Automático".to_string(),
            risk_score: 70,
        };
    }

    ClientClassResult {
        is_bot: true,
        is_human: false,
        client_type: "bot".to_string(),
        label: "🤖 Robô Automático".to_string(),
        risk_score: 55,
    }
}

// =========================================================================
// 3. BLOQUEADOR DE RASTREADORES, ANÚNCIOS E LIMPEZA DE URLS (ZERO COOKIES)
// =========================================================================

static TRACKER_DOMAINS: Lazy<HashSet<&'static str>> = Lazy::new(|| {
    let mut s = HashSet::new();
    let domains = [
        "doubleclick.net",
        "google-analytics.com",
        "googletagmanager.com",
        "googlesyndication.com",
        "googleadservices.com",
        "criteo.com",
        "adnxs.com",
        "outbrain.com",
        "taboola.com",
        "facebook.com/tr",
        "connect.facebook.net",
        "ads-twitter.com",
        "analytics.tiktok.com",
        "mc.yandex.ru",
        "hotjar.com",
        "clarity.ms",
        "mixpanel.com",
        "segment.io",
        "scorecardresearch.com",
        "quantserve.com",
        "amazon-adsystem.com",
        "adservice.google.com",
        "popads.net",
        "adsterra.com",
        "exoclick.com",
        "propellerads.com",
        "trafficjunky.com",
        "coinhive.com",
        "crypto-loot.com",
        "fingerprintjs.com",
        "appsflyer.com",
        "adjust.com",
        "branch.io",
        "omtrdc.net",
        "demdex.net",
        "bluekai.com",
        "krxd.net",
        "rubiconproject.com",
        "pubmatic.com",
        "openx.net",
    ];
    for d in domains {
        s.insert(d);
    }
    s
});

static TRACKING_PARAMS: Lazy<HashSet<&'static str>> = Lazy::new(|| {
    let mut s = HashSet::new();
    let params = [
        "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_id",
        "fbclid", "gclid", "dclid", "msclkid", "twclid", "ttclid", "yclid",
        "mc_cid", "mc_eid", "_ga", "_gl", "_hsenc", "_hsmi", "hsCtaTracking",
        "vero_id", "oly_enc_id", "oly_anon_id", "rb_clickid", "s_kwcid",
        "igshid", "si", "spm", "scm",
    ];
    for p in params {
        s.insert(p);
    }
    s
});

#[napi]
pub fn is_tracker_or_ad(url_or_domain: String) -> bool {
    let lower = url_or_domain.to_lowercase();
    for domain in TRACKER_DOMAINS.iter() {
        if lower.contains(*domain) {
            return true;
        }
    }
    false
}

#[napi]
pub fn strip_tracking_params(raw_url: String) -> String {
    let trimmed = raw_url.trim();
    let q_idx = match trimmed.find('?') {
        Some(idx) => idx,
        None => return trimmed.to_string(),
    };

    let (base, rest) = trimmed.split_at(q_idx);
    let rest_without_q = &rest[1..];
    let (query_part, fragment_part) = match rest_without_q.find('#') {
        Some(h_idx) => (&rest_without_q[..h_idx], &rest_without_q[h_idx..]),
        None => (rest_without_q, ""),
    };

    let mut kept_pairs = Vec::new();
    let mut removed_any = false;

    for pair in query_part.split('&') {
        if pair.is_empty() {
            continue;
        }
        let key = pair.split('=').next().unwrap_or("").trim().to_lowercase();
        if TRACKING_PARAMS.contains(key.as_str()) || key.starts_with("utm_") {
            removed_any = true;
        } else {
            kept_pairs.push(pair);
        }
    }

    if removed_any {
        CLEANED_URLS_COUNT.fetch_add(1, Ordering::Relaxed);
    }

    if kept_pairs.is_empty() {
        format!("{}{}", base, fragment_part)
    } else {
        format!("{}?{}{}", base, kept_pairs.join("&"), fragment_part)
    }
}

// =========================================================================
// 4. RATE LIMITER DE ALTA PERFORMANCE (TOKEN BUCKET EM MEMÓRIA NATIVO)
// =========================================================================

struct TokenBucket {
    tokens: f64,
    last_update: Instant,
}

static RATE_LIMITER: Lazy<Mutex<HashMap<String, TokenBucket>>> =
    Lazy::new(|| Mutex::new(HashMap::with_capacity(512)));

#[napi]
pub fn check_rate_limit(
    ip: String,
    max_burst: u32,
    refill_rate_per_sec: u32,
) -> bool {
    let mut table = match RATE_LIMITER.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };

    let now = Instant::now();
    let max_b = max_burst as f64;
    let refill_rate = refill_rate_per_sec as f64;

    if table.len() > 2000 {
        table.retain(|_, b| now.duration_since(b.last_update).as_secs() < 300);
    }

    let bucket = table.entry(ip).or_insert_with(|| TokenBucket {
        tokens: max_b,
        last_update: now,
    });

    let elapsed = now.duration_since(bucket.last_update).as_secs_f64();
    bucket.tokens = (bucket.tokens + elapsed * refill_rate).min(max_b);
    bucket.last_update = now;

    if bucket.tokens >= 1.0 {
        bucket.tokens -= 1.0;
        true
    } else {
        false
    }
}

// =========================================================================
// 5. MOTOR DE BUSCA E INDEXADOR NATIVO EM RUST (BM25 + INVERTED INDEX)
// =========================================================================

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct IndexedDoc {
    pub url: String,
    pub normalized_url: String,
    pub host: String,
    pub title: String,
    pub snippet: String,
    pub category: String,
    pub is_onion: bool,
    pub visit_count: u32,
    pub updated_at: u64,
    pub doc_len: usize,
    pub term_freqs: HashMap<String, u32>,
}

pub struct NativeSearchEngine {
    pub docs: Vec<IndexedDoc>,
    pub url_to_id: HashMap<String, usize>,
    pub inverted_index: HashMap<String, Vec<usize>>,
    pub total_doc_len: usize,
}

static STOPWORDS: Lazy<HashSet<&'static str>> = Lazy::new(|| {
    let words = [
        "de", "da", "do", "das", "dos", "em", "no", "na", "nos", "nas", "um", "uma", "uns", "umas",
        "para", "por", "com", "sem", "sob", "sobre", "entre", "ate", "como", "qual", "quais", "quem",
        "onde", "quando", "porque", "que", "foi", "era", "sao", "ser", "esta", "este", "isso", "mais",
        "menos", "the", "and", "for", "with", "from", "this", "that", "are", "was", "were", "http",
        "https", "www", "com", "org", "net", "br",
    ];
    let mut s = HashSet::new();
    for w in words {
        s.insert(w);
    }
    s
});

fn fold_diacritics(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for c in input.chars() {
        let mapped = match c {
            'á' | 'à' | 'â' | 'ã' | 'ä' | 'Á' | 'À' | 'Â' | 'Ã' | 'Ä' => 'a',
            'é' | 'è' | 'ê' | 'ë' | 'É' | 'È' | 'Ê' | 'Ë' => 'e',
            'í' | 'ì' | 'î' | 'ï' | 'Í' | 'Ì' | 'Î' | 'Ï' => 'i',
            'ó' | 'ò' | 'ô' | 'õ' | 'ö' | 'Ó' | 'Ò' | 'Ô' | 'Õ' | 'Ö' => 'o',
            'ú' | 'ù' | 'û' | 'ü' | 'Ú' | 'Ù' | 'Û' | 'Ü' => 'u',
            'ç' | 'Ç' => 'c',
            'ñ' | 'Ñ' => 'n',
            'ý' | 'ÿ' | 'Ý' => 'y',
            _ => c.to_ascii_lowercase(),
        };
        out.push(mapped);
    }
    out
}

fn tokenize_text(text: &str) -> Vec<String> {
    let folded = fold_diacritics(text);
    let mut tokens = Vec::new();
    let mut current = String::new();

    for ch in folded.chars() {
        if ch.is_ascii_alphanumeric() {
            current.push(ch);
        } else if !current.is_empty() {
            if current.len() >= 2 && !STOPWORDS.contains(current.as_str()) {
                tokens.push(current.clone());
            }
            current.clear();
        }
    }
    if current.len() >= 2 && !STOPWORDS.contains(current.as_str()) {
        tokens.push(current);
    }
    tokens
}

fn extract_host(url: &str) -> String {
    let after_scheme = if let Some(idx) = url.find("://") {
        &url[idx + 3..]
    } else {
        url
    };
    let host_port = after_scheme.split('/').next().unwrap_or("");
    let host = host_port.split(':').next().unwrap_or("").to_lowercase();
    host.strip_prefix("www.").unwrap_or(&host).to_string()
}

fn normalize_url_key(url: &str) -> String {
    let clean = strip_tracking_params(url.trim().to_string());
    let without_scheme = clean
        .strip_prefix("https://")
        .or_else(|| clean.strip_prefix("http://"))
        .unwrap_or(&clean);
    let without_www = without_scheme.strip_prefix("www.").unwrap_or(without_scheme);
    without_www.trim_end_matches('/').to_lowercase()
}

impl NativeSearchEngine {
    pub fn new_with_seeds() -> Self {
        let mut engine = NativeSearchEngine {
            docs: Vec::with_capacity(1024),
            url_to_id: HashMap::with_capacity(1024),
            inverted_index: HashMap::with_capacity(4096),
            total_doc_len: 0,
        };
        engine.seed_builtin_knowledge();
        engine
    }

    pub fn upsert_document(
        &mut self,
        url: &str,
        title: &str,
        snippet: &str,
        extra_body: &str,
        category: &str,
    ) -> bool {
        let clean_url = strip_tracking_params(url.trim().to_string());
        if !clean_url.starts_with("http://") && !clean_url.starts_with("https://") {
            return false;
        }
        let clean_title = decode_html_entities_internal(title).trim().to_string();
        if clean_title.len() < 2 {
            return false;
        }
        let clean_snippet = decode_html_entities_internal(snippet).trim().to_string();
        let norm_key = normalize_url_key(&clean_url);
        if norm_key.is_empty() {
            return false;
        }

        let host = extract_host(&clean_url);
        let is_onion = host.ends_with(".onion");
        let now_secs = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);

        if let Some(&existing_id) = self.url_to_id.get(&norm_key) {
            if let Some(existing_doc) = self.docs.get_mut(existing_id) {
                existing_doc.visit_count = existing_doc.visit_count.saturating_add(1);
                existing_doc.updated_at = now_secs;
                if clean_snippet.len() > existing_doc.snippet.len() {
                    existing_doc.snippet = clean_snippet;
                }
                if clean_title.len() > existing_doc.title.len() {
                    existing_doc.title = clean_title;
                }
                return true;
            }
        }

        // Calcula frequências de termos com pesos: título (peso 4), host (peso 3), snippet (peso 2), extra_body (peso 1)
        let mut term_freqs: HashMap<String, u32> = HashMap::new();
        let mut doc_len: usize = 0;

        for tok in tokenize_text(&clean_title) {
            *term_freqs.entry(tok).or_insert(0) += 4;
            doc_len += 4;
        }
        for tok in tokenize_text(&host) {
            *term_freqs.entry(tok).or_insert(0) += 3;
            doc_len += 3;
        }
        for tok in tokenize_text(&clean_snippet) {
            *term_freqs.entry(tok).or_insert(0) += 2;
            doc_len += 2;
        }
        for tok in tokenize_text(extra_body) {
            *term_freqs.entry(tok).or_insert(0) += 1;
            doc_len += 1;
        }

        if term_freqs.is_empty() {
            return false;
        }

        let doc_id = self.docs.len();
        for term in term_freqs.keys() {
            self.inverted_index
                .entry(term.clone())
                .or_default()
                .push(doc_id);
        }

        self.total_doc_len += doc_len.max(1);
        self.url_to_id.insert(norm_key.clone(), doc_id);
        self.docs.push(IndexedDoc {
            url: clean_url,
            normalized_url: norm_key,
            host,
            title: clean_title,
            snippet: clean_snippet,
            category: if category.is_empty() { "web".to_string() } else { category.to_string() },
            is_onion,
            visit_count: 1,
            updated_at: now_secs,
            doc_len: doc_len.max(1),
            term_freqs,
        });

        true
    }

    pub fn search(&self, query: &str, limit: usize, only_onion: bool) -> Vec<RustSearchResult> {
        QUERIES_SERVED_COUNT.fetch_add(1, Ordering::Relaxed);
        let q_tokens = tokenize_text(query);
        if q_tokens.is_empty() || self.docs.is_empty() {
            return Vec::new();
        }

        let n_docs = self.docs.len() as f64;
        let avg_dl = (self.total_doc_len as f64 / n_docs).max(1.0);
        let k1 = 1.5;
        let b = 0.75;

        let mut candidate_scores: HashMap<usize, f64> = HashMap::new();
        let mut matched_terms_count: HashMap<usize, usize> = HashMap::new();

        for term in &q_tokens {
            if let Some(posting_list) = self.inverted_index.get(term) {
                let df = posting_list.len() as f64;
                let idf = ((n_docs - df + 0.5) / (df + 0.5) + 1.0).ln();

                for &doc_id in posting_list {
                    let doc = &self.docs[doc_id];
                    if only_onion && !doc.is_onion {
                        continue;
                    }
                    let tf = *doc.term_freqs.get(term).unwrap_or(&0) as f64;
                    if tf > 0.0 {
                        let dl = doc.doc_len as f64;
                        let tf_norm = (tf * (k1 + 1.0)) / (tf + k1 * (1.0 - b + b * (dl / avg_dl)));
                        *candidate_scores.entry(doc_id).or_insert(0.0) += idf * tf_norm;
                        *matched_terms_count.entry(doc_id).or_insert(0) += 1;
                    }
                }
            }

            // Prefix match para termos >= 4 letras (ex: "inteligen" casa com "inteligencia")
            if term.len() >= 4 {
                for (indexed_term, posting_list) in &self.inverted_index {
                    if indexed_term != term && indexed_term.starts_with(term) {
                        let df = posting_list.len() as f64;
                        let idf = (((n_docs - df + 0.5) / (df + 0.5) + 1.0).ln()) * 0.6;
                        for &doc_id in posting_list {
                            let doc = &self.docs[doc_id];
                            if only_onion && !doc.is_onion {
                                continue;
                            }
                            let tf = *doc.term_freqs.get(indexed_term).unwrap_or(&0) as f64;
                            if tf > 0.0 {
                                *candidate_scores.entry(doc_id).or_insert(0.0) += idf * 1.2;
                                *matched_terms_count.entry(doc_id).or_insert(0) += 1;
                            }
                        }
                    }
                }
            }
        }

        let folded_query = fold_diacritics(query.trim());
        let min_required_terms = if q_tokens.len() >= 3 { 2 } else { 1 };

        let mut scored: Vec<(usize, f64)> = candidate_scores
            .into_iter()
            .filter_map(|(doc_id, mut score)| {
                let matched = *matched_terms_count.get(&doc_id).unwrap_or(&0);
                if matched < min_required_terms {
                    return None;
                }
                let doc = &self.docs[doc_id];
                let folded_title = fold_diacritics(&doc.title);
                if !folded_query.is_empty() && folded_title.contains(&folded_query) {
                    score += 8.0; // Frase exata no título
                }
                // Bônus por cobrir todos os termos da pesquisa
                if matched >= q_tokens.len() {
                    score *= 1.35;
                }
                // Bônus leve por popularidade/visitas
                score += (doc.visit_count as f64).ln_1p() * 0.4;
                Some((doc_id, score))
            })
            .collect();

        scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

        scored
            .into_iter()
            .take(limit.max(1))
            .map(|(doc_id, score)| {
                let d = &self.docs[doc_id];
                RustSearchResult {
                    title: d.title.clone(),
                    url: d.url.clone(),
                    snippet: d.snippet.clone(),
                    host: d.host.clone(),
                    source: "rust-index".to_string(),
                    category: d.category.clone(),
                    score,
                    is_onion: d.is_onion,
                }
            })
            .collect()
    }

    fn seed_builtin_knowledge(&mut self) {
        let seeds = [
            ("https://pt.wikipedia.org/wiki/Wikip%C3%A9dia:P%C3%A1gina_principal", "Wikipédia, a enciclopédia livre em português", "Enciclopédia colaborativa com milhões de artigos sobre ciência, história, tecnologia, geografia, biografias e cultura do Brasil e do mundo.", "enciclopedia ciencia historia brasil mundo cultura pesquisa", "wikipedia"),
            ("https://pt.wikipedia.org/wiki/Intelig%C3%AAncia_artificial", "Inteligência Artificial — Wikipédia", "Inteligência artificial (IA) é a inteligência demonstrada por máquinas e sistemas computacionais, aprendizado de máquina, redes neurais profundas e LLMs.", "ia machine learning deep learning algoritmos tecnologia", "wikipedia"),
            ("https://pt.wikipedia.org/wiki/Brasil", "Brasil — Wikipédia, a enciclopédia livre", "República Federativa do Brasil, maior país da América do Sul, história, geografia, economia, estados, cultura e política brasileira.", "america do sul brasilia estados economia historia", "wikipedia"),
            ("https://pt.wikipedia.org/wiki/Tor_(rede_de_anonimato)", "Tor (rede de anonimato) — Wikipédia", "O Tor (The Onion Router) é um software livre e rede aberta que protege contra vigilância de tráfego e garante privacidade e navegação anônima.", "privacidade seguranca cibernetica criptografia onion dark web", "wikipedia"),
            ("https://pt.wikipedia.org/wiki/Rust_(linguagem_de_programa%C3%A7%C3%A3o)", "Rust (linguagem de programação) — Wikipédia", "Rust é uma linguagem de programação multiparadigma compilada focada em alta performance, concorrência segura e segurança de memória sem garbage collector.", "programacao sistemas compilador velocidade memoria", "wikipedia"),
            ("https://www.gov.br/pt-br", "Portal Gov.br — Governo Federal do Brasil", "Serviços públicos digitais do Governo Federal do Brasil, consulta de documentos, INSS, Receita Federal, educação, saúde e cidadania.", "servicos publicos governo federal receita inss", "gov"),
            ("https://g1.globo.com/", "G1 — O portal de notícias da Globo", "Últimas notícias do Brasil e do mundo sobre política, economia, tecnologia, ciência, educação, saúde e tempo real.", "noticias jornalismo brasil mundo politica economia", "news"),
            ("https://www.bbc.com/portuguese", "BBC News Brasil — Notícias e Análises Internacionais", "Reportagens especiais, ciência, saúde, tecnologia, economia e notícias internacionais em português pela BBC News Brasil.", "noticias internacional ciencia reportagens", "news"),
            ("https://github.com/", "GitHub — Plataforma de código-fonte e projetos Open Source", "Hospedagem de código, repositórios Git, projetos de software livre, inteligência artificial, Rust, Node.js, Python e Linux.", "programacao codigo open source git software", "tech"),
            ("https://www.rust-lang.org/pt-BR", "Rust Programming Language — Site Oficial", "Uma linguagem que empodera a todos para construir softwares confiáveis e eficientes de altíssima performance.", "rust linguagem compilador webassembly sistemas", "tech"),
            ("https://check.torproject.org/", "Tor Project — Verificador de Conexão Tor", "Página oficial do Tor Project para verificar se o seu navegador está conectado através da rede anônima Tor.", "tor anonimato ip privacidade", "privacy"),
            ("https://archive.org/", "Internet Archive — Biblioteca Digital Gratuita", "Acervo mundial gratuito com milhões de livros, filmes, softwares, músicas e páginas históricas da internet via Wayback Machine.", "biblioteca livros arquivos historia wayback", "archive"),
            ("https://arxiv.org/", "arXiv.org — Repositório Científico de Artigos (Física, Matemática, Ciência da Computação, IA)", "Acesso aberto a mais de 2 milhões de artigos científicos em inteligência artificial, física quântica, matemática e computação.", "ciencia artigos pesquisa fisica matematica computacao", "science"),
            ("https://scielo.br/", "SciELO Brasil — Scientific Electronic Library Online", "Biblioteca eletrônica que abrange uma coleção selecionada de periódicos científicos brasileiros em acesso aberto.", "artigos cientificos universidades pesquisa brasil", "science"),
        ];

        for (url, title, snippet, extra, cat) in seeds {
            self.upsert_document(url, title, snippet, extra, cat);
        }
    }
}

static SEARCH_ENGINE: Lazy<Mutex<NativeSearchEngine>> =
    Lazy::new(|| Mutex::new(NativeSearchEngine::new_with_seeds()));

// =========================================================================
// 6. PARSERS DE HTML, DECODIFICADOR DE ENTIDADES E EXTRATOR DE LINKS EM RUST
// =========================================================================

static TAG_REGEX: Lazy<Regex> = Lazy::new(|| Regex::new(r"<[^>]+>").unwrap());
static SCRIPT_STYLE_REGEX: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?is)<(?:script|style|noscript|svg|head|footer|nav)[^>]*>.*?</(?:script|style|noscript|svg|head|footer|nav)>").unwrap()
});
static TITLE_REGEX: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?is)<title[^>]*>(.*?)</title>").unwrap());
static META_DESC_REGEX: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?is)<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']|<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']"#).unwrap()
});
static HREF_REGEX: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?i)href=["'](https?://[^"'#\s<>]+)"#).unwrap()
});
static ONION_URL_REGEX: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?i)https?://[a-z2-7]{16,56}\.onion(?:/[^\s"'<>)]*)?"#).unwrap()
});

fn decode_html_entities_internal(input: &str) -> String {
    if !input.contains('&') {
        return input.split_whitespace().collect::<Vec<_>>().join(" ");
    }
    let replaced = input
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&#39;", "'")
        .replace("&#x27;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&nbsp;", " ")
        .replace("&aacute;", "á").replace("&Aacute;", "Á")
        .replace("&eacute;", "é").replace("&Eacute;", "É")
        .replace("&iacute;", "í").replace("&Iacute;", "Í")
        .replace("&oacute;", "ó").replace("&Oacute;", "Ó")
        .replace("&uacute;", "ú").replace("&Uacute;", "Ú")
        .replace("&acirc;", "â").replace("&Acirc;", "Â")
        .replace("&ecirc;", "ê").replace("&Ecirc;", "Ê")
        .replace("&ocirc;", "ô").replace("&Ocirc;", "Ô")
        .replace("&atilde;", "ã").replace("&Atilde;", "Ã")
        .replace("&otilde;", "õ").replace("&Otilde;", "Õ")
        .replace("&ccedil;", "ç").replace("&Ccedil;", "Ç")
        .replace("&agrave;", "à").replace("&Agrave;", "À")
        .replace("&uuml;", "ü").replace("&Uuml;", "Ü")
        .replace("&ntilde;", "ñ").replace("&Ntilde;", "Ñ")
        .replace("&ndash;", "–").replace("&mdash;", "—")
        .replace("&hellip;", "…").replace("&middot;", "·")
        .replace("&laquo;", "«").replace("&raquo;", "»")
        .replace("&amp;", "&");

    replaced.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn strip_html_tags_internal(html: &str) -> String {
    let without_tags = TAG_REGEX.replace_all(html, " ");
    decode_html_entities_internal(&without_tags)
}

#[napi]
pub fn clean_html_text(html: String) -> String {
    strip_html_tags_internal(&html)
}

#[napi]
pub fn extract_page_metadata_and_links(base_url: String, html: String) -> ExtractedPageData {
    let title = TITLE_REGEX
        .captures(&html)
        .and_then(|c| c.get(1))
        .map(|m| strip_html_tags_internal(m.as_str()))
        .unwrap_or_default();

    let description = META_DESC_REGEX
        .captures(&html)
        .and_then(|c| c.get(1).or_else(|| c.get(2)))
        .map(|m| decode_html_entities_internal(m.as_str()))
        .unwrap_or_default();

    let cleaned_body = SCRIPT_STYLE_REGEX.replace_all(&html, " ");
    let body_text = strip_html_tags_internal(&cleaned_body);
    let text_excerpt: String = body_text.chars().take(600).collect();

    let mut links = Vec::new();
    let mut seen_links = HashSet::new();
    for cap in HREF_REGEX.captures_iter(&html) {
        if let Some(m) = cap.get(1) {
            let clean = strip_tracking_params(m.as_str().replace("&amp;", "&"));
            if !is_tracker_or_ad(clean.clone()) && seen_links.insert(clean.clone()) {
                links.push(clean);
                if links.len() >= 60 {
                    break;
                }
            }
        }
    }

    let mut onion_links = Vec::new();
    let mut seen_onions = HashSet::new();
    for m in ONION_URL_REGEX.find_iter(&html) {
        let onion = m.as_str().to_string();
        if seen_onions.insert(onion.clone()) {
            onion_links.push(onion);
        }
    }

    // Auto-indexa a própria página visitada no motor de busca nativo Rust!
    if !base_url.is_empty() && !title.is_empty() {
        let snip = if !description.is_empty() {
            description.clone()
        } else {
            body_text.chars().take(240).collect()
        };
        if let Ok(mut engine) = SEARCH_ENGINE.lock() {
            engine.upsert_document(&base_url, &title, &snip, &text_excerpt, "crawled");
        }
    }

    ExtractedPageData {
        title,
        description,
        text_excerpt,
        links,
        onion_links,
    }
}

#[napi]
pub fn index_document(
    url: String,
    title: String,
    snippet: String,
    extra_body: String,
    category: String,
) -> bool {
    let mut engine = match SEARCH_ENGINE.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    engine.upsert_document(&url, &title, &snippet, &extra_body, &category)
}

#[derive(Deserialize)]
struct BatchDocInput {
    url: String,
    title: String,
    #[serde(default)]
    snippet: String,
    #[serde(default)]
    source: String,
}

#[napi]
pub fn index_documents_batch(docs_json: String) -> u32 {
    let items: Vec<BatchDocInput> = match serde_json::from_str(&docs_json) {
        Ok(v) => v,
        Err(_) => return 0,
    };
    let mut engine = match SEARCH_ENGINE.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    let mut count = 0;
    for item in items {
        if engine.upsert_document(&item.url, &item.title, &item.snippet, "", &item.source) {
            count += 1;
        }
    }
    count
}

#[napi]
pub fn search_local_index(query: String, limit: u32, only_onion: bool) -> Vec<RustSearchResult> {
    let engine = match SEARCH_ENGINE.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    engine.search(&query, limit as usize, only_onion)
}

#[derive(Serialize, Deserialize)]
struct PersistedIndex {
    docs: Vec<(String, String, String, String)>, // (url, title, snippet, category)
}

#[napi]
pub fn save_search_index(file_path: String) -> bool {
    let snapshot: Vec<(String, String, String, String)> = {
        let engine = match SEARCH_ENGINE.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        engine
            .docs
            .iter()
            .take(5000)
            .map(|d| (d.url.clone(), d.title.clone(), d.snippet.clone(), d.category.clone()))
            .collect()
    };

    if let Ok(json) = serde_json::to_string(&PersistedIndex { docs: snapshot }) {
        fs::write(file_path, json).is_ok()
    } else {
        false
    }
}

#[napi]
pub fn load_search_index(file_path: String) -> u32 {
    let content = match fs::read_to_string(file_path) {
        Ok(c) => c,
        Err(_) => return 0,
    };
    let persisted: PersistedIndex = match serde_json::from_str(&content) {
        Ok(p) => p,
        Err(_) => return 0,
    };
    let mut engine = match SEARCH_ENGINE.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    let mut loaded = 0;
    for (url, title, snippet, category) in persisted.docs {
        if engine.upsert_document(&url, &title, &snippet, "", &category) {
            loaded += 1;
        }
    }
    loaded
}

// =========================================================================
// 7. DETECTOR NATIVO DE SISTEMA OPERACIONAL (WINDOWS, LINUX, ANDROID, IOS)
// =========================================================================

#[napi(object)]
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct OsPlatformInfo {
    pub os_id: String,
    pub os_name: String,
    pub short_label: String,
    pub icon: String,
    pub download_url: String,
    pub file_name: String,
    pub badge: String,
    pub is_mobile: bool,
}

#[napi]
pub fn detect_os_platform(user_agent: String, sec_ch_platform: String) -> OsPlatformInfo {
    let ua = user_agent.to_lowercase();
    let ch = sec_ch_platform.to_lowercase();

    if ua.contains("iphone") || ua.contains("ipad") || ua.contains("ipod") || ch.contains("ios") {
        return OsPlatformInfo {
            os_id: "ios".to_string(),
            os_name: "iPhone / iPad (iOS)".to_string(),
            short_label: "Baixar App iOS".to_string(),
            icon: "🍎".to_string(),
            download_url: "/download/app?os=ios".to_string(),
            file_name: "Papaleguas-iOS.mobileconfig".to_string(),
            badge: "WebClip Nativo iOS • Tela Cheia".to_string(),
            is_mobile: true,
        };
    }

    if ua.contains("android") || ch.contains("android") {
        return OsPlatformInfo {
            os_id: "android".to_string(),
            os_name: "Android (Smartphone / Tablet / TV)".to_string(),
            short_label: "Baixar App Android".to_string(),
            icon: "🤖".to_string(),
            download_url: "/download/app?os=android".to_string(),
            file_name: "Papaleguas-Android-Installer.html".to_string(),
            badge: "App Nativo Android • Sem Anúncios".to_string(),
            is_mobile: true,
        };
    }

    if ua.contains("windows") || ua.contains("win64") || ua.contains("win32") || ch.contains("windows") {
        return OsPlatformInfo {
            os_id: "windows".to_string(),
            os_name: "Windows 10 / 11 (64-bit)".to_string(),
            short_label: "Baixar p/ Windows".to_string(),
            icon: "🪟".to_string(),
            download_url: "/download/app?os=windows".to_string(),
            file_name: "Instalar-Papaleguas-Windows.cmd".to_string(),
            badge: "Instalador Desktop Windows".to_string(),
            is_mobile: false,
        };
    }

    if ua.contains("linux") || ua.contains("x11") || ua.contains("ubuntu") || ch.contains("linux") {
        return OsPlatformInfo {
            os_id: "linux".to_string(),
            os_name: "Linux (Ubuntu / Debian / Mint / 64-bit)".to_string(),
            short_label: "Baixar p/ Linux".to_string(),
            icon: "🐧".to_string(),
            download_url: "/download/app?os=linux".to_string(),
            file_name: "instalar-papaleguas-linux.sh".to_string(),
            badge: "Instalador Nativo Linux".to_string(),
            is_mobile: false,
        };
    }

    if ua.contains("macintosh") || ua.contains("mac os x") || ch.contains("mac") {
        return OsPlatformInfo {
            os_id: "ios".to_string(),
            os_name: "Apple (macOS / iOS)".to_string(),
            short_label: "Baixar App Apple".to_string(),
            icon: "🍎".to_string(),
            download_url: "/download/app?os=ios".to_string(),
            file_name: "Papaleguas-iOS.mobileconfig".to_string(),
            badge: "App Nativo Apple".to_string(),
            is_mobile: false,
        };
    }

    OsPlatformInfo {
        os_id: "windows".to_string(),
        os_name: "Windows / Multiplataforma".to_string(),
        short_label: "Baixar App".to_string(),
        icon: "🚀".to_string(),
        download_url: "/download/app?os=windows".to_string(),
        file_name: "Instalar-Papaleguas-Windows.cmd".to_string(),
        badge: "Super Navegador Papaléguas".to_string(),
        is_mobile: false,
    }
}

// =========================================================================
// 8. STATUS DO MOTOR RUST v2.0
// =========================================================================

#[napi]
pub fn rust_version() -> String {
    "Papaleguas Rust Engine v2.0.0 (BM25 Search Indexer + Zero-Cookie Shield)".to_string()
}

#[napi]
pub fn get_engine_metrics() -> EngineMetrics {
    let table = RATE_LIMITER.lock().ok();
    let active_entries = table.map(|t| t.len() as u32).unwrap_or(0);
    let uptime = START_TIME.elapsed().as_secs_f64();

    let (indexed_docs, indexed_terms) = match SEARCH_ENGINE.lock() {
        Ok(eng) => (eng.docs.len() as u32, eng.inverted_index.len() as u32),
        Err(_) => (0, 0),
    };

    EngineMetrics {
        version: "2.0.0".to_string(),
        active_rate_limit_entries: active_entries,
        blocked_tracker_domains_count: TRACKER_DOMAINS.len() as u32,
        rust_uptime_secs: uptime,
        indexed_documents_count: indexed_docs,
        indexed_terms_count: indexed_terms,
        cleaned_urls_count: CLEANED_URLS_COUNT.load(Ordering::Relaxed) as u32,
        queries_served_count: QUERIES_SERVED_COUNT.load(Ordering::Relaxed) as u32,
    }
}
