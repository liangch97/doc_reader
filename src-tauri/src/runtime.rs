//! 本地代码运行时管理（Docker + Piston）
//!
//! v6 (2026-05) #3++ 新增：emkc.org 公共 Piston API 已于 2026/2/15 改为白名单 → 401。
//! 这里把"docker 起 Piston 容器 + 装运行时"的运维步骤封装成可在应用内一键完成的命令，
//! 降低用户从「复制 docker 命令到终端跑」的门槛。
//!
//! 设计取舍：
//!   - 不依赖 bollard / shiplift 等 Docker SDK crate（增加 ~5MB 编译体积）
//!   - 直接 `std::process::Command` 调本地 `docker` CLI，足够 + 跨平台 + 无新依赖
//!   - Windows 下用 `creation_flags(CREATE_NO_WINDOW)` 避免子进程闪黑窗
//!
//! 命令清单（commands.rs 中暴露成 #[tauri::command]）：
//!   - docker_diagnose         : 综合状态（docker 是否安装 + piston 容器是否在跑）
//!   - piston_container_start  : 一键起 piston 容器（如已 stopped 则 docker start）
//!   - piston_container_stop   : docker stop piston
//!   - piston_container_recreate: 强制重建（rm -f + pull + run）
//!   - piston_pull_image       : 强制重新下载镜像（修复本地缓存损坏 / chown: cannot access '/piston'）
//!   - piston_install_runtime  : ppman install <lang>=<version>
//!   - piston_list_runtimes    : 列出容器内已安装的语言

use std::process::Command;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// 容器名（写死）：项目内统一用这个名字，避免和用户其他容器冲突
pub const PISTON_CONTAINER_NAME: &str = "doc-reader-piston";
/// 默认端口
pub const PISTON_HOST_PORT: u16 = 2000;
/// 默认 endpoint —— 容器跑起来后要写到 app_prefs.code_runner.endpoint
///
/// **注意用 `127.0.0.1` 而不是 `localhost`**：
/// Windows 的 `localhost` 默认 IPv6 优先解析到 `::1`，但 Docker Desktop on Windows
/// 的端口转发只监听 IPv4 → reqwest 命中 `::1` 后直接 connect 失败 / 超时
/// （表现：`error sending request for url ...` 立即出错）。
/// 用 `127.0.0.1` 字面量绕过 DNS 解析顺序问题。
pub fn default_endpoint() -> String {
    format!("http://127.0.0.1:{PISTON_HOST_PORT}/api/v2/execute")
}
/// Piston 镜像（显式 :latest tag，避免某些 docker 版本默认解析异常）
pub const PISTON_IMAGE: &str = "ghcr.io/engineer-man/piston:latest";

/// HTTP 客户端构造（与 `training::piston_execute` 同款逻辑）：
/// 本地 / 私网 endpoint → `.no_proxy()`（避免企业 PAC / VPN 把 127.0.0.1 也代理出去 → 502 / 连接拒绝）
/// 公网 endpoint → 用系统默认（可能要走代理才能到外网）
fn build_http_client(endpoint: &str, timeout: std::time::Duration) -> Result<reqwest::Client, String> {
    let is_local = crate::training::endpoint_is_localhost_or_private(endpoint);
    let mut builder = reqwest::Client::builder().timeout(timeout);
    if is_local {
        builder = builder.no_proxy();
    }
    builder
        .build()
        .map_err(|e| format!("构造 HTTP client 失败: {e}"))
}

