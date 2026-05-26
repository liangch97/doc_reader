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
pub fn default_endpoint() -> String {
    format!("http://localhost:{PISTON_HOST_PORT}/api/v2/execute")
}
/// Piston 镜像（显式 :latest tag，避免某些 docker 版本默认解析异常）
pub const PISTON_IMAGE: &str = "ghcr.io/engineer-man/piston:latest";

/// HTTP 客户端构造：本地 endpoint 不走系统代理（避免企业 PAC / VPN 把 127.0.0.1 也代理出去）
fn build_http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(600)) // ppman install 装 rust 可能 5+ 分钟
        .no_proxy()
        .build()
        .map_err(|e| format!("构造 HTTP client 失败: {e}"))
}

/// 把默认 endpoint（`/api/v2/execute`）转成 packages / runtimes 端点。
/// 前端不让用户配 packages/runtimes 路径，统一从 execute endpoint 推导。
fn packages_endpoint(execute_endpoint: &str) -> String {
    // 标准用法："http://localhost:2000/api/v2/execute" → "http://localhost:2000/api/v2/packages"
    if let Some(idx) = execute_endpoint.rfind("/execute") {
        return format!("{}/packages", &execute_endpoint[..idx]);
    }
    // 兜底：直接拼到默认地址
    format!("http://localhost:{PISTON_HOST_PORT}/api/v2/packages")
}
fn runtimes_endpoint(execute_endpoint: &str) -> String {
    if let Some(idx) = execute_endpoint.rfind("/execute") {
        return format!("{}/runtimes", &execute_endpoint[..idx]);
    }
    format!("http://localhost:{PISTON_HOST_PORT}/api/v2/runtimes")
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

/// 安装一个 runtime（语言）。version 默认 "*" 装最新。
///
/// 走 Piston HTTP API（POST /api/v2/packages，body `{language, version}`）。
/// Piston 3.1.1 起已废弃容器内 cli（`/piston/cli/index.js` 不再存在），
/// 必须通过 HTTP 调；语义跟旧 `ppman install <lang>=<ver>` 等价。
pub async fn install_runtime(
    execute_endpoint: &str,
    language: &str,
    version: Option<&str>,
) -> CmdResult {
    let target_version = match version {
        Some(v) if !v.is_empty() && v != "*" => v.to_string(),
        _ => "*".to_string(),
    };
    let url = packages_endpoint(execute_endpoint);
    let body = json!({ "language": language, "version": target_version });

    let client = match build_http_client() {
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
            return CmdResult {
                success: false,
                exit_code: None,
                stdout: String::new(),
                stderr: format!(
                    "调用 {url} 失败：{e}\n常见原因：\n  · Piston 容器没有运行\n  · 端口 2000 没被映射出来\n  · endpoint 配置错误"
                ),
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
    let client = build_http_client()?;
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("调用 {url} 失败：{e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {}: {}", status.as_u16(), text));
    }
    // Piston 返回：[{language, version, aliases, runtime}]
    let arr: Vec<Value> = resp
        .json()
        .await
        .map_err(|e| format!("解析 /runtimes 响应失败：{e}"))?;
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