/// 把 reqwest::Error 转成给用户看的可读 stderr（带分类提示 + 完整 source 链）。
///
/// reqwest 默认 Display 在某些 Windows 错误下不展开 source 链，导致用户看不到底层
/// OS 错误码（如 WSAEACCES 10013 / WSAECONNREFUSED 10061）。这里手动遍历 source 链
/// 把所有错误都打印出来，定位问题就能精确到"防火墙拦截"还是"端口未监听"。
fn explain_reqwest_error(url: &str, e: &reqwest::Error) -> String {
    use std::error::Error;
    // 收集完整错误链（reqwest → hyper → io → os）
    let mut chain: Vec<String> = vec![e.to_string()];
    let mut current: Option<&dyn Error> = e.source();
    while let Some(c) = current {
        chain.push(c.to_string());
        current = c.source();
    }
    let chain_str = chain.join("\n  → ");

    // 根据错误链里的关键字给出针对性提示
    let lower = chain_str.to_lowercase();
    let mut hint = String::new();

    if lower.contains("os error 10013") || lower.contains("forbidden by its access permissions") {
        hint.push_str("\n（Windows OS 10013 / WSAEACCES）—— 出站连接被系统拒绝。最常见：\n");
        hint.push_str("  · Windows Defender / 第三方杀毒软件拦截了应用对 127.0.0.1:2000 的连接\n");
        hint.push_str("  · 公司 EDR / 端点保护策略\n");
        hint.push_str("  · 把本应用加入防火墙/杀软白名单后重试。");
    } else if lower.contains("os error 10061") || lower.contains("connection refused") {
        hint.push_str("\n（连接被拒绝）—— 端口上没有进程在监听。容器可能挂了，请到「设置 → 代码运行」检查容器状态或重建容器。");
    } else if lower.contains("os error 10060") || lower.contains("did not properly respond") || lower.contains("connect timed out") {
        hint.push_str("\n（连接超时）—— TCP 握手没完成。容器可能在启动中，等 30s 重试。");
    } else if lower.contains("os error 10054") || lower.contains("connection reset") {
        hint.push_str("\n（连接被重置）—— Piston 服务在握手后立即关闭连接。容器可能正在崩溃，看「容器日志」排查。");
    } else if lower.contains("dns") || lower.contains("name or service") || lower.contains("name resolution") {
        hint.push_str("\n（DNS 解析失败）—— 改 endpoint 用 IP 字面量（http://127.0.0.1:2000/api/v2/execute）绕过。");
    } else if lower.contains("proxy") {
        hint.push_str("\n（代理介入）—— 系统代理仍在拦截。请关闭 V2Ray / Clash 之类的全局代理；或在代理设置里把 127.0.0.1 加入直连列表。");
    } else if e.is_connect() {
        hint.push_str("\n（连接级错误）常见原因：\n  · Piston 容器没在跑 → 「设置 → 代码运行」点「启动容器」\n  · 端口 2000 没映射 → 用「强制重建容器」修复");
    } else if e.is_timeout() {
        hint.push_str("\n（超时）—— 装包流程被中断；通常是网络慢或镜像源不稳定，可重试。");
    } else if e.is_request() {
        hint.push_str("\n（请求阶段错误）请把上面的【完整错误链】复制反馈，里面有具体 OS 错误码可以精确诊断。");
    }

    format!("调用 {url} 失败：\n  {chain_str}{hint}")
}

// ════════════════════════════════════════════════════════════════════════════
// 裸 TCP HTTP/1.1 客户端 —— 给本地 endpoint 做绝对干净的兜底
// ════════════════════════════════════════════════════════════════════════════
//
// 为什么要这层？reqwest 在 Windows 下针对 localhost 仍可能受多种因素干扰：
//   · Hyper 对 IPv6 happy-eyeballs 的实现差异
//   · 系统代理（注册表 / WPAD / PAC）以非常规方式被注入
//   · 杀毒软件 / EDR 在 reqwest 进程上下文里 hook socket
//   · TLS 探测库（rustls）在某些 Windows 配置下 trust store 异常
//
// 用 stdlib `TcpStream` 直接拼 HTTP/1.1 文本协议绕过以上**全部**外部因素 ——
// 只要 piston 容器端口可达，这条路径**一定**能走通（curl 能连上 = 这里也能连上）。
//
// 仅用于 piston localhost 路径的 JSON GET/POST，**不支持** chunked / TLS / 重定向。

/// 解析 `http://host:port/path?query` → (host, port, path_with_query)。
fn parse_http_url(url: &str) -> Result<(String, u16, String), String> {
    let after = url.strip_prefix("http://")
        .ok_or_else(|| format!("local_http 仅支持 http:// (got: {url})"))?;
    // host[:port]/path... → 切第一个 /
    let (authority, path) = match after.find('/') {
        Some(i) => (&after[..i], &after[i..]),
        None => (after, "/"),
    };
    // host:port
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) => (
            h.to_string(),
            p.parse::<u16>().map_err(|_| format!("URL 端口非法：{p}"))?,
        ),
        None => (authority.to_string(), 80),
    };
    Ok((host, port, path.to_string()))
}

/// 用裸 TCP socket 发一次 HTTP/1.1 请求，返回 (status_code, body_string)。
///
/// 行为：
///   · 用 `to_socket_addrs()` 解析 host —— 如果 host 是 IP 字面量（127.0.0.1）就直接得 IPv4，
///     不走系统 DNS / hosts，彻底排除 IPv6 解析问题
///   · 不 follow redirect（304/302 直接当作错误返回 status）
///   · 只读 Content-Length 长度的 body（不支持 chunked —— Piston 不用 chunked）
///   · 超时分两段：connect 5s，total（含读响应）= 调用方传入
pub fn raw_http_request(
    method: &str,
    url: &str,
    body: Option<&[u8]>,
    timeout: std::time::Duration,
) -> Result<(u16, String), String> {
    use std::io::{Read, Write};
    use std::net::{TcpStream, ToSocketAddrs};

    let (host, port, path) = parse_http_url(url)?;
    let target = format!("{host}:{port}");
    // ToSocketAddrs 会把 "127.0.0.1:2000" 解析成 SocketAddrV4，IP 字面量根本不走 DNS
    let addrs: Vec<_> = target
        .to_socket_addrs()
        .map_err(|e| format!("解析 {target} 失败: {e}"))?
        .collect();
    if addrs.is_empty() {
        return Err(format!("{target} 没有可达地址"));
    }

    // 优先 IPv4（绕过 Windows IPv6 优先 + Docker Desktop 只监听 v4 的问题）
    let mut sorted = addrs.clone();
    sorted.sort_by_key(|a| if a.is_ipv4() { 0 } else { 1 });

    let mut stream: Option<TcpStream> = None;
    let mut last_err = String::new();
    let connect_timeout = std::time::Duration::from_secs(5);
    for addr in &sorted {
        match TcpStream::connect_timeout(addr, connect_timeout) {
            Ok(s) => { stream = Some(s); break; }
            Err(e) => { last_err = format!("connect {addr}: {e} (raw os error: {:?})", e.raw_os_error()); }
        }
    }
    let mut stream = stream.ok_or_else(|| format!("无法连接 {target} (尝试了 {} 个地址)：{last_err}", sorted.len()))?;
    stream.set_read_timeout(Some(timeout)).ok();
    stream.set_write_timeout(Some(timeout)).ok();

    // 拼请求
    let body_bytes = body.unwrap_or(&[]);
    let mut req = format!(
        "{method} {path} HTTP/1.1\r\nHost: {host}:{port}\r\nUser-Agent: doc-reader-piston/1.0\r\nAccept: application/json\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
        body_bytes.len()
    ).into_bytes();
    req.extend_from_slice(body_bytes);
    stream.write_all(&req).map_err(|e| format!("写请求失败: {e} (raw os error: {:?})", e.raw_os_error()))?;
    stream.flush().ok();

    // 读响应：Connection: close 让对端写完就关，read_to_end 即可
    let mut buf = Vec::with_capacity(8192);
    stream.read_to_end(&mut buf).map_err(|e| format!("读响应失败: {e} (raw os error: {:?})", e.raw_os_error()))?;

    // 解析 HTTP/1.1 头：找第一个 \r\n\r\n
    let split = buf.windows(4).position(|w| w == b"\r\n\r\n")
        .ok_or_else(|| "响应格式异常：找不到 \\r\\n\\r\\n 分隔".to_string())?;
    let head = &buf[..split];
    let body_part = &buf[split + 4..];

    let head_str = std::str::from_utf8(head).map_err(|_| "响应头非 UTF-8".to_string())?;
    // 第一行：HTTP/1.1 <code> <reason>
    let first_line = head_str.lines().next().ok_or_else(|| "响应空".to_string())?;
    let mut parts = first_line.split_whitespace();
    let _proto = parts.next();
    let code_s = parts.next().ok_or_else(|| format!("响应首行格式异常：{first_line}"))?;
    let code: u16 = code_s.parse().map_err(|_| format!("无法解析 status: {code_s}"))?;

    let body_str = String::from_utf8_lossy(body_part).into_owned();
    Ok((code, body_str))
}

/// 用裸 TCP 发请求并返回 CmdResult，给 install_runtime 的 fallback 用。
fn raw_http_to_cmdresult(method: &str, url: &str, body: Option<&[u8]>) -> CmdResult {
    match raw_http_request(method, url, body, std::time::Duration::from_secs(600)) {
        Ok((code, text)) => {
            if (200..300).contains(&code) {
                CmdResult { success: true, exit_code: Some(0), stdout: text, stderr: String::new() }
            } else {
                let pretty = match serde_json::from_str::<Value>(&text) {
                    Ok(v) => v.get("message").and_then(|m| m.as_str()).map(String::from).unwrap_or_else(|| text.clone()),
                    Err(_) => text.clone(),
                };
                CmdResult {
                    success: false,
                    exit_code: Some(code as i32),
                    stdout: text,
                    stderr: format!("[raw_tcp] HTTP {code}: {pretty}"),
                }
            }
        }
        Err(e) => CmdResult {
            success: false,
            exit_code: None,
            stdout: String::new(),
            stderr: format!("[raw_tcp fallback 也失败] {e}"),
        },
    }
}

/// 把默认 endpoint（`/api/v2/execute`）转成 packages / runtimes 端点。
/// 前端不让用户配 packages/runtimes 路径，统一从 execute endpoint 推导。
fn packages_endpoint(execute_endpoint: &str) -> String {
    // 标准用法："http://127.0.0.1:2000/api/v2/execute" → "http://127.0.0.1:2000/api/v2/packages"
    if let Some(idx) = execute_endpoint.rfind("/execute") {
        return format!("{}/packages", &execute_endpoint[..idx]);
    }
    // 兜底：直接拼到默认地址
    format!("http://127.0.0.1:{PISTON_HOST_PORT}/api/v2/packages")
}
fn runtimes_endpoint(execute_endpoint: &str) -> String {
    if let Some(idx) = execute_endpoint.rfind("/execute") {
        return format!("{}/runtimes", &execute_endpoint[..idx]);
    }
    format!("http://127.0.0.1:{PISTON_HOST_PORT}/api/v2/runtimes")
}

/// 子进程执行结果（统一格式）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CmdResult {
    pub success: bool,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

/// 跨平台子进程执行 + 不弹黑窗（Windows）+ 超时
fn run_cmd(program: &str, args: &[&str], timeout: Duration) -> CmdResult {
    #[cfg(target_os = "windows")]
    fn spawn(program: &str, args: &[&str]) -> std::io::Result<std::process::Child> {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        Command::new(program)
            .args(args)
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
    }
    #[cfg(not(target_os = "windows"))]
    fn spawn(program: &str, args: &[&str]) -> std::io::Result<std::process::Child> {
        Command::new(program)
            .args(args)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
    }

    let child = match spawn(program, args) {
        Ok(c) => c,
        Err(e) => {
            return CmdResult {
                success: false,
                exit_code: None,
                stdout: String::new(),
                stderr: format!("无法启动 `{program}`：{e}"),
            };
        }
    };

    // wait_with_output 没有 timeout，自己实现
    let pid = child.id();
    let start = std::time::Instant::now();
    let mut child_opt = Some(child);
    loop {
        if let Some(child) = child_opt.as_mut() {
            match child.try_wait() {
                Ok(Some(_status)) => break,
                Ok(None) => {
                    if start.elapsed() > timeout {
                        // 超时：kill
                        let _ = child.kill();
                        return CmdResult {
                            success: false,
                            exit_code: None,
                            stdout: String::new(),
                            stderr: format!(
                                "命令 `{program} {}` 超时 {}s（pid={pid}）",
                                args.join(" "),
                                timeout.as_secs()
                            ),
                        };
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
                Err(e) => {
                    return CmdResult {
                        success: false,
                        exit_code: None,
                        stdout: String::new(),
                        stderr: format!("等待子进程失败：{e}"),
                    };
                }
            }
        } else {
            break;
        }
    }
    let child = child_opt.take().unwrap();
    let output = match child.wait_with_output() {
        Ok(o) => o,
        Err(e) => {
            return CmdResult {
                success: false,
                exit_code: None,
                stdout: String::new(),
                stderr: format!("读取子进程输出失败：{e}"),
            };
        }
    };
    CmdResult {
        success: output.status.success(),
        exit_code: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    }
}

/// 检查 docker 是否在 PATH 里且能运行（`docker --version`）
pub fn docker_available() -> (bool, String) {
    let r = run_cmd("docker", &["--version"], Duration::from_secs(5));
    if r.success {
        (true, r.stdout.trim().to_string())
    } else {
        (false, r.stderr.trim().to_string())
    }
}

/// 检查 docker daemon 是否在跑（`docker info`）
pub fn docker_running() -> bool {
    let r = run_cmd("docker", &["info", "--format", "{{.ServerVersion}}"], Duration::from_secs(8));
    r.success
}

/// 检查名为 PISTON_CONTAINER_NAME 的容器状态。
///   返回 ("running"|"exited"|"not_found", 详细信息)
pub fn container_status() -> (String, String) {
    // docker ps -a 找名字 == PISTON_CONTAINER_NAME 的容器
    let r = run_cmd(
        "docker",
        &[
            "ps",
            "-a",
            "--filter",
            &format!("name=^{}$", PISTON_CONTAINER_NAME),
            "--format",
            "{{.Status}}",
        ],
        Duration::from_secs(8),
    );
    if !r.success {
        return ("error".to_string(), r.stderr.trim().to_string());
    }
    let out = r.stdout.trim();
    if out.is_empty() {
        return ("not_found".to_string(), String::new());
    }
    // out 例 "Up 3 minutes" / "Exited (0) 5 minutes ago"
    if out.starts_with("Up") {
        ("running".to_string(), out.to_string())
    } else {
        ("exited".to_string(), out.to_string())
    }
}

/// 综合诊断：docker 可用？daemon 在跑？容器状态？endpoint 默认值是什么？
pub fn diagnose() -> Value {
    let (ok, ver) = docker_available();
    if !ok {
        return json!({
            "docker_installed": false,
            "docker_running": false,
            "docker_version": null,
            "container_state": "n/a",
            "container_detail": "",
            "endpoint": default_endpoint(),
            "image": PISTON_IMAGE,
            "container_name": PISTON_CONTAINER_NAME,
            "error": ver,
        });
    }
    let running = docker_running();
    if !running {
        return json!({
            "docker_installed": true,
            "docker_running": false,
            "docker_version": ver,
            "container_state": "n/a",
            "container_detail": "",
            "endpoint": default_endpoint(),
            "image": PISTON_IMAGE,
            "container_name": PISTON_CONTAINER_NAME,
            "error": "Docker daemon 没在跑（请打开 Docker Desktop）",
        });
    }
    let (state, detail) = container_status();
    json!({
        "docker_installed": true,
        "docker_running": true,
        "docker_version": ver,
        "container_state": state,
        "container_detail": detail,
        "endpoint": default_endpoint(),
        "image": PISTON_IMAGE,
        "container_name": PISTON_CONTAINER_NAME,
        "error": null,
    })
}

/// 启动 piston 容器：
///   - not_found → 强制 `docker pull` + docker run（保证镜像新鲜，避免 chown: cannot access '/piston' 这类本地缓存损坏症状）
///   - exited    → docker start NAME（保留容器和已装语言）
///   - running   → no-op，返回当前状态
///
/// 注意：我们用 `--restart unless-stopped` 让 Docker Desktop 重启后自动起；
/// 也不再用 `--rm`（因为想保留已装的运行时；用户主动 stop 后下次 start 就能继续用）。
pub fn container_start() -> CmdResult {
    let (state, _) = container_status();
    match state.as_str() {
        "running" => CmdResult {
            success: true,
            exit_code: Some(0),
            stdout: "容器已经在运行".to_string(),
            stderr: String::new(),
        },
        "exited" => run_cmd(
            "docker",
            &["start", PISTON_CONTAINER_NAME],
            Duration::from_secs(20),
        ),
        _ => {
            // not_found / error：强制 pull 最新镜像 + run。
            // 显式 pull 比 docker run 隐式 pull 更可控：能在失败时拿到清晰错误，
            // 也能避免 docker 用了被损坏的本地缓存（chown: cannot access '/piston'）。
            let pull = pull_image();
            if !pull.success {
                return pull;
            }
            // 镜像可能要拉 ~1.2GB，给 10 分钟超时
            let run = run_cmd("docker", &piston_run_args(), Duration::from_secs(600));
            // 把 pull 的输出拼到 run 输出前面，方便用户看完整流程
            CmdResult {
                success: run.success,
                exit_code: run.exit_code,
                stdout: format!("[pull]\n{}\n[run]\n{}", pull.stdout.trim(), run.stdout.trim()),
                stderr: if run.stderr.is_empty() {
                    pull.stderr
                } else {
                    format!("{}{}{}", pull.stderr, if pull.stderr.is_empty() { "" } else { "\n" }, run.stderr)
                },
            }
        }
    }
}

/// 强制 `docker pull IMAGE` —— 即使本地有缓存也重新拉一次，
/// 用于修复"镜像不完整下载 / Docker Desktop 解压 bug"导致的容器启动症状
/// （典型表现：`chown: cannot access '/piston': No such file or directory`）。
pub fn pull_image() -> CmdResult {
    // pull 单次可能要 1~2 分钟（拉 ~1.2GB），给 10 分钟超时
    run_cmd("docker", &["pull", PISTON_IMAGE], Duration::from_secs(600))
}

/// Piston 容器的 `docker run` 完整参数。
///
/// 关键 flag（来自 Piston 官方 README 推荐）：
///   - `--privileged`：Piston 内部用 isolate 做代码沙箱，需要 cgroup / mount namespaces 权限。
///     不加这个会报 `mkdir: cannot create directory 'isolate/': Read-only file system`。
///   - `--tmpfs /piston/jobs:exec,size=256m`：Piston 临时作业目录用内存文件系统。
///     必须有 `exec` flag（默认 tmpfs noexec，会让 isolate 无法执行临时可执行文件）。
///   - `--restart unless-stopped`：Docker Desktop 重启后自动起容器。
///   - 不再用 `--rm`：保留容器和已装运行时，stop 后下次 start 即恢复。
///
/// 关键 env（Piston `PISTON_*` 配置覆盖容器内默认值）：
///   - `PISTON_RUN_TIMEOUT=15000`：把单次代码执行上限从默认 3s 提到 15s。
///     避免训练题里跑稍复杂的算法时被 400 "run_timeout cannot exceed configured limit"。
///   - `PISTON_COMPILE_TIMEOUT=30000`：编译上限从 10s 提到 30s（rust/java 首次编译 5-10s 常见）。
fn piston_run_args() -> Vec<&'static str> {
    use std::sync::OnceLock;
    static PORT_ARG: OnceLock<String> = OnceLock::new();
    let port_arg = PORT_ARG.get_or_init(|| format!("{PISTON_HOST_PORT}:2000"));
    vec![
        "run",
        "-d",
        "--name",
        PISTON_CONTAINER_NAME,
        "--privileged",
        "--tmpfs",
        "/piston/jobs:exec,size=256m",
        "--restart",
        "unless-stopped",
        "-e",
        "PISTON_RUN_TIMEOUT=15000",
        "-e",
        "PISTON_COMPILE_TIMEOUT=30000",
        "-p",
        port_arg.as_str(),
        PISTON_IMAGE,
    ]
}

pub fn container_stop() -> CmdResult {
    run_cmd("docker", &["stop", PISTON_CONTAINER_NAME], Duration::from_secs(20))
}

/// 强制重建容器：rm -f 当前容器（如有）+ 强制 docker pull + docker run 全新一个。
/// 用于：容器创建时缺端口映射 / 容器内进程持续崩溃 /
///       `chown: cannot access '/piston': No such file or directory`（镜像本地缓存损坏）。
/// 警告：会丢失容器内已安装的运行时（需要重新装 python 等）。
pub fn container_recreate() -> CmdResult {
    // 1. rm -f（即使不存在也不报错）
    let _ = run_cmd(
        "docker",
        &["rm", "-f", PISTON_CONTAINER_NAME],
        Duration::from_secs(30),
    );
    // 2. 强制 pull —— 这是修复 chown 类启动错误的关键。
    //    用户点"重建"时往往就是怀疑镜像损坏，主动重新下载比让 docker run 隐式判断更可靠。
    let pull = pull_image();
    if !pull.success {
        return pull;
    }
    // 3. run（启动新容器）— 复用 piston_run_args 保证 flags 一致
    let run = run_cmd("docker", &piston_run_args(), Duration::from_secs(600));
    CmdResult {
        success: run.success,
        exit_code: run.exit_code,
        stdout: format!("[pull]\n{}\n[run]\n{}", pull.stdout.trim(), run.stdout.trim()),
        stderr: if run.stderr.is_empty() {
            pull.stderr
        } else {
            format!("{}{}{}", pull.stderr, if pull.stderr.is_empty() { "" } else { "\n" }, run.stderr)
        },
    }
}

/// 查看容器最近 N 行日志（用于排查 piston 进程崩溃原因）
pub fn container_logs(tail: usize) -> CmdResult {
    let tail_s = tail.to_string();
    run_cmd(
        "docker",
        &["logs", "--tail", &tail_s, PISTON_CONTAINER_NAME],
        Duration::from_secs(8),
    )
}

/// 查看容器端口绑定（`docker port NAME`）。
/// 输出例：`2000/tcp -> 0.0.0.0:2000`；空输出 = 没绑端口
pub fn container_ports() -> CmdResult {
    run_cmd(
        "docker",
        &["port", PISTON_CONTAINER_NAME],
        Duration::from_secs(8),
    )
}

/// 把"用户友好的语言名"映射成 Piston **包名**（用于 install / 查询）。
///
/// 关键不一致点（来自 GET /api/v2/packages 的实际包列表）：
///   - C / C++ 共用同一个包 `gcc`
///   - JavaScript 包名是 `node`
///   - C# 包名是 `mono`（也有 `dotnet` 但场景不同，这里用 `mono` 作默认）
///   - V 语言包名是 `vlang`（不是 `v`）
///   - R 语言包名是 `rscript`
///   - PowerShell 包名是 `pwsh`
///   - Common Lisp 包名是 `lisp`
///
/// **注意**：execute 端点（运行代码时）用 runtime 的 language / aliases 匹配，
/// 那里 `c` / `cpp` / `javascript` / `c++` 等都是合法的 alias。
/// 这里的映射**只用在 install / list 路径**。
fn normalize_install_language(user_lang: &str) -> &str {
    match user_lang.to_lowercase().as_str() {
        // 共用包
        "c" | "c++" | "cpp" | "gcc" => "gcc",
        // 名字不一致
        "js" | "javascript" | "node" | "nodejs" => "node",
        "ts" => "typescript",
        "c#" | "csharp" | "mono" => "mono",
        "v" | "vlang" => "vlang",
        "r" | "rscript" => "rscript",
        "powershell" | "pwsh" | "ps" | "ps1" => "pwsh",
        "common-lisp" | "commonlisp" | "lisp" => "lisp",
        // 直传（已与 Piston 包名一致：python / java / go / rust / kotlin / swift /
        // ruby / php / scala / haskell / lua / perl / dart / elixir / erlang /
        // julia / nim / zig / crystal / clojure / ocaml / racket / pascal / bash /
        // dotnet / cobol / dragon / forth / groovy 等）
        _ => user_lang,
    }
}

/// 安装一个 runtime（语言）。version 默认 "*" 装最新。
///
/// 走 Piston HTTP API（POST /api/v2/packages，body `{language, version}`）。
/// Piston 3.1.1 起已废弃容器内 cli（`/piston/cli/index.js` 不再存在），
/// 必须通过 HTTP 调；语义跟旧 `ppman install <lang>=<ver>` 等价。
///
/// 注意 `language` 会先经 `normalize_install_language` 映射成 Piston 实际包名
/// （c / c++ → gcc, javascript → node, csharp → mono）。
pub async fn install_runtime(
    execute_endpoint: &str,
    language: &str,
    version: Option<&str>,
) -> CmdResult {
    let pkg_name = normalize_install_language(language);
    let target_version = match version {
        Some(v) if !v.is_empty() && v != "*" => v.to_string(),
        _ => "*".to_string(),
    };
    let url = packages_endpoint(execute_endpoint);
    let body = json!({ "language": pkg_name, "version": target_version });

    let client = match build_http_client(execute_endpoint, std::time::Duration::from_secs(600)) {
        Ok(c) => c,
        Err(e) => {
            return CmdResult {
                success: false,
                exit_code: None,
                stdout: String::new(),
                stderr: e,
            };
        }
    };

    let resp = match client.post(&url).json(&body).send().await {
        Ok(r) => r,
        Err(e) => {
            let detailed = explain_reqwest_error(&url, &e);
            // 本地 endpoint：reqwest 失败时用裸 TCP 兜底（绕过 hyper / DNS / proxy 的所有干扰）
            if crate::training::endpoint_is_localhost_or_private(execute_endpoint) {
                log::warn!("[install_runtime] reqwest 失败，尝试裸 TCP 兜底\n{detailed}");
                let body_bytes = serde_json::to_vec(&body).unwrap_or_default();
                let raw_url = url.clone();
                let r = tokio::task::spawn_blocking(move || {
                    raw_http_to_cmdresult("POST", &raw_url, Some(&body_bytes))
                })
                .await
                .unwrap_or_else(|e| CmdResult {
                    success: false,
                    exit_code: None,
                    stdout: String::new(),
                    stderr: format!("raw_tcp spawn 失败: {e}"),
                });
                // 兜底成功 → 直接用结果；失败 → 把 reqwest 错和 raw_tcp 错合在一起报给用户
                if r.success {
                    log::info!("[install_runtime] 裸 TCP 兜底成功");
                    return r;
                } else {
                    return CmdResult {
                        success: false,
                        exit_code: r.exit_code,
                        stdout: r.stdout,
                        stderr: format!("{detailed}\n\n--- 裸 TCP 兜底也失败 ---\n{}", r.stderr),
                    };
                }
            }
            return CmdResult {
                success: false,
                exit_code: None,
                stdout: String::new(),
                stderr: detailed,
            };
        }
    };

    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if status.is_success() {
        CmdResult {
            success: true,
            exit_code: Some(0),
            stdout: text,
            stderr: String::new(),
        }
    } else {
        // Piston 失败时回 JSON `{message: "..."}`，把它当 stderr 显示
        let pretty = match serde_json::from_str::<Value>(&text) {
            Ok(v) => {
                if let Some(msg) = v.get("message").and_then(|m| m.as_str()) {
                    msg.to_string()
                } else {
                    text.clone()
                }
            }
            Err(_) => text.clone(),
        };
        CmdResult {
            success: false,
            exit_code: Some(status.as_u16() as i32),
            stdout: text,
            stderr: format!("HTTP {}: {}", status.as_u16(), pretty),
        }
    }
}

/// 列出容器内已安装的运行时（GET /api/v2/runtimes）。
/// 返回 `[{ language, version }]`。
pub async fn list_runtimes(execute_endpoint: &str) -> Result<Value, String> {
    let url = runtimes_endpoint(execute_endpoint);
    // list 比较快，给 30s 已足够（Piston 只是从内存返回）
    let client = build_http_client(execute_endpoint, std::time::Duration::from_secs(30))?;

    // 先用 reqwest；如果失败且是本地 endpoint，就裸 TCP 兜底
    let resp_result = client.get(&url).send().await;
    let arr: Vec<Value> = match resp_result {
        Ok(resp) => {
            if !resp.status().is_success() {
                let status = resp.status();
                let text = resp.text().await.unwrap_or_default();
                return Err(format!("HTTP {}: {}", status.as_u16(), text));
            }
            resp.json().await.map_err(|e| format!("解析 /runtimes 响应失败：{e}"))?
        }
        Err(e) => {
            let detailed = explain_reqwest_error(&url, &e);
            if !crate::training::endpoint_is_localhost_or_private(execute_endpoint) {
                return Err(detailed);
            }
            log::warn!("[list_runtimes] reqwest 失败，尝试裸 TCP 兜底\n{detailed}");
            // 裸 TCP fallback
            let raw_url = url.clone();
            let r = tokio::task::spawn_blocking(move || {
                raw_http_request("GET", &raw_url, None, std::time::Duration::from_secs(30))
            })
            .await
            .map_err(|e| format!("raw_tcp spawn 失败: {e}"))?;
            let (code, text) = r.map_err(|e| format!("{detailed}\n\n--- 裸 TCP 兜底也失败 ---\n{e}"))?;
            if !(200..300).contains(&code) {
                return Err(format!("[raw_tcp] HTTP {code}: {text}"));
            }
            log::info!("[list_runtimes] 裸 TCP 兜底成功");
            serde_json::from_str(&text).map_err(|e| format!("解析裸 TCP 响应失败: {e}\nbody: {text}"))?
        }
    };
    // 标准化成前端期望的 {language, version}
    let items: Vec<Value> = arr
        .into_iter()
        .map(|v| {
            let lang = v.get("language").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let ver = v.get("version").and_then(|x| x.as_str()).unwrap_or("").to_string();
            json!({ "language": lang, "version": ver })
        })
        .filter(|v| !v.get("language").and_then(|s| s.as_str()).unwrap_or("").is_empty())
        .collect();
    Ok(Value::Array(items))
}
