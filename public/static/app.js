/**
 * Notebook Helper v6 — Frontend Logic
 * shadcn/ui modern notebook-chat hybrid interface
 */
(function () {
    'use strict';

    const POLL_INTERVAL_MS = 1200;
    const RETRY_INTERVAL_MS = 2000;
    const SCROLL_DELAY_MS = 200;

    /* ==================== TAURI API ==================== */
    // Tauri v2: use __TAURI_INTERNALS__ (always injected by WebView)
    // or __TAURI__.core (available if @tauri-apps/api loaded as ES module)
    function tauriInvoke(cmd, args) {
        // Path 1: @tauri-apps/api loaded as ES module
        if (window.__TAURI__ && window.__TAURI__.core) {
            return window.__TAURI__.core.invoke(cmd, args || {});
        }
        // Path 2: Tauri v2 internal API (always available in WebView)
        if (window.__TAURI_INTERNALS__) {
            return window.__TAURI_INTERNALS__.invoke(cmd, args || {});
        }
        // Fallback for dev without Tauri (pure browser)
        return Promise.reject(new Error('Tauri not available'));
    }

    /* ==================== APP STATE ==================== */
    const APP = {
        taskId: null,
        noteCache: {},
        currentViewModes: {},   // noteType -> 'preview' | 'source'
        sidebarOpen: true,
        config: null,           // cached app config
        progressStartTime: null // 进度开始时间，用于时间预测
    };

    /* ==================== INIT ==================== */
    document.addEventListener('DOMContentLoaded', () => {
        initTheme();
        initDensity();
        initSidebar();
        initPanels();
        initDropZone();
        initForm();
        loadAppConfig();
        lucide.createIcons();
        initHoverBounce();
        restoreActiveTask();
    });

    /* ==================== HOVER BOUNCE ==================== */
    function initHoverBounce() {
        const selectors = [
            // 标题类
            '.brand-name',
            '.notebook-title',
            '.welcome-title',
            '.note-toc-title',
            // 标签 / 徽章类
            '.shad-badge',
            '.shad-checkbox-label',
            '.shad-radio-name',
            '.shad-radio-desc',
            // 图标类
            '.brand-icon',
            '.welcome-icon',
            '.drop-zone-icon',
            '.file-chip-icon',
            '.shad-checkbox-icon',
            '.note-type-icon',
            // 按钮 / 交互类
            '.panel-toggle > span:first-child',
            '.shad-tab',
            '.note-index-btn',
            '.note-toc-toggle',
            '.note-toc-item',
            '.drop-zone-text'
        ];
        function attach(el) {
            el.addEventListener('mouseenter', function () {
                this.classList.remove('hover-bounce-active');
                void this.offsetWidth;
                this.classList.add('hover-bounce-active');
            });
            el.addEventListener('animationend', function () {
                this.classList.remove('hover-bounce-active');
            });
        }
        selectors.forEach(sel => {
            document.querySelectorAll(sel).forEach(attach);
        });
        // 对动态渲染的元素（如 loadAppConfig 之后），用 MutationObserver 补绑
        const observer = new MutationObserver(() => {
            selectors.forEach(sel => {
                document.querySelectorAll(sel).forEach(el => {
                    if (!el._hoverBounce) {
                        el._hoverBounce = true;
                        attach(el);
                    }
                });
            });
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    /* ==================== RESTORE ACTIVE TASK ==================== */
    function restoreActiveTask() {
        const savedTaskId = localStorage.getItem('activeTask');
        if (!savedTaskId) return;
        console.log('[NB] 恢复进行中的任务:', savedTaskId);
        APP.taskId = savedTaskId;
        // 隐藏欢迎页，显示进度区域
        const welcome = document.getElementById('welcome');
        if (welcome) welcome.style.display = 'none';
        const cellsDiv = document.getElementById('cells');
        if (cellsDiv && !cellsDiv.querySelector('.cell')) {
            cellsDiv.innerHTML = `
                <div class="cell">
                    <div class="cell-body" style="text-align:center;padding:24px;">
                        <p style="color:var(--muted-foreground);">正在恢复任务进度…</p>
                    </div>
                </div>`;
        }
        pollTask();
    }

    /* ==================== DYNAMIC CONFIG ==================== */
    function loadAppConfig() {
        tauriInvoke('get_app_config').then(config => {
            console.log('[NB] get_app_config response:', JSON.stringify(config));
            APP.config = config;
            renderNoteTypeCheckboxes(config.note_types);
            renderLengthPresets(config.length_presets);
            renderHistoryFilterCheckboxes(config.note_types);
        }).catch(err => {
            console.error('[NB] Failed to load config:', err);
        });
    }

    function renderNoteTypeCheckboxes(noteTypes) {
        const container = document.getElementById('panelTypesBody');
        if (!container || !noteTypes) return;

        const iconMap = {
            summary: 'file-text', mindmap: 'network', cornell: 'notebook-tabs',
            qa: 'circle-help', timeline: 'history', concept_map: 'git-branch-plus',
            flashcard: 'rectangle-horizontal', anki: 'library-big', note: 'notebook-text',
            fusion: 'sparkles'
        };
        const defaultChecked = ['summary', 'mindmap'];

        let html = '';
        for (const [key, info] of Object.entries(noteTypes)) {
            const icon = iconMap[key] || 'file';
            const name = normalizeNoteName(info.name, info.icon);
            const checked = defaultChecked.includes(key) ? 'checked' : '';
            html += `<label class="shad-checkbox-wrap">
                <input type="checkbox" name="note_types" value="${key}" class="shad-checkbox" ${checked} />
                <span class="shad-checkbox-label">
                    <span class="shad-checkbox-icon"><i data-lucide="${icon}"></i></span>
                    ${escHtml(name)}
                </span>
            </label>`;
        }
        container.innerHTML = html;
        lucide.createIcons({ nodes: [container] });
    }

    function renderLengthPresets(presets) {
        const container = document.getElementById('panelDetailBody');
        if (!container || !presets) return;

        let html = '';
        presets.forEach(preset => {
            const checked = preset.key === 'standard' ? 'checked' : '';
            html += `<label class="shad-radio-wrap">
                <input type="radio" name="length_preset" value="${preset.key}"
                       class="shad-radio" ${checked} />
                <div class="shad-radio-info">
                    <span class="shad-radio-name">${escHtml(preset.name)}</span>
                    <span class="shad-radio-desc">${escHtml(preset.description)}</span>
                </div>
            </label>`;
        });
        container.innerHTML = html;
    }

    function renderHistoryFilterCheckboxes(noteTypes) {
        const container = document.getElementById('panelFilterBody');
        if (!container || !noteTypes) return;

        const iconMap = {
            summary: 'file-text', mindmap: 'network', cornell: 'notebook-tabs',
            qa: 'circle-help', timeline: 'history', concept_map: 'git-branch-plus',
            flashcard: 'rectangle-horizontal', anki: 'library-big', note: 'notebook-text',
            fusion: 'sparkles'
        };

        let html = '';
        for (const [key, info] of Object.entries(noteTypes)) {
            const icon = iconMap[key] || 'file';
            const name = normalizeNoteName(info.name, info.icon);
            html += `<label class="shad-checkbox-wrap">
                <input type="checkbox" value="${key}" class="shad-checkbox history-type-filter" checked />
                <span class="shad-checkbox-label">
                    <span class="shad-checkbox-icon"><i data-lucide="${icon}"></i></span>
                    ${escHtml(name)}
                </span>
            </label>`;
        }
        container.innerHTML = html;
        lucide.createIcons({ nodes: [container] });

        // 绑定筛选事件 — 客户端侧过滤历史卡片
        container.querySelectorAll('.history-type-filter').forEach(cb => {
            cb.addEventListener('change', applyHistoryTypeFilter);
        });
    }

    function applyHistoryTypeFilter() {
        const checkboxes = document.querySelectorAll('.history-type-filter:checked');
        // 如果筛选复选框尚未创建，显示所有卡片
        if (document.querySelectorAll('.history-type-filter').length === 0) return;

        const checked = Array.from(checkboxes).map(cb => cb.value);

        document.querySelectorAll('.history-card').forEach(card => {
            const cardTypes = (card.dataset.noteTypes || '').split(',');
            const hasMatch = cardTypes.some(t => checked.includes(t));
            card.style.display = hasMatch ? '' : 'none';
        });
    }

    /* ==================== THEME ==================== */
    const THEME_CYCLE = ['light', 'dark', 'vibrant', 'ocean'];
    const THEME_NEXT_ICON = { light: 'moon', dark: 'palette', vibrant: 'waves', ocean: 'sun' };
    const THEME_ARIA = { light: '切换到深色', dark: '切换到炫彩', vibrant: '切换到海洋', ocean: '切换到亮色' };

    function initTheme() {
        const saved = localStorage.getItem('nb-theme') || 'light';
        applyTheme(saved);
        document.getElementById('themeToggle').addEventListener('click', () => {
            const cur = localStorage.getItem('nb-theme') || 'light';
            const next = THEME_CYCLE[(THEME_CYCLE.indexOf(cur) + 1) % THEME_CYCLE.length];
            applyTheme(next);
            localStorage.setItem('nb-theme', next);
        });
    }

    function applyTheme(theme) {
        if (theme === 'dark' || theme === 'vibrant' || theme === 'ocean') {
            document.documentElement.setAttribute('data-theme', theme);
        } else {
            document.documentElement.removeAttribute('data-theme');
        }
        // Switch hljs stylesheet
        const hljsLink = document.getElementById('hljs-theme');
        if (hljsLink) {
            hljsLink.href = theme === 'light'
                ? 'https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/styles/atom-one-light.min.css'
                : 'https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/styles/atom-one-dark.min.css';
        }
        // Toggle icon: 显示"点击后下一个主题"对应的图标
        const btn = document.getElementById('themeToggle');
        if (btn) {
            const iconName = THEME_NEXT_ICON[theme] || 'moon';
            btn.innerHTML = `<i data-lucide="${iconName}"></i>`;
            btn.setAttribute('aria-label', THEME_ARIA[theme] || 'Toggle theme');
            lucide.createIcons({ nodes: [btn] });
        }
    }

    /* ==================== DENSITY ==================== */
    function initDensity() {
        const saved = localStorage.getItem('nb-density') || 'compact';
        applyDensity(saved);
        const toggle = document.getElementById('densityToggle');
        if (!toggle) return;
        toggle.addEventListener('click', () => {
            const next = document.documentElement.getAttribute('data-density') === 'comfortable'
                ? 'compact'
                : 'comfortable';
            applyDensity(next);
            localStorage.setItem('nb-density', next);
            showToast(next === 'comfortable' ? '已切换为舒展模式' : '已切换为紧凑模式', 'success');
        });
    }

    function applyDensity(density) {
        if (density === 'comfortable') {
            document.documentElement.setAttribute('data-density', 'comfortable');
        } else {
            document.documentElement.removeAttribute('data-density');
        }

        const btn = document.getElementById('densityToggle');
        if (btn) {
            btn.innerHTML = density === 'comfortable'
                ? '<i data-lucide="rows-3"></i>'
                : '<i data-lucide="stretch-horizontal"></i>';
            lucide.createIcons({ nodes: [btn] });
        }
    }

    /* ==================== SIDEBAR ==================== */
    function initSidebar() {
        const sidebar = document.getElementById('sidebar');
        const toggle = document.getElementById('sidebarToggle');
        const overlay = document.getElementById('sidebarOverlay');
        const isMobile = () => window.innerWidth <= 768;

        toggle.addEventListener('click', () => {
            if (isMobile()) {
                sidebar.classList.toggle('open');
                overlay.classList.toggle('active');
            } else {
                sidebar.classList.toggle('collapsed');
                APP.sidebarOpen = !sidebar.classList.contains('collapsed');
            }
        });

        overlay.addEventListener('click', () => {
            sidebar.classList.remove('open');
            overlay.classList.remove('active');
        });
    }

    /* ==================== PANELS ==================== */
    function initPanels() {
        // Legacy accordion panels (history/result pages)
        document.querySelectorAll('.panel-toggle').forEach(btn => {
            btn.addEventListener('click', () => {
                const panel = btn.getAttribute('data-panel');
                const body = document.getElementById(panel + 'Body');
                if (!body) return;
                btn.classList.toggle('collapsed');
                body.classList.toggle('collapsed');
            });
        });
        // Stepper toggle is handled by shell.js — do NOT duplicate here
    }

    /* ==================== DROP ZONE ==================== */
    function initDropZone() {
        const zone = document.getElementById('dropZone');
        const input = document.getElementById('fileInput');
        const container = document.getElementById('fileChipContainer');
        const generateBtn = document.getElementById('generateBtn');

        if (!zone || !input) return;

        zone.addEventListener('click', () => input.click());
        zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('dragover'); });
        zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
        zone.addEventListener('drop', e => {
            e.preventDefault();
            zone.classList.remove('dragover');
            if (e.dataTransfer.files.length) {
                input.files = e.dataTransfer.files;
                showFileChip(e.dataTransfer.files[0]);
            }
        });
        input.addEventListener('change', () => {
            if (input.files.length) showFileChip(input.files[0]);
        });

        function showFileChip(file) {
            container.innerHTML = '';
            const sizeKB = (file.size / 1024).toFixed(1);
            const sizeTxt = sizeKB > 1024 ? (file.size / 1048576).toFixed(1) + ' MB' : sizeKB + ' KB';
            container.innerHTML = `
                <div class="file-chip">
                    <span class="file-chip-icon"><i data-lucide="file-text"></i></span>
                    <div class="file-chip-info">
                        <span class="file-chip-name">${escHtml(file.name)}</span>
                        <span class="file-chip-size">${sizeTxt}</span>
                    </div>
                    <button type="button" class="file-chip-remove" id="fileRemove"><i data-lucide="x"></i></button>
                </div>`;
            lucide.createIcons({ nodes: [container] });
            generateBtn.disabled = false;
            document.getElementById('notebookTitle').textContent = file.name;

            document.getElementById('fileRemove').addEventListener('click', () => {
                input.value = '';
                container.innerHTML = '';
                generateBtn.disabled = true;
                document.getElementById('notebookTitle').textContent = '新笔记';
            });
        }
    }

    /* ==================== FORM SUBMIT ==================== */
    function initForm() {
        const form = document.getElementById('uploadForm');
        if (!form) return;
        form.addEventListener('submit', e => {
            e.preventDefault();
            startGeneration();
        });
    }

    function startGeneration() {
        const form = document.getElementById('uploadForm');
        const fileInput = document.getElementById('fileInput');
        if (!fileInput.files.length) { showToast('请先选择文件', 'error'); return; }

        const checked = form.querySelectorAll('input[name="note_types"]:checked');
        if (!checked.length) { showToast('请至少选择一种笔记类型', 'error'); return; }

        const fd = new FormData(form);
        const btn = document.getElementById('generateBtn');
        setGenerateButtonLoading(btn, true);

        // Hide welcome
        const welcome = document.getElementById('welcomeCell');
        if (welcome) welcome.classList.add('hidden');

        // Add file info cell
        addFileInfoCell(fileInput.files[0]);
        // Add progress cell
        addProgressCell();

        // Read file as base64 for Tauri invoke
        const file = fileInput.files[0];
        const reader = new FileReader();
        reader.onload = function () {
            const base64 = reader.result.split(',')[1]; // strip data:...;base64, prefix
            const noteTypes = Array.from(checked).map(cb => cb.value);
            const lengthPreset = fd.get('length_preset') || 'standard';
            const obsidianVault = fd.get('obsidian_vault') || '';

            tauriInvoke('upload_file', {
                fileName: file.name,
                fileData: base64,
                noteTypes: noteTypes,
                lengthPreset: lengthPreset,
                obsidianVault: obsidianVault
            }).then(data => {
                if (data.error) { showToast(data.error, 'error'); resetBtn(); return; }
                APP.taskId = data.task_id;
                localStorage.setItem('activeTask', data.task_id);
                pollTask();
            }).catch(err => { showToast('上传错误: ' + err.message, 'error'); resetBtn(); });
        };
        reader.onerror = function () { showToast('文件读取失败', 'error'); resetBtn(); };
        reader.readAsDataURL(file);
    }

    function resetBtn() {
        const btn = document.getElementById('generateBtn');
        setGenerateButtonLoading(btn, false);
    }

    function setGenerateButtonLoading(btn, isLoading) {
        if (!btn) return;
        btn.disabled = isLoading;
        btn.innerHTML = isLoading
            ? '<i data-lucide="loader-2" class="icon-16 spin"></i> 处理中…'
            : '<i data-lucide="sparkles" class="icon-16"></i> 开始生成';
        lucide.createIcons({ nodes: [btn] });
    }

    /* ==================== CELLS ==================== */
    function cellsDiv() { return document.getElementById('cellsContainer'); }

    function addFileInfoCell(file) {
        const sizeKB = (file.size / 1024).toFixed(1);
        const sizeTxt = sizeKB > 1024 ? (file.size / 1048576).toFixed(1) + ' MB' : sizeKB + ' KB';
        const ext = file.name.split('.').pop().toUpperCase();
        const html = `
        <div class="cell cell-file" id="cellFile">
            <div class="cell-header">
                <span class="cell-tag"><span class="cell-tag-icon"><i data-lucide="file-text"></i></span> 文件信息</span>
                <div class="cell-actions">
                    <button class="cell-action" onclick="toggleCell('cellFile')" title="折叠"><i data-lucide="chevron-up"></i></button>
                </div>
            </div>
            <div class="cell-body" id="cellFileBody">
                <div class="info-grid">
                    <div class="info-item">
                        <div class="info-item-label">文件名</div>
                        <div class="info-item-value">${escHtml(file.name)}</div>
                    </div>
                    <div class="info-item">
                        <div class="info-item-label">类型</div>
                        <div class="info-item-value">${ext}</div>
                    </div>
                    <div class="info-item">
                        <div class="info-item-label">大小</div>
                        <div class="info-item-value">${sizeTxt}</div>
                    </div>
                    <div class="info-item">
                        <div class="info-item-label">时间</div>
                        <div class="info-item-value">${new Date().toLocaleTimeString('zh-CN')}</div>
                    </div>
                </div>
            </div>
        </div>`;
        cellsDiv().insertAdjacentHTML('beforeend', html);
        lucide.createIcons({ nodes: [cellsDiv().lastElementChild] });
    }

    function addProgressCell() {
        APP.progressStartTime = Date.now();
        const html = `
        <div class="cell cell-progress" id="cellProgress">
            <div class="cell-header">
                <span class="cell-tag"><span class="cell-tag-icon"><i data-lucide="loader-2"></i></span> 处理进度</span>
                <span class="shad-badge shad-badge-warning" id="progressBadge">处理中</span>
            </div>
            <div class="cell-body">
                <div class="progress-inner">
                    <div class="progress-orb">
                        <div class="progress-orb-ring"></div>
                        <div class="progress-orb-core" id="progressPercent">0%</div>
                    </div>
                    <div class="progress-track"><div class="progress-fill" id="progressFill"></div></div>
                    <div class="progress-stats">
                        <span id="progressStage">准备中</span>
                        <span id="progressPct">0%</span>
                    </div>
                    <div class="progress-msg" id="progressMsg">等待处理…</div>
                    <div class="progress-eta" id="progressEta" style="color:var(--muted-foreground);font-size:0.8rem;margin-top:4px;"></div>
                </div>
            </div>
        </div>`;
        cellsDiv().insertAdjacentHTML('beforeend', html);
        lucide.createIcons({ nodes: [cellsDiv().lastElementChild] });
    }

    /* ==================== POLLING ==================== */
    function pollTask() {
        if (!APP.taskId) return;
        tauriInvoke('get_task', { taskId: APP.taskId })
            .then(data => {
                if (data.error) { showToast(data.error, 'error'); resetBtn(); return; }
                updateProgress(data);
                if (data.status === 'processing') {
                    setTimeout(pollTask, POLL_INTERVAL_MS);
                } else if (data.status === 'completed') {
                    localStorage.removeItem('activeTask');
                    showResults(data);
                } else if (data.status === 'partial_failed') {
                    localStorage.removeItem('activeTask');
                    showPartialFailed(data);
                } else if (data.status === 'failed') {
                    localStorage.removeItem('activeTask');
                    showError(data);
                }
            })
            .catch(() => setTimeout(pollTask, RETRY_INTERVAL_MS));
    }

    function updateProgress(data) {
        const fill = document.getElementById('progressFill');
        const pct = document.getElementById('progressPct');
        const percent = document.getElementById('progressPercent');
        const stage = document.getElementById('progressStage');
        const msg = document.getElementById('progressMsg');
        const eta = document.getElementById('progressEta');
        if (fill)    fill.style.width = data.progress + '%';
        if (pct)     pct.textContent = data.progress + '%';
        if (percent) percent.textContent = data.progress + '%';
        if (stage)   stage.textContent = data.stage || '';
        if (msg)     msg.textContent = data.message || '';

        // 时间预测
        if (eta && APP.progressStartTime && data.progress > 0 && data.progress < 100) {
            const elapsed = (Date.now() - APP.progressStartTime) / 1000;
            const remaining = elapsed / data.progress * (100 - data.progress);
            if (remaining < 60) {
                eta.textContent = '预计剩余 ' + Math.ceil(remaining) + ' 秒';
            } else {
                eta.textContent = '预计剩余 ' + Math.ceil(remaining / 60) + ' 分钟';
            }
        } else if (eta) {
            eta.textContent = '';
        }
    }

    /* ==================== RESULTS ==================== */
    function showResults(data) {
        // Finalize progress cell
        const badge = document.getElementById('progressBadge');
        if (badge) { badge.className = 'shad-badge shad-badge-success'; badge.textContent = '完成'; }
        const fill = document.getElementById('progressFill');
        if (fill) fill.style.width = '100%';
        const pct = document.getElementById('progressPct');
        if (pct) pct.textContent = '100%';
        const percent = document.getElementById('progressPercent');
        if (percent) percent.textContent = '✓';

        resetBtn();

        if (data.errors && data.errors.length) {
            data.errors.forEach(err => {
                const errHtml = `<div class="cell"><div class="cell-body"><div class="error-message">${escHtml(err)}</div></div></div>`;
                cellsDiv().insertAdjacentHTML('beforeend', errHtml);
            });
        }

        if (data.notes) {
            // Add breadcrumb navigation if multiple note types
            addBreadcrumbNav(data);

            Object.entries(data.notes).forEach(([type, info]) => {
                APP.noteCache[type] = info.content;
                APP.currentViewModes[type] = 'preview';
                renderNoteCell(type, info);
            });
        }

        // Add download-all cell
        addActionsCell(data);
        scrollToBottom();
    }

    function renderNoteCell(type, info) {
        const safeId = 'cell_' + type;
        const name = (info.type_info && info.type_info.name) || type;
        const iconName = getNoteIconName(type);
        const cleanName = normalizeNoteName(name, info.type_info && info.type_info.icon);
        const html = `
        <div class="cell cell-note" id="${safeId}">
            <div class="cell-header">
                <span class="cell-tag"><span class="cell-tag-icon"><i data-lucide="${iconName}"></i></span> ${escHtml(cleanName)}</span>
                <div class="cell-actions">
                    <div class="shad-tabs" id="tabs_${type}">
                        <button class="shad-tab active" data-view="preview" onclick="switchView('${type}','preview')">预览</button>
                        <button class="shad-tab" data-view="source" onclick="switchView('${type}','source')">源码</button>
                    </div>
                    <button class="cell-action" onclick="copyNote('${type}')" title="复制"><i data-lucide="copy"></i></button>
                    <button class="cell-action" onclick="downloadNote('${type}')" title="下载"><i data-lucide="download"></i></button>
                    <button class="cell-action" onclick="toggleCell('${safeId}')" title="折叠/展开"><i data-lucide="chevron-up"></i></button>
                </div>
            </div>
            <div class="cell-body" id="${safeId}Body">
                <div class="note-content" id="preview_${type}"></div>
                <pre class="note-source hidden" id="source_${type}"></pre>
            </div>
        </div>`;
        cellsDiv().insertAdjacentHTML('beforeend', html);

        const el = document.getElementById('preview_' + type);
        const RENDERERS = {
            mindmap:       renderMindmap,
            cornell:       renderCornell,
            qa:            renderQA,
            flashcard:     renderFlashcard,
            anki:          renderFlashcard,
            concept_map:   renderConceptGraph,
            summary:       renderSummary,
            timeline:      renderTimeline,
            note:          renderComprehensive,
            fusion:        renderFusion,
        };
        const renderer = RENDERERS[type] || renderMarkdown;
        renderer(info.content, el);
        document.getElementById('source_' + type).textContent = info.content;

        lucide.createIcons({ nodes: [document.getElementById(safeId)] });
    }

    function getNoteIconName(type) {
        const map = {
            summary: 'file-text',
            mindmap: 'network',
            cornell: 'notebook-tabs',
            qa: 'circle-help',
            timeline: 'history',
            concept_map: 'git-branch-plus',
            flashcard: 'rectangle-horizontal',
            anki: 'library-big',
            note: 'notebook-text',
            fusion: 'sparkles'
        };
        return map[type] || 'file';
    }

    function normalizeNoteName(name, emojiIcon) {
        const base = String(name || '');
        if (emojiIcon) {
            return base.replace(emojiIcon, '').trim();
        }
        return base.replace(/^[^\u4e00-\u9fa5A-Za-z0-9]+\s*/, '').trim();
    }

    function addActionsCell(data) {
        const html = `
        <div class="cell" id="cellActions">
            <div class="cell-body action-row">
                <button class="shad-btn-outline" onclick="downloadAll()">
                    <i data-lucide="archive"></i> 下载全部笔记 (ZIP)
                </button>
                <a class="shad-btn-outline" href="/">
                    <i data-lucide="plus"></i> 处理新文件
                </a>
            </div>
        </div>`;
        cellsDiv().insertAdjacentHTML('beforeend', html);
        lucide.createIcons({ nodes: [document.getElementById('cellActions')] });
    }

    function showError(data) {
        const badge = document.getElementById('progressBadge');
        if (badge) { badge.className = 'shad-badge shad-badge-destructive'; badge.textContent = '失败'; }
        resetBtn();
        const errors = data.errors || [data.error_msg || '处理失败'];
        errors.forEach(err => {
            const html = `<div class="cell"><div class="cell-body"><div class="error-message">${escHtml(err)}</div></div></div>`;
            cellsDiv().insertAdjacentHTML('beforeend', html);
        });
        scrollToBottom();
    }

    function showPartialFailed(data) {
        const badge = document.getElementById('progressBadge');
        if (badge) { badge.className = 'shad-badge shad-badge-warning'; badge.textContent = '部分失败'; }
        resetBtn();

        // 先渲染已成功的笔记
        if (data.notes) {
            showResults(data);
        }

        // 显示失败类型的重试面板
        const failedTypes = data.failed_types || [];
        if (failedTypes.length > 0) {
            const typeLabels = failedTypes.map(t => {
                const name = NOTE_NAME_MAP[t] || t;
                return `<span class="shad-badge shad-badge-destructive" style="margin: 2px;">${name}</span>`;
            }).join('');

            const retryHtml = `
                <div class="cell" id="retryPanel" style="border: 1px solid var(--destructive, #d96f79); border-radius: var(--radius, 0.625rem);">
                    <div class="cell-body" style="text-align: center; padding: 24px;">
                        <div style="margin-bottom: 12px; color: var(--destructive, #d96f79);">
                            <i data-lucide="alert-triangle" style="width: 32px; height: 32px;"></i>
                        </div>
                        <h3 style="margin: 0 0 8px; font-size: 1.1rem;">部分笔记生成失败</h3>
                        <p style="margin: 0 0 12px; color: var(--muted-foreground, #7a676f); font-size: 0.9rem;">
                            以下 ${failedTypes.length} 种笔记类型未能生成：
                        </p>
                        <div style="margin-bottom: 16px;">${typeLabels}</div>
                        <button id="retryFailedBtn" class="shad-btn shad-btn-primary" style="padding: 8px 24px; cursor: pointer;">
                            <i data-lucide="refresh-cw" style="width: 16px; height: 16px; margin-right: 6px;"></i>
                            重试失败的笔记
                        </button>
                    </div>
                </div>`;
            cellsDiv().insertAdjacentHTML('beforeend', retryHtml);

            try { lucide.createIcons({ nodes: [document.getElementById('retryPanel')] }); } catch(e) {}

            document.getElementById('retryFailedBtn').addEventListener('click', function() {
                this.disabled = true;
                this.innerHTML = '<i data-lucide="loader" style="width: 16px; height: 16px; margin-right: 6px; animation: spin 1s linear infinite;"></i>重试中...';
                try { lucide.createIcons({ nodes: [this] }); } catch(e) {}

                tauriInvoke('retry_failed_notes', { taskId: APP.taskId })
                    .then(result => {
                        showToast('正在重试 ' + (result.retrying_types || []).length + ' 种笔记...', 'info');
                        // 移除重试面板
                        const panel = document.getElementById('retryPanel');
                        if (panel) panel.remove();
                        // 重新开始轮询
                        addProgressCell();
                        pollTask();
                    })
                    .catch(err => {
                        showToast('重试失败: ' + err, 'error');
                        this.disabled = false;
                        this.innerHTML = '<i data-lucide="refresh-cw" style="width: 16px; height: 16px; margin-right: 6px;"></i>重试失败的笔记';
                        try { lucide.createIcons({ nodes: [this] }); } catch(e) {}
                    });
            });
        }
        scrollToBottom();
    }

    /* ==================== RESULT PAGE LOADER ==================== */
    // Used by result.html
    window.loadResultPage = function (taskId) {
        APP.taskId = taskId;
        tauriInvoke('get_task', { taskId: taskId })
            .then(data => {
                if (data.error) { showToast(data.error, 'error'); return; }
                // Update sidebar info on result page
                const fnEl = document.getElementById('taskFilename');
                if (fnEl) fnEl.textContent = data.filename || taskId;
                const titleEl = document.getElementById('notebookTitle');
                if (titleEl) titleEl.textContent = data.filename || '笔记结果';
                const statusEl = document.getElementById('taskStatus');
                if (statusEl) {
                    const statusMap = { completed: ['shad-badge-success', '完成'], processing: ['shad-badge-warning', '处理中'], failed: ['shad-badge-destructive', '失败'], partial_failed: ['shad-badge-warning', '部分失败'] };
                    const [cls, label] = statusMap[data.status] || ['shad-badge-secondary', data.status];
                    statusEl.innerHTML = '<span class="shad-badge ' + cls + '">' + label + '</span>';
                }
                // Render note type badges
                const typesEl = document.getElementById('taskNoteTypes');
                if (typesEl && data.note_types) {
                    typesEl.innerHTML = data.note_types.map(t => {
                        const icon = getNoteIconName(t);
                        const name = NOTE_NAME_MAP[t] || t;
                        return '<span class="shad-badge shad-badge-secondary"><i data-lucide="' + icon + '" class="note-type-icon"></i>' + name + '</span>';
                    }).join('');
                    try { lucide.createIcons({ nodes: [typesEl] }); } catch(e) {}
                }
                // Setup download all button
                const dlBtn = document.getElementById('downloadAllBtn');
                if (dlBtn) dlBtn.addEventListener('click', function() { downloadAll(); });

                if (data.status === 'completed') {
                    showResults(data);
                } else if (data.status === 'processing') {
                    addProgressCell();
                    updateProgress(data);
                    pollTask();
                } else if (data.status === 'partial_failed') {
                    showPartialFailed(data);
                } else if (data.status === 'failed') {
                    showError(data);
                }
            })
            .catch(err => showToast('加载失败: ' + err, 'error'));
    };

    /* ==================== MARKDOWN ==================== */
    /* ==================== MINDMAP (自研 SVG 树形渲染) ==================== */

    /**
     * 从 markdown 标题层级解析树结构
     * 输入: # root / ## branch / ### leaf
     * 输出: { name, children: [...], depth }
     */
    function parseMdTree(md) {
        const lines = md.split('\n').filter(l => l.trim());
        const root = { name: '主题', children: [], depth: 0 };
        const stack = [root];

        for (const line of lines) {
            const m = line.match(/^(#{1,6})\s+(.+)/);
            if (!m) continue;
            const depth = m[1].length;
            const name = m[2].replace(/[📝🧠💡🗺️📊🎯⚡📌🔗📖✨]/g, '').trim();
            if (!name) continue;
            const node = { name, children: [], depth };

            // 找到正确的父节点
            while (stack.length > 1 && stack[stack.length - 1].depth >= depth) {
                stack.pop();
            }
            stack[stack.length - 1].children.push(node);
            stack.push(node);
        }

        // 如果只有一个根且根的 name 没用，用第一个子节点
        if (root.children.length === 1) return root.children[0];
        if (root.children.length === 0) { root.name = '(空)'; return root; }
        return root;
    }

    /**
     * 递归计算树的布局坐标
     * 使用 Reingold-Tilford 简化算法
     */
    function layoutTree(node, cfg) {
        const { nodeH = 32, hGap = 200, vGap = 6 } = cfg || {};
        let leafIndex = 0;

        // 1) 递归计算每个子树的高度（叶子数 × nodeH）
        function countLeaves(n) {
            if (!n.children || n.children.length === 0) {
                n._leaves = 1;
                return 1;
            }
            let sum = 0;
            n.children.forEach(c => sum += countLeaves(c));
            n._leaves = sum;
            return sum;
        }

        // 2) 分配坐标
        function assignPos(n, x, yStart) {
            n._x = x;
            if (!n.children || n.children.length === 0) {
                n._y = yStart + nodeH / 2;
                return yStart + nodeH + vGap;
            }
            let yOffset = yStart;
            n.children.forEach(c => {
                yOffset = assignPos(c, x + hGap, yOffset);
            });
            // 父节点 y 居中于子节点范围
            const firstY = n.children[0]._y;
            const lastY = n.children[n.children.length - 1]._y;
            n._y = (firstY + lastY) / 2;
            return yOffset;
        }

        countLeaves(node);
        const totalH = node._leaves * (nodeH + vGap);
        assignPos(node, 40, 20);
        return totalH + 40;
    }

    /**
     * 收集所有节点和连线
     */
    function collectNodes(node, list, edges) {
        list.push(node);
        if (node.children) {
            node.children.forEach(c => {
                edges.push({ from: node, to: c });
                collectNodes(c, list, edges);
            });
        }
    }

    /**
     * 自研 SVG 思维导图渲染
     */
    function renderMindmap(md, el) {
        if (!md) { el.innerHTML = '<p class="empty-note">暂无内容</p>'; return; }

        const tree = parseMdTree(md);
        const palette = ['#6366f1','#8b5cf6','#ec4899','#f59e0b','#10b981','#3b82f6','#ef4444','#14b8a6'];

        // 计算合适的水平间距
        function maxDepth(n) { return n.children && n.children.length ? 1 + Math.max(...n.children.map(maxDepth)) : 0; }
        const depth = maxDepth(tree);
        const hGap = Math.max(140, Math.min(220, 800 / (depth + 1)));
        const totalH = layoutTree(tree, { nodeH: 30, hGap: hGap, vGap: 4 });

        const allNodes = [], allEdges = [];
        collectNodes(tree, allNodes, allEdges);

        // 计算需要的宽度
        const maxX = Math.max(...allNodes.map(n => n._x)) + 200;
        const svgW = Math.max(700, maxX);
        const svgH = Math.max(300, totalH);

        const cs = getComputedStyle(document.documentElement);
        const fg = cs.getPropertyValue('--foreground').trim() || '#333';
        const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        const bgColor = isDark ? '#2a2226' : '#ffffff';

        el.innerHTML = `
            <div class="mindmap-container" style="width:100%;overflow:auto;border-radius:10px;background:${bgColor};border:1px solid ${isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)'};">
                <svg id="mm-${Date.now()}" width="${svgW}" height="${svgH}" viewBox="0 0 ${svgW} ${svgH}" style="font-family:system-ui,-apple-system,sans-serif;">
                </svg>
            </div>`;
        const svg = el.querySelector('svg');
        if (!svg) return;

        const rootDepth = tree.depth || 0;

        // 绘制连线（贝塞尔曲线）
        allEdges.forEach(e => {
            const depth = e.from.depth || 0;
            const color = palette[depth % palette.length];
            const isFromRoot = e.from.depth === rootDepth;
            const x1 = e.from._x + measureText(e.from.name, isFromRoot) + 14;
            const y1 = e.from._y;
            const x2 = e.to._x;
            const y2 = e.to._y;
            const cx = (x1 + x2) / 2;

            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', `M${x1},${y1} C${cx},${y1} ${cx},${y2} ${x2},${y2}`);
            path.setAttribute('fill', 'none');
            path.setAttribute('stroke', color);
            path.setAttribute('stroke-width', Math.max(1.5, 3 - depth * 0.5));
            path.setAttribute('stroke-opacity', '0.5');
            svg.appendChild(path);
        });

        // 绘制节点
        allNodes.forEach(n => {
            const depth = n.depth || 0;
            const color = palette[depth % palette.length];
            const isRoot = n.depth === rootDepth;

            // 圆点
            const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            circle.setAttribute('cx', n._x);
            circle.setAttribute('cy', n._y);
            circle.setAttribute('r', isRoot ? 6 : 4);
            circle.setAttribute('fill', color);
            circle.setAttribute('stroke', bgColor);
            circle.setAttribute('stroke-width', '2');
            svg.appendChild(circle);

            // 文本
            const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            text.setAttribute('x', n._x + (isRoot ? 12 : 10));
            text.setAttribute('y', n._y + 4.5);
            text.setAttribute('font-size', isRoot ? '15px' : '13px');
            text.setAttribute('font-weight', isRoot ? '700' : depth === 1 ? '600' : '400');
            text.setAttribute('fill', isDark ? '#e9ddd5' : fg);
            text.textContent = n.name.length > 24 ? n.name.slice(0, 24) + '…' : n.name;
            svg.appendChild(text);
        });
    }

    /**
     * 估算文本像素宽度（用于连线起点计算）
     */
    function measureText(text, isRoot) {
        const fontSize = isRoot ? 15 : 13;
        // 中文约为字号宽度，英文约 0.6 倍
        let w = 0;
        for (const ch of text.slice(0, 24)) {
            w += ch.charCodeAt(0) > 127 ? fontSize : fontSize * 0.6;
        }
        return w;
    }

    /* ==================== Obsidian Compatibility ==================== */
    function preprocessObsidianMarkdown(md) {
        if (!md) return md;
        let text = md;

        // ==highlight== with multi-color support
        // ==!text== → red important, ==~text== → green pass, ==?text== → blue question
        text = text.replace(/==!([^=\n]+)==/g, '<mark class="mark-red">$1</mark>');
        text = text.replace(/==~([^=\n]+)==/g, '<mark class="mark-green">$1</mark>');
        text = text.replace(/==\?([^=\n]+)==/g, '<mark class="mark-blue">$1</mark>');
        text = text.replace(/==([^=\n]+)==/g, '<mark>$1</mark>');

        // ![[embed]] -> 占位提示（当前 web 端不直接渲染 Obsidian 内嵌块）
        text = text.replace(/!\[\[([^\]]+)\]\]/g, (_m, target) => {
            return `> [!info] 内嵌内容\n> Web 预览暂不直接渲染 \`${target}\`，请在 Obsidian 中查看。`;
        });

        // [[page|alias]] / [[page]] -> 自定义链接
        text = text.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, page, alias) => {
            const label = (alias || page).trim();
            const target = page.trim().replace(/"/g, '&quot;');
            return `<a href="#" class="obsidian-wikilink" data-target="${target}">${label}</a>`;
        });

        // Obsidian Callout: > [!note]
        const lines = text.split('\n');
        const out = [];
        let i = 0;
        while (i < lines.length) {
            const m = lines[i].match(/^>\s*\[!([A-Za-z]+)\]\s*(.*)$/);
            if (!m) {
                out.push(lines[i]);
                i += 1;
                continue;
            }

            const kind = (m[1] || 'note').toLowerCase();
            const title = (m[2] || kind).trim();
            const body = [];
            i += 1;
            while (i < lines.length && /^>\s?/.test(lines[i])) {
                body.push(lines[i].replace(/^>\s?/, ''));
                i += 1;
            }

            out.push(`<div class="obsidian-callout obsidian-callout-${kind}">`);
            out.push(`<div class="obsidian-callout-title">${title}</div>`);
            out.push(`<div class="obsidian-callout-body">`);
            out.push(body.join('\n'));
            out.push('</div></div>');
        }

        return out.join('\n');
    }

    function bindObsidianInteractions(el) {
        el.querySelectorAll('.obsidian-wikilink').forEach(link => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                const target = link.getAttribute('data-target') || '';
                showToast(`Wiki 链接：${target}（请在 Obsidian 中打开）`, 'success');
            });
        });
    }

    /* ==================== MARKDOWN ==================== */
    function renderMarkdown(md, el) {
        if (!md) { el.innerHTML = '<p class="empty-note">暂无内容</p>'; return; }

        // Configure marked
        marked.setOptions({
            highlight: function (code, lang) {
                if (lang && hljs.getLanguage(lang)) {
                    return hljs.highlight(code, { language: lang }).value;
                }
                return hljs.highlightAuto(code).value;
            },
            breaks: true,
            gfm: true
        });

        const normalized = preprocessObsidianMarkdown(md);
        el.innerHTML = marked.parse(normalized);

        // Render mermaid blocks
        el.querySelectorAll('pre code.language-mermaid').forEach(block => {
            const pre = block.parentElement;
            const wrapper = document.createElement('div');
            wrapper.className = 'mermaid';
            wrapper.textContent = block.textContent;
            pre.replaceWith(wrapper);
        });

        // Catch markmap code blocks (```markmap) — render as mindmap
        el.querySelectorAll('pre code.language-markmap').forEach(block => {
            const pre = block.parentElement;
            if (pre && pre.tagName === 'PRE') {
                const wrapper = document.createElement('div');
                wrapper.style.cssText = 'width:100%;overflow:hidden;border-radius:8px;';
                const mdText = block.textContent;
                pre.replaceWith(wrapper);
                renderMindmap(mdText, wrapper);
            }
        });

        // Catch old ```markdown blocks that contain markmap-style heading outlines
        el.querySelectorAll('pre code.language-markdown').forEach(block => {
            const text = block.textContent.trim();
            // Detect if it looks like a markmap outline (starts with # heading)
            if (/^#\s+/.test(text) && /\n##\s+/.test(text)) {
                const pre = block.parentElement;
                if (pre && pre.tagName === 'PRE') {
                    const wrapper = document.createElement('div');
                    wrapper.style.cssText = 'width:100%;overflow:hidden;border-radius:8px;';
                    pre.replaceWith(wrapper);
                    renderMindmap(text, wrapper);
                }
            }
        });

        // Also catch ```mermaid blocks that marked might not class properly
        el.querySelectorAll('code').forEach(block => {
            const text = block.textContent.trim();
            if (text.startsWith('graph ') || text.startsWith('flowchart ') ||
                text.startsWith('sequenceDiagram') || text.startsWith('classDiagram') ||
                text.startsWith('mindmap') || text.startsWith('timeline') ||
                text.startsWith('gantt') || text.startsWith('pie') ||
                text.startsWith('erDiagram') || text.startsWith('stateDiagram')) {
                const pre = block.parentElement;
                if (pre && pre.tagName === 'PRE') {
                    const wrapper = document.createElement('div');
                    wrapper.className = 'mermaid';
                    wrapper.textContent = text;
                    pre.replaceWith(wrapper);
                }
            }
        });

        try { mermaid.init(undefined, el.querySelectorAll('.mermaid')); } catch (e) { /* ignore */ }

        // Enhance code blocks: add language tag, copy button, line numbers
        enhanceCodeBlocks(el);

        // Enhance tables: wrap with responsive container
        enhanceTables(el);

        // Generate TOC for this note
        generateNoteTOC(el);

        // Add heading anchors
        addHeadingAnchors(el);

        bindObsidianInteractions(el);
        renderKaTeX(el);
        hetiEnhance(el);
    }

    /* ==================== CODE BLOCK ENHANCEMENTS ==================== */
    function enhanceCodeBlocks(el) {
        el.querySelectorAll('pre > code').forEach(codeEl => {
            const pre = codeEl.parentElement;
            if (pre.closest('.code-block-wrapper')) return; // already enhanced

            // Detect language
            const langClass = Array.from(codeEl.classList).find(c => c.startsWith('language-'));
            const lang = langClass ? langClass.replace('language-', '') : '';

            // Create wrapper
            const wrapper = document.createElement('div');
            wrapper.className = 'code-block-wrapper';

            // Header with language and copy button
            const header = document.createElement('div');
            header.className = 'code-block-header';
            header.innerHTML = `
                <span class="code-block-lang">${escHtml(lang || 'code')}</span>
                <button class="code-block-copy" title="复制代码">
                    <i data-lucide="copy" class="icon-14"></i>
                    <span>复制</span>
                </button>
            `;

            // Add line numbers
            const lines = codeEl.textContent.split('\n');
            if (lines[lines.length - 1] === '') lines.pop();
            if (lines.length > 1) {
                const lineNums = document.createElement('div');
                lineNums.className = 'code-line-numbers';
                lineNums.innerHTML = lines.map((_, i) => `<span>${i + 1}</span>`).join('\n');
                pre.classList.add('has-line-numbers');
                pre.insertBefore(lineNums, codeEl);
            }

            // Assemble
            pre.parentNode.insertBefore(wrapper, pre);
            wrapper.appendChild(header);
            wrapper.appendChild(pre);

            // Copy button handler
            header.querySelector('.code-block-copy').addEventListener('click', function() {
                navigator.clipboard.writeText(codeEl.textContent).then(() => {
                    this.innerHTML = '<i data-lucide="check" class="icon-14"></i><span>已复制</span>';
                    this.classList.add('copied');
                    lucide.createIcons({ nodes: [this] });
                    setTimeout(() => {
                        this.innerHTML = '<i data-lucide="copy" class="icon-14"></i><span>复制</span>';
                        this.classList.remove('copied');
                        lucide.createIcons({ nodes: [this] });
                    }, 2000);
                });
            });

            lucide.createIcons({ nodes: [header] });
        });
    }

    /* ==================== TABLE ENHANCEMENTS ==================== */
    function enhanceTables(el) {
        el.querySelectorAll('table').forEach(table => {
            if (table.parentElement.classList.contains('table-wrapper')) return;
            const wrapper = document.createElement('div');
            wrapper.className = 'table-wrapper';
            table.parentNode.insertBefore(wrapper, table);
            wrapper.appendChild(table);
        });
    }

    /* ==================== TOC GENERATION ==================== */
    function generateNoteTOC(el) {
        const headings = el.querySelectorAll('h1, h2, h3');
        if (headings.length < 3) return; // not enough headings for TOC

        const tocContainer = document.createElement('div');
        tocContainer.className = 'note-toc';
        tocContainer.innerHTML = '<div class="note-toc-title"><i data-lucide="list" class="icon-14"></i> 目录</div>';
        const tocList = document.createElement('ul');
        tocList.className = 'note-toc-list';

        headings.forEach((h, idx) => {
            const id = 'heading-' + Date.now() + '-' + idx;
            h.id = id;
            const level = parseInt(h.tagName.substring(1));
            const li = document.createElement('li');
            li.className = 'note-toc-item toc-level-' + level;
            li.innerHTML = `<a href="#${id}">${h.textContent}</a>`;
            li.querySelector('a').addEventListener('click', (e) => {
                e.preventDefault();
                h.scrollIntoView({ behavior: 'smooth', block: 'start' });
            });
            tocList.appendChild(li);
        });

        tocContainer.appendChild(tocList);

        // Add toggle button
        const toggleBtn = document.createElement('button');
        toggleBtn.className = 'note-toc-toggle';
        toggleBtn.innerHTML = '<i data-lucide="chevron-down" class="icon-14"></i>';
        toggleBtn.addEventListener('click', () => {
            tocContainer.classList.toggle('collapsed');
            toggleBtn.innerHTML = tocContainer.classList.contains('collapsed')
                ? '<i data-lucide="chevron-right" class="icon-14"></i>'
                : '<i data-lucide="chevron-down" class="icon-14"></i>';
            lucide.createIcons({ nodes: [toggleBtn] });
        });
        tocContainer.querySelector('.note-toc-title').appendChild(toggleBtn);

        el.insertBefore(tocContainer, el.firstChild);
        lucide.createIcons({ nodes: [tocContainer] });
    }

    /* ==================== HEADING ANCHORS ==================== */
    function addHeadingAnchors(el) {
        el.querySelectorAll('h1[id], h2[id], h3[id], h4[id]').forEach(h => {
            const anchor = document.createElement('a');
            anchor.className = 'heading-anchor';
            anchor.href = '#' + h.id;
            anchor.innerHTML = '#';
            anchor.addEventListener('click', (e) => {
                e.preventDefault();
                h.scrollIntoView({ behavior: 'smooth', block: 'start' });
            });
            h.style.position = 'relative';
            h.appendChild(anchor);
        });
    }

    /* ==================== SUMMARY ==================== */
    function renderSummary(md, el) {
        if (!md) { el.innerHTML = '<p class="empty-note">暂无内容</p>'; return; }

        // Parse title
        const titleMatch = md.match(/^#\s+.*?[-—]\s*(.+)$/m);
        const title = titleMatch ? titleMatch[1].trim() : '文档摘要';

        // Parse one-line summary (## 🎯 一句话概括 then > text)
        const oneLineMatch = md.match(/^>\s*(?:💡|📝|🎯)?\s*\*?\*?一句话(?:摘要|概括)\*?\*?[:：]\s*(.+)$/m)
            || md.match(/##\s*🎯?\s*一句话概括\s*\n+>\s*(.+)$/m)
            || md.match(/^>\s*(.+)$/m);
        const oneLine = oneLineMatch ? oneLineMatch[1].replace(/\*\*/g, '').trim() : '';

        // Parse paragraph summary (after ## 📋 or ## 📝 段落摘要)
        // New format: ### topic \n content blocks; fallback to old plain text
        const paragraphs = [];
        let paragraphFallback = '';
        const paraMatch = md.match(/##\s*(?:📋|📝)?\s*段落摘要\s*\n+([\s\S]*?)(?=\n##(?!#)|\n---|\n$)/);
        if (paraMatch) {
            const paraLines = paraMatch[1].split('\n');
            let cur = null;
            paraLines.forEach(line => {
                const h3 = line.match(/^###\s+(.+)/);
                if (h3) {
                    if (cur) paragraphs.push(cur);
                    cur = { topic: h3[1].trim(), content: '' };
                } else if (line.trim() && cur) {
                    cur.content += (cur.content ? '\n' : '') + line.trim();
                }
            });
            if (cur) paragraphs.push(cur);
            // If no ### headings found, treat as old plain text
            if (paragraphs.length === 0) paragraphFallback = paraMatch[1].trim();
        }

        // Parse key points (after ## 🔑 核心要点/关键要点/关键概念)
        const points = [];
        const pointsMatch = md.match(/##\s*🔑?\s*(?:核心要点|关键要点|关键概念|要点)\s*\n+([\s\S]*?)(?=\n##(?!#)|\n---|\n$)/);
        if (pointsMatch) {
            pointsMatch[1].split('\n').forEach(line => {
                const m = line.match(/^[-*]\s+(.+)/);
                if (m) points.push(m[1].trim());
            });
        }

        // Parse sections (after ## 📖 or ## 📑 章节摘要)
        const sections = [];
        const sectionBlock = md.match(/##\s*(?:📖|📑)?\s*(?:章节摘要|章节)\s*\n+([\s\S]*?)(?=\n##(?!#)|\n---|\n$)/);
        if (sectionBlock) {
            const lines = sectionBlock[1].split('\n');
            let current = null;
            lines.forEach(line => {
                const h3 = line.match(/^###\s+(.+)/);
                const bullet = line.match(/^[-*]\s+(.+)/);
                if (h3) {
                    if (current) sections.push(current);
                    current = { title: h3[1].trim(), content: '' };
                } else if (bullet && current) {
                    current.content += (current.content ? '\n' : '') + bullet[1].trim();
                } else if (line.trim() && current) {
                    current.content += (current.content ? '\n' : '') + line.trim();
                }
            });
            if (current) sections.push(current);
        }

        let html = `<div class="summary-container">`;

        // Header
        html += `<div class="summary-header">
            <div class="summary-icon"><i data-lucide="file-text"></i></div>
            <h2 class="summary-title">${title}</h2>
        </div>`;

        // One-line highlight banner
        if (oneLine) {
            html += `<div class="summary-oneline">
                <i data-lucide="sparkles"></i>
                <span>${oneLine}</span>
            </div>`;
        }

        // Paragraph summary as accordion (new) or plain text (fallback)
        if (paragraphs.length > 0) {
            html += `<div class="summary-paragraphs">
                <div class="summary-section-label"><i data-lucide="align-left"></i> 段落摘要</div>`;
            paragraphs.forEach((p, i) => {
                const pTopic = p.topic.replace(/\*\*/g, '');
                html += `<details class="summary-section-item" ${i === 0 ? 'open' : ''}>
                    <summary class="summary-section-head">
                        <span class="summary-section-idx">${i + 1}</span>
                        <span>${pTopic}</span>
                        <i data-lucide="chevron-down" class="summary-chevron"></i>
                    </summary>
                    <div class="summary-section-body">${marked.parse(preprocessObsidianMarkdown(p.content))}</div>
                </details>`;
            });
            html += `</div>`;
        } else if (paragraphFallback) {
            html += `<div class="summary-paragraph">
                <div class="summary-section-label"><i data-lucide="align-left"></i> 段落摘要</div>
                <div class="summary-paragraph-body">${marked.parse(preprocessObsidianMarkdown(paragraphFallback))}</div>
            </div>`;
        }

        // Key points as tags/chips
        if (points.length > 0) {
            html += `<div class="summary-points">
                <div class="summary-section-label"><i data-lucide="key"></i> 关键要点</div>
                <div class="summary-points-grid">`;
            points.forEach((p, i) => {
                const text = p.replace(/\*\*/g, '');
                html += `<div class="summary-point-card" style="--delay:${i * 60}ms">
                    <span class="summary-point-num">${i + 1}</span>
                    <span class="summary-point-text">${text}</span>
                </div>`;
            });
            html += `</div></div>`;
        }

        // Sections as collapsible accordion
        if (sections.length > 0) {
            html += `<div class="summary-sections">
                <div class="summary-section-label"><i data-lucide="list"></i> 章节摘要</div>`;
            sections.forEach((s, i) => {
                const sTitle = s.title.replace(/\*\*/g, '');
                html += `<details class="summary-section-item" ${i === 0 ? 'open' : ''}>
                    <summary class="summary-section-head">
                        <span class="summary-section-idx">${i + 1}</span>
                        <span>${sTitle}</span>
                        <i data-lucide="chevron-down" class="summary-chevron"></i>
                    </summary>
                    <div class="summary-section-body">${marked.parse(s.content)}</div>
                </details>`;
            });
            html += `</div>`;
        }

        html += `</div>`;
        el.innerHTML = html;
    }

    /* ==================== TIMELINE ==================== */
    function renderTimeline(md, el) {
        if (!md) { el.innerHTML = '<p class="empty-note">暂无内容</p>'; return; }

        // Parse title
        const titleMatch = md.match(/^#\s+(?:📅|🔄|⏳)?\s*(?:时间线|流程图)笔记\s*[-—]\s*(.+)$/m)
            || md.match(/^#\s+.*?[-—]\s*(.+)$/m);
        const title = titleMatch ? titleMatch[1].trim() : '时间线 / 流程图';

        // Parse type badge
        const isTimeline = !!md.match(/📅/);
        const typeBadge = isTimeline
            ? { icon: 'calendar', label: '时间线', css: 'tl-badge-time' }
            : { icon: 'git-branch', label: '流程图', css: 'tl-badge-flow' };

        // Extract mermaid code block
        let mermaidCode = '';
        const mermaidMatch = md.match(/```mermaid\s*\n([\s\S]*?)```/);
        if (mermaidMatch) mermaidCode = mermaidMatch[1].trim();

        // Extract explanation
        let explanation = '';
        const expMatch = md.match(/##\s*(?:📝|📖|💡)?\s*(?:详细说明|说明|解读|Explanation)\s*\n+([\s\S]*?)(?=\n##|\n---|\n$)/);
        if (expMatch) explanation = expMatch[1].trim();

        // Extract key nodes for visual timeline strip (only for timeline type)
        const timeNodes = [];
        if (mermaidCode && isTimeline) {
            // Parse timeline syntax: Event : Description
            const timelineLines = mermaidCode.match(/^\s*(.+?)\s*:\s*(.+)$/gm);
            if (timelineLines) {
                timelineLines.forEach(line => {
                    const m = line.match(/^\s*(.+?)\s*:\s*(.+)$/);
                    if (m) {
                        const label = m[1].trim();
                        const desc = m[2].trim();
                        // Skip mermaid directives like "timeline", "title xxx", "section xxx"
                        if (/^(timeline|title|section|graph|flowchart|%%)/i.test(label)) return;
                        timeNodes.push({ label, desc });
                    }
                });
            }
        }

        // For flowcharts, extract clean node names for a summary strip
        const flowSteps = [];
        if (mermaidCode && !isTimeline) {
            const seen = new Set();
            // Match node definitions: ID[text] or ID(text) or ID{text} or ID["text"]
            const nodeRegex = /\w+\s*[\[\(\{]["']?([^"'\]\)\}]+)["']?[\]\)\}]/g;
            let nm;
            while ((nm = nodeRegex.exec(mermaidCode)) !== null) {
                const name = nm[1].trim();
                if (name && !seen.has(name) && name.length < 50) {
                    seen.add(name);
                    flowSteps.push(name);
                }
            }
        }

        const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        let html = `<div class="tl-container">`;

        // Header
        html += `<div class="tl-header">
            <div class="tl-icon"><i data-lucide="${typeBadge.icon}"></i></div>
            <h2 class="tl-title">${escHtml(title)}</h2>
            <span class="tl-badge ${typeBadge.css}">${typeBadge.label}</span>
        </div>`;

        // Visual timeline strip (only for timeline type with valid nodes)
        if (timeNodes.length > 0) {
            html += `<div class="tl-strip-wrap"><div class="tl-strip">`;
            timeNodes.forEach((n, i) => {
                html += `<div class="tl-node" style="--delay:${i * 80}ms">
                    <div class="tl-node-dot"></div>
                    <div class="tl-node-content">
                        <div class="tl-node-label">${escHtml(n.label)}</div>
                        ${n.desc ? `<div class="tl-node-desc">${escHtml(n.desc)}</div>` : ''}
                    </div>
                </div>`;
                if (i < timeNodes.length - 1) {
                    html += `<div class="tl-connector"></div>`;
                }
            });
            html += `</div></div>`;
        }

        // Flowchart step summary (compact chip strip for flowcharts)
        if (flowSteps.length > 0) {
            html += `<div class="tl-flow-steps">`;
            flowSteps.forEach((step, i) => {
                html += `<span class="tl-flow-chip">${escHtml(step)}</span>`;
                if (i < flowSteps.length - 1) html += `<i data-lucide="chevron-right" style="width:14px;height:14px;color:var(--muted-foreground);flex-shrink:0;"></i>`;
            });
            html += `</div>`;
        }

        // Mermaid diagram (shown directly, scrollable for wide graphs)
        if (mermaidCode) {
            html += `<div class="tl-diagram">
                <div class="tl-diagram-label"><i data-lucide="share-2"></i> 图表</div>
                <div class="tl-mermaid-wrap" style="background:${isDark ? '#2a2226' : '#ffffff'};border-radius:0 0 var(--radius-lg) var(--radius-lg);padding:24px;border:1px solid ${isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)'};border-top:none;overflow-x:auto;">
                    <pre class="mermaid" style="text-align:center;">${escHtml(mermaidCode)}</pre>
                </div>
            </div>`;
        }

        // Explanation
        if (explanation) {
            html += `<div class="tl-explanation">
                <div class="tl-diagram-label"><i data-lucide="book-open"></i> 解读</div>
                <div class="tl-exp-text">${marked.parse(explanation)}</div>
            </div>`;
        }

        html += `</div>`;
        el.innerHTML = html;

        // Init lucide icons in this container
        try { lucide.createIcons({ nodes: [el] }); } catch(e) {}

        // Trigger mermaid rendering immediately (no longer collapsible)
        if (mermaidCode && window.mermaid) {
            try { mermaid.run({ nodes: el.querySelectorAll('.mermaid') }); } catch(e) { console.warn('mermaid render error', e); }
        }
    }

    /* ==================== COMPREHENSIVE ==================== */
    function renderComprehensive(md, el) {
        if (!md) { el.innerHTML = '<p class="empty-note">暂无内容</p>'; return; }

        // Parse title
        const titleMatch = md.match(/^#\s+(?:📓|📘)?\s*(?:综合笔记|笔记)\s*[-—]\s*(.+)$/m);
        const title = titleMatch ? titleMatch[1].trim() : '综合笔记';

        // Parse paragraph summary
        let paragraph = '';
        const paraMatch = md.match(/##\s*📋?\s*摘要\s*\n+([\s\S]*?)(?=\n##|\n$)/);
        if (paraMatch) paragraph = paraMatch[1].trim();

        // Parse key concepts
        const concepts = [];
        const conceptMatch = md.match(/##\s*🔑?\s*关键概念\s*\n+([\s\S]*?)(?=\n##|\n$)/);
        if (conceptMatch) {
            conceptMatch[1].split('\n').forEach(line => {
                const m = line.match(/^[-*]\s+\*\*(.+?)\*\*/);
                if (m) concepts.push(m[1].trim());
            });
        }

        // Parse outline
        let outline = '';
        const outlineMatch = md.match(/##\s*📑?\s*大纲\s*\n+([\s\S]*?)(?=\n##|\n$)/);
        if (outlineMatch) outline = outlineMatch[1].trim();

        // Parse markmap code block
        let markmapMd = '';
        const mmMatch = md.match(/```markmap\s*\n([\s\S]*?)```/);
        if (mmMatch) markmapMd = mmMatch[1].trim();

        // Build tabs
        const tabs = [];
        if (paragraph || concepts.length) tabs.push({ id: 'summary', icon: 'file-text', label: '摘要' });
        if (outline) tabs.push({ id: 'outline', icon: 'list-tree', label: '大纲' });
        if (markmapMd) tabs.push({ id: 'mindmap', icon: 'brain', label: '思维导图' });

        let html = `<div class="comp-container">`;

        // Header
        html += `<div class="comp-header">
            <div class="comp-icon"><i data-lucide="notebook-text"></i></div>
            <h2 class="comp-title">${title}</h2>
            <span class="comp-badge">${tabs.length} 个视图</span>
        </div>`;

        // Tab bar
        if (tabs.length > 1) {
            html += `<div class="comp-tabs">`;
            tabs.forEach((t, i) => {
                html += `<button class="comp-tab ${i === 0 ? 'comp-tab-active' : ''}" data-tab="${t.id}">
                    <i data-lucide="${t.icon}"></i> ${t.label}
                </button>`;
            });
            html += `</div>`;
        }

        // Tab panels
        tabs.forEach((t, i) => {
            html += `<div class="comp-panel ${i === 0 ? 'comp-panel-active' : ''}" data-panel="${t.id}">`;

            if (t.id === 'summary') {
                if (paragraph) {
                    html += `<div class="comp-summary-text">${marked.parse(paragraph)}</div>`;
                }
                if (concepts.length) {
                    html += `<div class="comp-concepts">
                        <div class="comp-concepts-label"><i data-lucide="key"></i> 关键概念</div>
                        <div class="comp-concepts-grid">`;
                    concepts.forEach((c, ci) => {
                        html += `<span class="comp-concept-tag" style="--delay:${ci * 50}ms">${c}</span>`;
                    });
                    html += `</div></div>`;
                }
            } else if (t.id === 'outline') {
                html += `<div class="comp-outline">${marked.parse(outline)}</div>`;
            } else if (t.id === 'mindmap') {
                html += `<div class="comp-mindmap-wrap" id="comp-mindmap-container"></div>`;
            }

            html += `</div>`;
        });

        html += `</div>`;
        el.innerHTML = html;

        // Tab switching logic
        el.querySelectorAll('.comp-tab').forEach(btn => {
            btn.addEventListener('click', () => {
                el.querySelectorAll('.comp-tab').forEach(b => b.classList.remove('comp-tab-active'));
                el.querySelectorAll('.comp-panel').forEach(p => p.classList.remove('comp-panel-active'));
                btn.classList.add('comp-tab-active');
                const panel = el.querySelector(`[data-panel="${btn.dataset.tab}"]`);
                if (panel) panel.classList.add('comp-panel-active');

                // Lazy render mindmap on first switch
                if (btn.dataset.tab === 'mindmap' && markmapMd) {
                    const mmContainer = el.querySelector('#comp-mindmap-container');
                    if (mmContainer && !mmContainer.dataset.rendered) {
                        mmContainer.dataset.rendered = '1';
                        renderMindmap(markmapMd, mmContainer);
                    }
                }
            });
        });
    }

    /* ==================== FUSION NOTE ==================== */
    function renderFusion(md, el) {
        if (!md) { el.innerHTML = '<p class="empty-note">暂无内容</p>'; return; }

        // Parse title
        const titleMatch = md.match(/^#\s+🔮\s*融合笔记\s*[-—]\s*(.+)$/m)
            || md.match(/^#\s+.*?[-—]\s*(.+)$/m);
        const title = titleMatch ? titleMatch[1].trim() : '融合笔记';

        // Extract sections by finding fusion-specific emoji headings as boundaries
        // Sub-notes may contain internal ## and --- which must not be treated as boundaries
        const fusionHeadings = [
            { id: 'guide',      re: /##\s*📖\s*学习导读/ },
            { id: 'summary',    re: /##\s*📝\s*多级摘要/ },
            { id: 'mindmap',    re: /##\s*🧠\s*思维导图/ },
            { id: 'qa',         re: /##\s*❓\s*问答笔记/ },
            { id: 'flashcard',  re: /##\s*🃏\s*闪卡速记/ },
            { id: 'timeline',   re: /##\s*⏳\s*时间线/ },
            { id: 'conceptmap', re: /##\s*🔗\s*概念图/ },
            { id: 'cornell',    re: /##\s*📋\s*康奈尔笔记/ },
            { id: 'core',       re: /##\s*🔑\s*核心知识点速查/ },
        ];
        const positions = [];
        fusionHeadings.forEach(h => {
            const m = h.re.exec(md);
            if (m) positions.push({ id: h.id, start: m.index, headEnd: m.index + m[0].length });
        });
        positions.sort((a, b) => a.start - b.start);

        const sectionMap = {};
        positions.forEach((pos, i) => {
            const contentStart = pos.headEnd;
            const contentEnd = i < positions.length - 1 ? positions[i + 1].start : md.length;
            let content = md.substring(contentStart, contentEnd);
            // Strip leading/trailing whitespace and trailing --- separator
            content = content.replace(/\n---\s*$/g, '').trim();
            if (content) sectionMap[pos.id] = content;
        });

        const guide       = sectionMap.guide || '';
        const summaryMd   = sectionMap.summary || '';
        const mindmapMd   = sectionMap.mindmap || '';
        const qaMd        = sectionMap.qa || '';
        const flashcardMd = sectionMap.flashcard || '';
        const timelineMd  = sectionMap.timeline || '';
        const conceptMapMd = sectionMap.conceptmap || '';
        const cornellMd   = sectionMap.cornell || '';
        const coreMd      = sectionMap.core || '';

        // Build tabs (only for non-empty sections)
        const tabs = [
            { id: 'guide',     icon: 'book-open',   label: '导读',   content: guide,       renderer: null },
            { id: 'summary',   icon: 'file-text',   label: '摘要',   content: summaryMd,   renderer: (c, e) => renderSummary('# 📝 摘要笔记 - ' + title + '\n' + c, e) },
            { id: 'mindmap',   icon: 'brain',       label: '思维导图', content: mindmapMd, renderer: renderMindmap },
            { id: 'qa',        icon: 'help-circle', label: '问答',   content: qaMd,        renderer: renderQA },
            { id: 'flashcard', icon: 'credit-card', label: '闪卡',   content: flashcardMd, renderer: renderFlashcard },
            { id: 'timeline',  icon: 'history',     label: '时间线', content: timelineMd,  renderer: renderTimeline },
            { id: 'conceptmap',icon: 'git-branch-plus', label: '概念图', content: conceptMapMd, renderer: renderConceptGraph },
            { id: 'cornell',   icon: 'layout',      label: '康奈尔', content: cornellMd,   renderer: renderCornell },
            { id: 'core',      icon: 'star',        label: '核心概念', content: coreMd,    renderer: null },
        ].filter(t => t.content);

        if (tabs.length === 0) { renderMarkdown(md, el); return; }

        // Header
        let html = `<div class="fusion-container">
            <div class="fusion-header">
                <div class="fusion-icon"><i data-lucide="sparkles"></i></div>
                <div class="fusion-header-text">
                    <h2 class="fusion-title">${title}</h2>
                    <span class="fusion-subtitle">融合了 ${tabs.length} 种笔记视角</span>
                </div>
                <div class="fusion-badges">`;

        // mini badges showing module count (dynamic based on actual tabs)
        const badgeMap = {
            summary: ['file-text', '摘要'], mindmap: ['brain', '导图'], qa: ['help-circle', '问答'],
            flashcard: ['credit-card', '闪卡'], timeline: ['history', '时间线'],
            conceptmap: ['git-branch-plus', '概念图'], cornell: ['layout', '康奈尔']
        };
        tabs.filter(t => badgeMap[t.id]).forEach(t => {
            const [ico, lbl] = badgeMap[t.id];
            html += `<span class="fusion-mini-badge"><i data-lucide="${ico}"></i>${lbl}</span>`;
        });

        html += `</div></div>`;

        // Tab bar
        html += `<div class="fusion-tabs">`;
        tabs.forEach((t, i) => {
            html += `<button class="fusion-tab ${i === 0 ? 'fusion-tab-active' : ''}" data-tab="${t.id}">
                <i data-lucide="${t.icon}"></i><span>${t.label}</span>
            </button>`;
        });
        html += `</div>`;

        // Tab panels
        tabs.forEach((t, i) => {
            const isFailed = t.content && t.content.trimStart().startsWith('⚠️');
            html += `<div class="fusion-panel ${i === 0 ? 'fusion-panel-active' : ''}" data-panel="${t.id}">`;
            if (isFailed) {
                // 失败的子模块：显示错误信息 + 重试按钮
                const errMsg = t.content.replace(/^⚠️\s*/, '').trim();
                html += `<div class="fusion-error-panel" data-module="${t.id}">
                    <div class="fusion-error-icon"><i data-lucide="alert-triangle"></i></div>
                    <p class="fusion-error-msg">${escHtml(errMsg)}</p>
                    <button class="shad-btn shad-btn-outline fusion-retry-btn" data-module="${t.id}">
                        <i data-lucide="refresh-cw"></i> 重试该模块
                    </button>
                </div>`;
            } else if (t.renderer === null) {
                // guide and core: render as markdown
                html += `<div class="fusion-plain-content"></div>`;
            } else {
                // placeholder — will be rendered after mount
                html += `<div class="fusion-sub-content" data-tab-id="${t.id}"></div>`;
            }
            html += `</div>`;
        });

        html += `</div>`;
        el.innerHTML = html;
        lucide.createIcons({ nodes: [el] });

        // Render markdown-only panels immediately (skip failed ones)
        tabs.forEach(t => {
            const isFailed = t.content && t.content.trimStart().startsWith('⚠️');
            if (!isFailed && t.renderer === null && t.content) {
                const pane = el.querySelector(`[data-panel="${t.id}"] .fusion-plain-content`);
                if (pane) pane.innerHTML = marked.parse(t.content);
            }
        });

        // Render the first sub-renderer panel immediately (skip failed ones)
        const firstActive = tabs[0];
        const firstFailed = firstActive.content && firstActive.content.trimStart().startsWith('⚠️');
        if (!firstFailed && firstActive.renderer) {
            const subEl = el.querySelector(`[data-panel="${firstActive.id}"] .fusion-sub-content`);
            if (subEl) firstActive.renderer(firstActive.content, subEl);
        }

        // Tab switching
        el.querySelectorAll('.fusion-tab').forEach(btn => {
            btn.addEventListener('click', () => {
                el.querySelectorAll('.fusion-tab').forEach(b => b.classList.remove('fusion-tab-active'));
                el.querySelectorAll('.fusion-panel').forEach(p => p.classList.remove('fusion-panel-active'));
                btn.classList.add('fusion-tab-active');
                const tabId = btn.dataset.tab;
                const panel = el.querySelector(`[data-panel="${tabId}"]`);
                if (panel) panel.classList.add('fusion-panel-active');

                // Lazy render specialist renderer on first visit (skip failed panels)
                const tab = tabs.find(t => t.id === tabId);
                const tabFailed = tab && tab.content && tab.content.trimStart().startsWith('⚠️');
                if (tab && tab.renderer && !tabFailed) {
                    const subEl = panel.querySelector('.fusion-sub-content');
                    if (subEl && !subEl.dataset.rendered) {
                        subEl.dataset.rendered = '1';
                        tab.renderer(tab.content, subEl);
                        lucide.createIcons({ nodes: [subEl] });
                    }
                }
            });
        });

        // Fusion 子模块重试按钮
        el.querySelectorAll('.fusion-retry-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const moduleId = btn.dataset.module;
                if (!APP.taskId) {
                    showToast('无法重试：缺少任务 ID', 'error');
                    return;
                }

                // 映射前端 tab id 到后端 module_type
                const moduleMap = {
                    summary: 'summary', mindmap: 'mindmap', qa: 'qa',
                    flashcard: 'flashcard', timeline: 'timeline',
                    conceptmap: 'concept_map', cornell: 'cornell'
                };
                const moduleType = moduleMap[moduleId] || moduleId;

                // 显示加载状态
                const panel = btn.closest('.fusion-error-panel');
                if (panel) {
                    panel.innerHTML = `<div class="fusion-retry-loading">
                        <div class="spinner"></div>
                        <p>正在重新生成...</p>
                    </div>`;
                }

                try {
                    await tauriInvoke('retry_fusion_module', {
                        taskId: APP.taskId,
                        moduleType: moduleType
                    });
                    showToast('正在重新生成模块，完成后自动刷新', 'info');
                } catch (e) {
                    showToast('重试失败: ' + e, 'error');
                    if (panel) {
                        panel.innerHTML = `<div class="fusion-error-panel">
                            <div class="fusion-error-icon"><i data-lucide="alert-triangle"></i></div>
                            <p class="fusion-error-msg">重试失败: ${escHtml(String(e))}</p>
                            <button class="shad-btn shad-btn-outline fusion-retry-btn" data-module="${moduleId}"
                                onclick="this.closest('.fusion-error-panel').querySelector('.fusion-retry-btn').click()">
                                <i data-lucide="refresh-cw"></i> 再次重试
                            </button>
                        </div>`;
                        lucide.createIcons({ nodes: [panel] });
                    }
                }
            });
        });

        // 监听 fusion 子模块重试完成事件
        if (window.__TAURI__) {
            const { listen } = window.__TAURI__.event;
            listen('fusion-retry-done', (event) => {
                if (event.payload.task_id === APP.taskId) {
                    showToast('模块重新生成成功，正在刷新...', 'success');
                    // 重新加载整个结果页面以获取更新后的 fusion 内容
                    setTimeout(() => loadResultPage(APP.taskId), 500);
                }
            });
            listen('fusion-retry-error', (event) => {
                if (event.payload.task_id === APP.taskId) {
                    showToast('模块重试失败: ' + event.payload.error, 'error');
                }
            });
        }
    }

    /* ==================== CONCEPT GRAPH (D3.js) ==================== */
    function renderConceptGraph(md, el) {
        if (!md) { el.innerHTML = '<p class="empty-note">暂无内容</p>'; return; }

        // 1) 先尝试提取 mermaid 代码块，用 mermaid 渲染
        const mermaidMatch = md.match(/```mermaid\s*\n([\s\S]*?)```/);

        // 2) 同时解析 relations 和 definitions 用于力导向图 fallback 和 definitions 面板
        const nodes = [];
        const links = [];
        const nodeMap = {};
        const definitions = [];
        let nodeId = 0;
        let inMermaid = false;

        function addNode(name, group) {
            name = name.replace(/[📖🔗💡📌🎯⚡✨◼]/g, '').replace(/\*\*/g, '').trim();
            if (!name || name.length < 1) return null;
            const key = name.toLowerCase();
            if (!nodeMap[key]) {
                nodeMap[key] = { id: nodeId++, name: name, group: group };
                nodes.push(nodeMap[key]);
            }
            return nodeMap[key];
        }

        const mdLines = md.split('\n');
        let currentGroup = 0;
        let currentSection = '';

        mdLines.forEach(line => {
            // Skip mermaid code blocks
            if (line.trim().startsWith('```mermaid')) { inMermaid = true; return; }
            if (inMermaid) { if (line.trim() === '```') inMermaid = false; return; }

            const h2 = line.match(/^##\s+(.+)/);

            if (h2) {
                currentGroup++;
                currentSection = h2[1].replace(/[📖🔗💡📌🎯⚡✨◼]/g, '').trim().toLowerCase();
                return;
            }

            // Parse definitions: - **concept**: definition
            const defMatch = line.match(/^\s*[-*]\s+\*\*(.+?)\*\*\s*[：:]\s*(.+)/);
            if (defMatch) {
                definitions.push({ concept: defMatch[1].trim(), definition: defMatch[2].trim() });
                return;
            }

            // Parse three-part relations: source → relation → target
            const threePartArrow = line.match(/^\s*[-*]\s+(.+?)\s*(?:→|->|-->)\s+(.+?)\s+(?:→|->|-->)\s+(.+)/);
            if (threePartArrow) {
                const src = threePartArrow[1].replace(/\*\*/g, '').trim();
                const rel = threePartArrow[2].replace(/\*\*/g, '').trim();
                const tgt = threePartArrow[3].replace(/\*\*/g, '').trim();
                const srcNode = addNode(src, currentGroup);
                const tgtNode = addNode(tgt, currentGroup);
                if (srcNode && tgtNode) {
                    links.push({ source: srcNode.id, target: tgtNode.id, label: rel });
                }
                return;
            }

            // Parse two-part relations: source → target (label)
            const twoPartArrow = line.match(/^\s*[-*]\s+(.+?)\s*(?:→|->|-->)\s+(.+)/);
            if (twoPartArrow) {
                const src = twoPartArrow[1].replace(/\*\*/g, '').trim();
                const rest = twoPartArrow[2];
                const labelMatch = rest.match(/(.+?)[\(（](.+?)[\)）]/);
                let tgt, label;
                if (labelMatch) {
                    tgt = labelMatch[1].replace(/\*\*/g, '').trim();
                    label = labelMatch[2].trim();
                } else {
                    tgt = rest.replace(/\*\*/g, '').trim();
                    label = '';
                }
                const srcNode = addNode(src, currentGroup);
                const tgtNode = addNode(tgt, currentGroup);
                if (srcNode && tgtNode) {
                    links.push({ source: srcNode.id, target: tgtNode.id, label: label });
                }
            }
        });

        // Build layout: mermaid for graph, D3 as fallback, plus definitions below
        const graphId = 'graph-' + Date.now();
        const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        const bgColor = isDark ? '#2a2226' : '#ffffff';

        let graphHtml = '';
        let useMermaid = false;

        if (mermaidMatch && mermaidMatch[1].trim()) {
            useMermaid = true;
            graphHtml = `<div class="concept-mermaid-wrap" style="background:${isDark ? '#2a2226' : '#ffffff'};border-radius:var(--radius-lg);padding:24px;border:1px solid ${isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)'};overflow-x:auto;min-height:350px;">
                <pre class="mermaid" style="text-align:center;">${escHtml(mermaidMatch[1].trim())}</pre>
            </div>`;
        } else if (nodes.length >= 2) {
            graphHtml = `<div class="concept-graph-container" style="background:${isDark ? '#2a2226' : '#ffffff'};border-radius:var(--radius-lg);border:1px solid ${isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)'};">
                <div class="concept-graph-toolbar">
                    <button class="shad-btn-ghost concept-graph-btn" data-action="zoomIn" title="放大"><i data-lucide="zoom-in"></i></button>
                    <button class="shad-btn-ghost concept-graph-btn" data-action="zoomOut" title="缩小"><i data-lucide="zoom-out"></i></button>
                    <button class="shad-btn-ghost concept-graph-btn" data-action="reset" title="重置"><i data-lucide="maximize-2"></i></button>
                </div>
                <svg id="${graphId}" class="concept-graph-svg"></svg>
            </div>`;
        }

        // Definitions panel
        let defsHtml = '';
        if (definitions.length > 0) {
            defsHtml = `<div class="concept-defs" style="margin-top:16px;">
                <h4 style="font-size:0.875rem;font-weight:600;margin-bottom:10px;color:var(--muted-foreground);">📖 概念释义</h4>
                <div style="display:grid;gap:8px;">
                    ${definitions.map(d => `
                        <div style="padding:10px 14px;background:var(--secondary);border-radius:8px;font-size:0.8125rem;line-height:1.6;">
                            <strong style="color:var(--foreground);">${escHtml(d.concept)}</strong>
                            <span style="color:var(--muted-foreground);margin-left:4px;">— ${escHtml(d.definition)}</span>
                        </div>
                    `).join('')}
                </div>
            </div>`;
        }

        if (!graphHtml && !defsHtml) {
            renderMarkdown(md, el);
            return;
        }

        el.innerHTML = graphHtml + defsHtml;

        if (useMermaid && window.mermaid) {
            try {
                window.mermaid.run({ nodes: el.querySelectorAll('.mermaid') });
            } catch(e) { console.warn('Mermaid render error:', e); }
        }

        if (!useMermaid && nodes.length >= 2) {
            lucide.createIcons({ nodes: [el] });
            function tryD3(retries) {
                if (typeof d3 !== 'undefined') {
                    doD3Render(graphId, nodes, links, el.querySelector('.concept-graph-container'));
                } else if (retries > 0) {
                    setTimeout(() => tryD3(retries - 1), 300);
                }
            }
            tryD3(10);
        }
    }

    function doD3Render(svgId, nodes, links, container) {
        const svg = d3.select('#' + svgId);
        const svgEl = document.getElementById(svgId);
        const width = svgEl.parentElement.clientWidth || 700;
        const height = Math.max(450, Math.min(650, nodes.length * 40));

        svg.attr('width', width).attr('height', height).attr('viewBox', [0, 0, width, height]);

        // Resolve CSS colors for SVG (CSS custom properties don't work in SVG attrs)
        const cs = getComputedStyle(document.documentElement);
        const borderColor = cs.getPropertyValue('--border').trim() || '#e2e2e2';
        const fgColor = cs.getPropertyValue('--foreground').trim() || '#1a1a1a';
        const mutedFg = cs.getPropertyValue('--muted-foreground').trim() || '#888';
        const palette = ['#6366f1','#8b5cf6','#ec4899','#f59e0b','#10b981','#3b82f6','#ef4444','#14b8a6'];

        // Single container <g> for zoom — all children move together
        const gRoot = svg.append('g').attr('class', 'graph-root');

        // Define arrow markers
        svg.append('defs').selectAll('marker')
            .data(palette).enter().append('marker')
            .attr('id', (d, i) => 'arrow-' + i)
            .attr('viewBox', '0 -5 10 10').attr('refX', 22).attr('refY', 0)
            .attr('markerWidth', 6).attr('markerHeight', 6).attr('orient', 'auto')
            .append('path').attr('d', 'M0,-5L10,0L0,5').attr('fill', (d) => d).attr('opacity', 0.6);

        // Also add a default arrow
        svg.select('defs').append('marker')
            .attr('id', 'arrow-default')
            .attr('viewBox', '0 -5 10 10').attr('refX', 22).attr('refY', 0)
            .attr('markerWidth', 6).attr('markerHeight', 6).attr('orient', 'auto')
            .append('path').attr('d', 'M0,-5L10,0L0,5').attr('fill', mutedFg).attr('opacity', 0.5);

        const linkDistance = Math.max(80, Math.min(160, 600 / Math.sqrt(nodes.length)));

        const simulation = d3.forceSimulation(nodes)
            .force('link', d3.forceLink(links).id(d => d.id).distance(linkDistance))
            .force('charge', d3.forceManyBody().strength(-200))
            .force('center', d3.forceCenter(width / 2, height / 2))
            .force('collision', d3.forceCollide().radius(50))
            .force('x', d3.forceX(width / 2).strength(0.05))
            .force('y', d3.forceY(height / 2).strength(0.05));

        // Links
        const link = gRoot.append('g').attr('class', 'links').selectAll('line')
            .data(links).enter().append('line')
            .attr('stroke', (d) => {
                const srcGroup = (typeof d.source === 'object') ? d.source.group : nodes[d.source].group;
                return palette[srcGroup % palette.length];
            })
            .attr('stroke-width', 1.8)
            .attr('stroke-opacity', 0.4)
            .attr('marker-end', (d) => {
                const srcGroup = (typeof d.source === 'object') ? d.source.group : nodes[d.source].group;
                return 'url(#arrow-' + (srcGroup % palette.length) + ')';
            });

        // Link labels
        const linkLabel = gRoot.append('g').attr('class', 'link-labels').selectAll('text')
            .data(links.filter(l => l.label && l.label !== '包含' && l.label !== '关联')).enter().append('text')
            .text(d => d.label)
            .attr('font-size', '9px').attr('fill', mutedFg)
            .attr('text-anchor', 'middle').attr('opacity', 0.7);

        // Nodes
        const node = gRoot.append('g').attr('class', 'nodes').selectAll('g')
            .data(nodes).enter().append('g')
            .style('cursor', 'grab')
            .call(d3.drag()
                .on('start', (e, d) => { if (!e.active) simulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
                .on('drag', (e, d) => { d.fx = e.x; d.fy = e.y; })
                .on('end', (e, d) => { if (!e.active) simulation.alphaTarget(0); d.fx = null; d.fy = null; })
            );

        node.append('circle')
            .attr('r', 10)
            .attr('fill', d => palette[d.group % palette.length])
            .attr('stroke', '#fff').attr('stroke-width', 2.5)
            .attr('filter', 'drop-shadow(0 1px 2px rgba(0,0,0,0.15))');

        node.append('text')
            .text(d => d.name.length > 16 ? d.name.slice(0, 16) + '…' : d.name)
            .attr('dx', 15).attr('dy', 4)
            .attr('font-size', '12px').attr('fill', fgColor)
            .attr('font-weight', '500');

        // Hover highlight
        node.on('mouseover', function(e, d) {
            d3.select(this).select('circle').transition().duration(200).attr('r', 14);
            link.attr('stroke-opacity', l => (l.source.id === d.id || l.target.id === d.id) ? 0.9 : 0.15)
                .attr('stroke-width', l => (l.source.id === d.id || l.target.id === d.id) ? 2.5 : 1);
        }).on('mouseout', function() {
            d3.select(this).select('circle').transition().duration(200).attr('r', 10);
            link.attr('stroke-opacity', 0.4).attr('stroke-width', 1.8);
        });

        // Constrain nodes within bounds during tick
        simulation.on('tick', () => {
            const pad = 30;
            nodes.forEach(d => {
                d.x = Math.max(pad, Math.min(width - pad, d.x));
                d.y = Math.max(pad, Math.min(height - pad, d.y));
            });

            link.attr('x1', d => d.source.x).attr('y1', d => d.source.y)
                .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
            linkLabel.attr('x', d => (d.source.x + d.target.x) / 2)
                     .attr('y', d => (d.source.y + d.target.y) / 2 - 6);
            node.attr('transform', d => `translate(${d.x},${d.y})`);
        });

        // Zoom — apply transform only to the single root <g>
        const zoom = d3.zoom().scaleExtent([0.3, 3])
            .on('zoom', (e) => { gRoot.attr('transform', e.transform); });
        svg.call(zoom);

        // Toolbar buttons
        container.querySelectorAll('.concept-graph-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const action = btn.getAttribute('data-action');
                if (action === 'zoomIn') svg.transition().call(zoom.scaleBy, 1.3);
                else if (action === 'zoomOut') svg.transition().call(zoom.scaleBy, 0.7);
                else if (action === 'reset') svg.transition().call(zoom.transform, d3.zoomIdentity);
            });
        });
    }

    /* ==================== BREADCRUMB NAVIGATION ==================== */
    function addBreadcrumbNav(data) {
        if (!data.notes || Object.keys(data.notes).length < 2) return;

        const container = cellsDiv();
        const breadcrumb = document.createElement('div');
        breadcrumb.className = 'note-breadcrumb';
        breadcrumb.innerHTML = '<i data-lucide="layers" class="icon-14"></i>';

        Object.entries(data.notes).forEach(([type, info]) => {
            const name = normalizeNoteName(
                (info.type_info && info.type_info.name) || type,
                info.type_info && info.type_info.icon
            );
            const iconName = getNoteIconName(type);
            const chip = document.createElement('button');
            chip.className = 'breadcrumb-chip';
            chip.innerHTML = `<i data-lucide="${iconName}" class="icon-12"></i> ${escHtml(name)}`;
            chip.addEventListener('click', () => {
                const cell = document.getElementById('cell_' + type);
                if (cell) cell.scrollIntoView({ behavior: 'smooth', block: 'start' });
            });
            breadcrumb.appendChild(chip);
        });

        container.insertBefore(breadcrumb, container.firstChild);
        lucide.createIcons({ nodes: [breadcrumb] });
    }

    /* ==================== KaTeX ==================== */
    function renderKaTeX(el) {
        if (window.renderMathInElement) {
            renderMathInElement(el, {
                delimiters: [
                    { left: '$$', right: '$$', display: true },
                    { left: '$',  right: '$',  display: false },
                ],
                throwOnError: false,
            });
        }
    }

    /* ==================== Heti (Chinese Typography) ==================== */
    function hetiEnhance(el) {
        // Add heti class for CSS integration
        if (el.classList.contains('note-content')) {
            el.classList.add('heti');
        }
        // Run autoSpacing for CJK-latin mixed text
        if (window.Heti) {
            try {
                const heti = new Heti(el);
                heti.autoSpacing();
            } catch (e) { /* ignore */ }
        }
    }

    /* ==================== CORNELL NOTE RENDERER ==================== */
    function renderCornell(md, el) {
        if (!md) { el.innerHTML = '<p class="empty-note">暂无内容</p>'; return; }

        // Extract title
        const titleMatch = md.match(/^#\s+.*?[-—]\s*(.+)$/m);
        const title = titleMatch ? titleMatch[1].trim() : '康奈尔笔记';

        // Extract tip line
        const tipMatch = md.match(/^>\s+(.+)$/m);
        const tip = tipMatch ? tipMatch[1].replace(/📌\s*/, '') : '';

        // Split by ## headings
        const sections = [];
        const sectionRegex = /^## (.+)$/gm;
        let match;
        const cuts = [];
        while ((match = sectionRegex.exec(md)) !== null) {
            cuts.push({ title: match[1].trim(), pos: match.index, end: match.index + match[0].length });
        }
        for (let i = 0; i < cuts.length; i++) {
            const bodyEnd = i + 1 < cuts.length ? cuts[i + 1].pos : md.length;
            sections.push({ title: cuts[i].title, body: md.slice(cuts[i].end, bodyEnd).trim() });
        }

        // Detect format: Format B has flat ## 线索栏 / ## 笔记栏 / ## 总结栏
        const isFormatB = sections.some(s => s.title.includes('线索栏') || s.title.includes('笔记栏'));

        // Common data
        let overallSummary = '';
        let reviewItems = [];
        let cueItemsHtml = '';
        let noteItemsHtml = '';

        // Extract review & summary (shared by both formats)
        sections.forEach(sec => {
            if (sec.title.includes('总体总结') || sec.title.includes('📋')) {
                overallSummary = sec.body.replace(/^---$/gm, '').trim();
            } else if (sec.title.includes('复习检查') || sec.title.includes('📝')) {
                reviewItems = sec.body.split('\n')
                    .filter(l => /^-\s*\[[ x]\]/.test(l))
                    .map(l => l.replace(/^-\s*\[[ x]\]\s*/, '').trim());
            }
        });

        if (isFormatB) {
            // === Format B: flat sections ===
            let cueList = [];
            let noteBlocks = [];

            sections.forEach(sec => {
                if (sec.title.includes('总结栏')) {
                    overallSummary = sec.body.replace(/^---$/gm, '').trim();
                } else if (sec.title.includes('线索栏')) {
                    cueList = sec.body.split('\n')
                        .filter(l => /^[-*]\s/.test(l))
                        .map(l => l.replace(/^[-*]\s+/, '').trim());
                } else if (sec.title.includes('笔记栏')) {
                    const subRegex = /^### (.+)$/gm;
                    const subCuts = [];
                    let sm;
                    while ((sm = subRegex.exec(sec.body)) !== null) {
                        subCuts.push({ title: sm[1].trim(), pos: sm.index, end: sm.index + sm[0].length });
                    }
                    for (let j = 0; j < subCuts.length; j++) {
                        const subEnd = j + 1 < subCuts.length ? subCuts[j + 1].pos : sec.body.length;
                        noteBlocks.push({
                            title: subCuts[j].title,
                            body: sec.body.slice(subCuts[j].end, subEnd).trim()
                        });
                    }
                    // Fallback: if no ### sub-headings, treat entire body as one block
                    if (!subCuts.length && sec.body.trim()) {
                        noteBlocks.push({ title: '', body: sec.body.trim() });
                    }
                }
            });

            // Build flat cue list
            cueList.forEach((cue, idx) => {
                cueItemsHtml += `<div class="cornell-cue-item" data-index="${idx}">
                    <span class="cornell-cue-dot"></span>
                    <span>${escHtml(cue)}</span>
                </div>`;
            });

            // Build note blocks with index
            noteBlocks.forEach((nb, idx) => {
                noteItemsHtml += `<div class="cornell-note-block" data-index="${idx}">
                    ${nb.title ? `<div class="cornell-note-topic-header">${escHtml(nb.title)}</div>` : ''}
                    <div class="cornell-note-body">${marked.parse(preprocessObsidianMarkdown(nb.body))}</div>
                </div>`;
            });
        } else {
            // === Format A: chunked with ## 📖 topics ===
            const topicSections = [];
            sections.forEach(sec => {
                if (sec.title.includes('📖') ||
                    (!sec.title.includes('总体总结') && !sec.title.includes('📋') &&
                     !sec.title.includes('复习检查') && !sec.title.includes('📝'))) {
                    const topicName = sec.title.replace(/📖\s*/, '').trim();
                    let cues = [], notes = '', summary = '';

                    const subRegex = /^### (.+)$/gm;
                    const subCuts = [];
                    let sm;
                    while ((sm = subRegex.exec(sec.body)) !== null) {
                        subCuts.push({ title: sm[1].trim(), pos: sm.index, end: sm.index + sm[0].length });
                    }
                    for (let j = 0; j < subCuts.length; j++) {
                        const subEnd = j + 1 < subCuts.length ? subCuts[j + 1].pos : sec.body.length;
                        const subBody = sec.body.slice(subCuts[j].end, subEnd).trim();

                        if (subCuts[j].title.includes('线索')) {
                            cues = subBody.split('\n')
                                .filter(l => /^[-*]\s/.test(l))
                                .map(l => l.replace(/^[-*]\s+/, '').trim());
                        } else if (subCuts[j].title.includes('笔记')) {
                            notes = subBody;
                        } else if (subCuts[j].title.includes('小结')) {
                            summary = subBody;
                        }
                    }
                    if (cues.length || notes) {
                        topicSections.push({ topicName, cues, notes, summary });
                    }
                }
            });

            let globalIdx = 0;
            topicSections.forEach(topic => {
                cueItemsHtml += `<div class="cornell-cue-topic">${escHtml(topic.topicName)}</div>`;
                noteItemsHtml += `<div class="cornell-note-topic-header">${escHtml(topic.topicName)}</div>`;

                topic.cues.forEach(c => {
                    cueItemsHtml += `<div class="cornell-cue-item" data-index="${globalIdx}">
                        <span class="cornell-cue-dot"></span>
                        <span>${escHtml(c)}</span>
                    </div>`;
                    globalIdx++;
                });

                noteItemsHtml += `<div class="cornell-note-block" data-topic="${escHtml(topic.topicName)}">
                    <div class="cornell-note-body">${marked.parse(preprocessObsidianMarkdown(topic.notes))}</div>
                    ${topic.summary ? `<div class="cornell-note-summary"><strong>小结：</strong>${escHtml(topic.summary)}</div>` : ''}
                </div>`;
            });
        }

        const reviewHtml = reviewItems.map(r =>
            `<label class="cornell-review-item">
                <input type="checkbox" class="cornell-review-check" />
                <span>${escHtml(r)}</span>
            </label>`
        ).join('');

        el.innerHTML = `
        <div class="cornell-container" data-format="${isFormatB ? 'B' : 'A'}">
            <div class="cornell-header">
                <h3 class="cornell-title">${escHtml(title)}</h3>
                ${tip ? `<p class="cornell-tip">${escHtml(tip)}</p>` : ''}
            </div>
            <div class="cornell-grid">
                <aside class="cornell-cue-column">
                    <div class="cornell-section-label">
                        <i data-lucide="key-round"></i> 线索栏
                    </div>
                    ${cueItemsHtml}
                </aside>
                <div class="cornell-notes-column">
                    <div class="cornell-section-label">
                        <i data-lucide="pen-line"></i> 笔记栏
                    </div>
                    ${noteItemsHtml}
                </div>
            </div>
            <div class="cornell-summary-bar">
                <div class="cornell-section-label">
                    <i data-lucide="lightbulb"></i> 总结
                </div>
                <div class="cornell-summary-text">${marked.parse(preprocessObsidianMarkdown(overallSummary))}</div>
            </div>
            ${reviewItems.length ? `
            <div class="cornell-review-bar">
                <div class="cornell-section-label">
                    <i data-lucide="check-square"></i> 复习检查
                </div>
                <div class="cornell-review-list">${reviewHtml}</div>
            </div>` : ''}
        </div>`;

        // Bind cue click → highlight note block
        el.querySelectorAll('.cornell-cue-item').forEach(item => {
            item.addEventListener('click', () => {
                el.querySelectorAll('.cornell-active').forEach(a => a.classList.remove('cornell-active'));
                item.classList.add('cornell-active');

                const container = el.querySelector('.cornell-container');
                const format = container ? container.getAttribute('data-format') : 'A';

                if (format === 'B') {
                    // Format B: index-based matching
                    const idx = item.getAttribute('data-index');
                    const noteBlock = el.querySelector(`.cornell-note-block[data-index="${idx}"]`);
                    if (noteBlock) {
                        el.querySelectorAll('.cornell-note-block').forEach(b => b.classList.remove('cornell-active'));
                        noteBlock.classList.add('cornell-active');
                        noteBlock.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                    }
                } else {
                    // Format A: topic-name based matching
                    let topicName = '';
                    let cur = item;
                    while (cur) {
                        if (cur.classList && cur.classList.contains('cornell-cue-topic')) {
                            topicName = cur.textContent;
                            break;
                        }
                        cur = cur.previousElementSibling;
                    }
                    const noteBlock = el.querySelector(`.cornell-note-block[data-topic="${topicName}"]`);
                    if (noteBlock) {
                        el.querySelectorAll('.cornell-note-block').forEach(b => b.classList.remove('cornell-active'));
                        noteBlock.classList.add('cornell-active');
                        noteBlock.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                    }
                }
            });
        });

        lucide.createIcons({ nodes: [el] });
        renderKaTeX(el);
        hetiEnhance(el);
    }

    /* ==================== Q&A NOTE RENDERER ==================== */
    function renderQA(md, el) {
        if (!md) { el.innerHTML = '<p class="empty-note">暂无内容</p>'; return; }

        const titleMatch = md.match(/^#\s+.*?[-—]\s*(.+)$/m);
        const title = titleMatch ? titleMatch[1].trim() : '问答笔记';

        // Extract QA pairs — handle multi-line answers
        const pairs = [];
        const lines = md.split('\n');
        let i = 0;
        while (i < lines.length) {
            const qMatch = lines[i].match(/^\*\*Q(\d+):\s*\[(🟢|🟡|🔴)\s*([\u4e00-\u9fff]+)\]\s*(.+?)\*\*\s*$/);
            if (qMatch) {
                const num = qMatch[1];
                const icon = qMatch[2];
                const level = qMatch[3];
                const question = qMatch[4].trim();
                // Collect answer lines
                i++;
                const answerLines = [];
                while (i < lines.length) {
                    // next Q or heading or --- means end of answer
                    if (/^\*\*Q\d+:/.test(lines[i]) || /^---/.test(lines[i]) || /^## /.test(lines[i])) break;
                    // Strip leading "A: " from first answer line
                    let line = lines[i];
                    if (answerLines.length === 0 && /^A:\s*/.test(line)) {
                        line = line.replace(/^A:\s*/, '');
                    }
                    answerLines.push(line);
                    i++;
                }
                const answer = answerLines.join('\n').trim();
                if (question && answer) {
                    pairs.push({ num, icon, level, question, answer });
                }
            } else {
                i++;
            }
        }

        // Group by level
        const levelMeta = {
            '理解': { css: 'qa-level-green', label: '理解层', desc: '基本概念和事实' },
            '应用': { css: 'qa-level-amber', label: '应用层', desc: '知识的实际应用' },
            '分析': { css: 'qa-level-rose', label: '分析层', desc: '深度理解和批判性思维' },
        };
        const groups = { '理解': [], '应用': [], '分析': [] };
        pairs.forEach(p => {
            if (!groups[p.level]) groups[p.level] = [];
            groups[p.level].push(p);
        });

        // Empty state: no Q&A pairs found
        if (!pairs.length) {
            el.innerHTML = `<div class="qa-container">
                <div class="qa-header">
                    <h3 class="qa-title">${escHtml(title)}</h3>
                </div>
                <div class="empty-note" style="text-align:center;padding:32px 16px;color:var(--muted-foreground)">
                    <i data-lucide="help-circle" style="width:32px;height:32px;margin:0 auto 12px;display:block;opacity:0.4"></i>
                    <p style="margin:0;font-size:0.9rem">暂无问答内容</p>
                    <p style="margin:4px 0 0;font-size:0.78rem;opacity:0.7">该模块未生成有效的问答对</p>
                </div>
            </div>`;
            lucide.createIcons({ nodes: [el] });
            return;
        }

        let html = `<div class="qa-container">
            <div class="qa-header">
                <h3 class="qa-title">${escHtml(title)}</h3>
                <div class="qa-stats">
                    <span class="qa-stat qa-stat-green"><span class="qa-stat-dot"></span>${(groups['理解'] || []).length} 理解</span>
                    <span class="qa-stat qa-stat-amber"><span class="qa-stat-dot"></span>${(groups['应用'] || []).length} 应用</span>
                    <span class="qa-stat qa-stat-rose"><span class="qa-stat-dot"></span>${(groups['分析'] || []).length} 分析</span>
                </div>
            </div>
            <div class="qa-controls">
                <button class="qa-expand-all shad-btn-outline"><i data-lucide="chevrons-down"></i> 展开全部</button>
                <button class="qa-collapse-all shad-btn-outline"><i data-lucide="chevrons-up"></i> 收起全部</button>
            </div>`;

        for (const [level, items] of Object.entries(groups)) {
            if (!items.length) continue;
            const meta = levelMeta[level];
            if (!meta) continue;
            html += `
            <div class="qa-level-group">
                <div class="qa-level-header ${meta.css}">
                    <span class="qa-level-dot"></span>
                    <span class="qa-level-label">${meta.label}</span>
                    <span class="qa-level-desc">${meta.desc}</span>
                    <span class="qa-level-count">${items.length} 题</span>
                </div>
                <div class="qa-cards">`;

            items.forEach(p => {
                html += `
                    <div class="qa-card" data-level="${escHtml(level)}">
                        <button class="qa-card-question" aria-expanded="false">
                            <span class="qa-card-num">Q${escHtml(p.num)}</span>
                            <span class="qa-card-q-text">${escHtml(p.question)}</span>
                            <i data-lucide="chevron-down" class="qa-card-chevron"></i>
                        </button>
                        <div class="qa-card-answer" aria-hidden="true">
                            <div class="qa-card-a-inner">
                                <span class="qa-card-a-label">A</span>
                                <div class="qa-card-a-text">${marked.parse(preprocessObsidianMarkdown(p.answer))}</div>
                            </div>
                        </div>
                    </div>`;
            });

            html += `</div></div>`;
        }

        html += `</div>`;
        el.innerHTML = html;

        // Bind interactions
        el.querySelectorAll('.qa-card-question').forEach(btn => {
            btn.addEventListener('click', () => {
                const card = btn.parentElement;
                const expanded = btn.getAttribute('aria-expanded') === 'true';
                btn.setAttribute('aria-expanded', String(!expanded));
                card.querySelector('.qa-card-answer').setAttribute('aria-hidden', String(expanded));
                card.classList.toggle('qa-card-open', !expanded);
            });
        });

        const expandBtn = el.querySelector('.qa-expand-all');
        const collapseBtn = el.querySelector('.qa-collapse-all');
        if (expandBtn) expandBtn.addEventListener('click', () => {
            el.querySelectorAll('.qa-card').forEach(c => {
                c.classList.add('qa-card-open');
                c.querySelector('.qa-card-question').setAttribute('aria-expanded', 'true');
                c.querySelector('.qa-card-answer').setAttribute('aria-hidden', 'false');
            });
        });
        if (collapseBtn) collapseBtn.addEventListener('click', () => {
            el.querySelectorAll('.qa-card').forEach(c => {
                c.classList.remove('qa-card-open');
                c.querySelector('.qa-card-question').setAttribute('aria-expanded', 'false');
                c.querySelector('.qa-card-answer').setAttribute('aria-hidden', 'true');
            });
        });

        lucide.createIcons({ nodes: [el] });
        renderKaTeX(el);
        hetiEnhance(el);
    }

    /* ==================== FLASHCARD RENDERER ==================== */
    function renderFlashcard(md, el) {
        if (!md) { el.innerHTML = '<p class="empty-note">暂无内容</p>'; return; }

        const titleMatch = md.match(/^#\s+.*?[-—]\s*(.+)$/m);
        const title = titleMatch ? titleMatch[1].trim() : '闪卡';

        // Find content after the first ---
        const hrIdx = md.indexOf('\n---\n');
        const afterHr = hrIdx >= 0 ? md.slice(hrIdx + 5) : md;

        // Split into individual card blocks by double newline
        const rawBlocks = afterHr.split(/\n\n+/).filter(b => b.trim());

        const cards = [];
        rawBlocks.forEach(block => {
            // Split by standalone ? line
            const parts = block.split(/^(\?)$/m);
            if (parts.length >= 3) {
                const question = parts[0].trim();
                const answer = parts.slice(2).join('').trim();
                if (question && answer) {
                    cards.push({ question, answer });
                }
            }
        });

        // If no cards found with ? delimiter, show empty state
        if (!cards.length) {
            el.innerHTML = `<div class="fc-container">
                <div class="fc-header">
                    <h3 class="fc-title">${escHtml(title)}</h3>
                    <span class="fc-count">0 张卡片</span>
                </div>
                <div class="empty-note" style="text-align:center;padding:32px 16px;color:var(--muted-foreground)">
                    <i data-lucide="credit-card" style="width:32px;height:32px;margin:0 auto 12px;display:block;opacity:0.4"></i>
                    <p style="margin:0;font-size:0.9rem">暂无闪卡内容</p>
                    <p style="margin:4px 0 0;font-size:0.78rem;opacity:0.7">该模块未生成有效的闪卡</p>
                </div>
            </div>`;
            lucide.createIcons({ nodes: [el] });
            return;
        }

        const cardHtml = cards.map((c, i) => `
            <div class="fc-card-wrapper">
                <div class="fc-card" data-index="${i}">
                    <div class="fc-card-inner">
                        <div class="fc-card-front">
                            <div class="fc-card-label">Q</div>
                            <div class="fc-card-text">${marked.parse(preprocessObsidianMarkdown(c.question))}</div>
                            <div class="fc-card-hint">
                                <i data-lucide="rotate-cw"></i> 点击翻转
                            </div>
                        </div>
                        <div class="fc-card-back">
                            <div class="fc-card-label">A</div>
                            <div class="fc-card-text">${marked.parse(preprocessObsidianMarkdown(c.answer))}</div>
                            <div class="fc-card-hint">
                                <i data-lucide="rotate-ccw"></i> 点击翻回
                            </div>
                        </div>
                    </div>
                </div>
                <div class="fc-card-index">${i + 1} / ${cards.length}</div>
            </div>
        `).join('');

        el.innerHTML = `
        <div class="fc-container">
            <div class="fc-header">
                <h3 class="fc-title">${escHtml(title)}</h3>
                <span class="fc-count">${cards.length} 张卡片</span>
            </div>
            <div class="fc-grid">
                ${cardHtml}
            </div>
        </div>`;

        // Bind flip interaction
        el.querySelectorAll('.fc-card').forEach(card => {
            card.addEventListener('click', () => {
                card.classList.toggle('fc-flipped');
            });
        });

        lucide.createIcons({ nodes: [el] });
        renderKaTeX(el);
        hetiEnhance(el);
    }

    /* ==================== GLOBAL ACTIONS ==================== */
    window.toggleCell = function (cellId) {
        const body = document.getElementById(cellId + 'Body');
        if (body) body.classList.toggle('collapsed');
    };

    window.switchView = function (type, view) {
        APP.currentViewModes[type] = view;
        const previewEl = document.getElementById('preview_' + type);
        const sourceEl = document.getElementById('source_' + type);
        const tabs = document.getElementById('tabs_' + type);

        if (view === 'source') {
            previewEl.classList.add('hidden');
            sourceEl.classList.remove('hidden');
        } else {
            previewEl.classList.remove('hidden');
            sourceEl.classList.add('hidden');
        }

        tabs.querySelectorAll('.shad-tab').forEach(t => {
            t.classList.toggle('active', t.getAttribute('data-view') === view);
        });
    };

    window.copyNote = function (type) {
        const content = APP.noteCache[type];
        if (!content) return;
        navigator.clipboard.writeText(content)
            .then(() => showToast('已复制到剪贴板', 'success'))
            .catch(() => showToast('复制失败', 'error'));
    };

    window.downloadNote = function (type) {
        if (!APP.taskId) return;
        tauriInvoke('download_note', { taskId: APP.taskId, noteType: type })
            .then(result => {
                if (result && result.content) {
                    const blob = new Blob([result.content], { type: 'text/markdown' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = result.filename || (type + '.md');
                    a.click();
                    URL.revokeObjectURL(url);
                    showToast('下载成功', 'success');
                }
            })
            .catch(err => showToast('下载失败: ' + err, 'error'));
    };

    window.downloadAll = function (taskId) {
        var tid = taskId || APP.taskId;
        if (!tid) return;
        tauriInvoke('download_all', { taskId: tid })
            .then(result => {
                if (result && result.data) {
                    const bytes = Uint8Array.from(atob(result.data), c => c.charCodeAt(0));
                    const blob = new Blob([bytes], { type: 'application/zip' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = result.filename || 'notes.zip';
                    a.click();
                    URL.revokeObjectURL(url);
                    showToast('下载成功', 'success');
                }
            })
            .catch(err => showToast('下载失败: ' + err, 'error'));
    };

    /* ==================== UTIL ==================== */
    function escHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    function scrollToBottom() {
        const nb = document.getElementById('notebook');
        if (nb) setTimeout(() => nb.scrollTo({ top: nb.scrollHeight, behavior: 'smooth' }), SCROLL_DELAY_MS);
    }

    window.showToast = function (msg, type) {
        const existing = document.querySelector('.toast');
        if (existing) existing.remove();
        const el = document.createElement('div');
        el.className = 'toast toast-' + (type || 'success');
        el.textContent = msg;
        document.body.appendChild(el);
        setTimeout(() => el.remove(), 3500);
    };

    /* ==================== HISTORY PAGE ==================== */

    const NOTE_ICON_MAP = {
        'summary': 'file-text', 'mindmap': 'network', 'cornell': 'notebook-tabs',
        'qa': 'circle-help', 'timeline': 'history', 'concept_map': 'git-branch-plus',
        'flashcard': 'rectangle-horizontal', 'anki': 'library-big', 'note': 'notebook-text',
        'fusion': 'sparkles'
    };

    const NOTE_NAME_MAP = {
        'summary': '多级摘要', 'mindmap': '思维导图', 'cornell': '康奈尔笔记',
        'qa': '问答笔记', 'timeline': '时间线', 'concept_map': '概念图',
        'flashcard': 'Obsidian 闪卡', 'anki': 'Anki 卡组', 'note': '综合笔记',
        'fusion': '融合笔记'
    };

    let _historyPage = 1;
    let _historySearch = '';
    let _debounceTimer = null;

    window.loadHistoryPage = function () {
        _historyPage = 1;
        _historySearch = '';
        fetchHistory();

        const searchInput = document.getElementById('historySearch');
        const searchBtn = document.getElementById('searchBtn');
        if (searchInput) {
            searchInput.addEventListener('input', function () {
                clearTimeout(_debounceTimer);
                _debounceTimer = setTimeout(function () {
                    _historySearch = searchInput.value.trim();
                    _historyPage = 1;
                    fetchHistory();
                }, 300);
            });
            searchInput.addEventListener('keydown', function (e) {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    _historySearch = searchInput.value.trim();
                    _historyPage = 1;
                    fetchHistory();
                }
            });
        }
        if (searchBtn) {
            searchBtn.addEventListener('click', function () {
                _historySearch = (document.getElementById('historySearch') || {}).value || '';
                _historyPage = 1;
                fetchHistory();
            });
        }
    };

    function fetchHistory() {
        tauriInvoke('get_history', { page: _historyPage, perPage: 20, search: _historySearch })
            .then(function (data) { renderHistoryList(data); })
            .catch(function (err) {
                console.error('Failed to load history:', err);
                var list = document.getElementById('historyList');
                if (list) list.innerHTML = '<div class="empty-note" style="text-align:center;padding:40px;">加载失败，请刷新重试</div>';
            });
    }

    function renderHistoryList(data) {
        var list = document.getElementById('historyList');
        var countEl = document.getElementById('historyCount');
        var pagination = document.getElementById('historyPagination');
        if (!list) return;

        if (countEl) countEl.textContent = data.total || 0;

        if (!data.items || data.items.length === 0) {
            list.innerHTML = '<div class="empty-note" style="text-align:center;padding:60px 20px;">' +
                '<div style="font-size:2.5rem;margin-bottom:12px;opacity:0.4;">📭</div>' +
                '<div style="color:var(--muted-foreground);">暂无历史记录</div></div>';
            if (pagination) pagination.innerHTML = '';
            return;
        }

        var html = '';
        data.items.forEach(function (item) {
            var statusBadge = '';
            if (item.status === 'completed') {
                statusBadge = '<span class="shad-badge shad-badge-success">完成</span>';
            } else if (item.status === 'processing') {
                statusBadge = '<span class="shad-badge shad-badge-warning">处理中</span>';
            } else if (item.status === 'failed') {
                statusBadge = '<span class="shad-badge shad-badge-destructive">失败</span>';
            } else {
                statusBadge = '<span class="shad-badge shad-badge-secondary">' + item.status + '</span>';
            }

            var typeBadges = '';
            if (item.note_types && item.note_types.length) {
                item.note_types.forEach(function (t) {
                    var icon = NOTE_ICON_MAP[t] || 'file';
                    var name = NOTE_NAME_MAP[t] || t;
                    typeBadges += '<span class="shad-badge shad-badge-secondary"><i data-lucide="' + icon + '" class="note-type-icon"></i>' + name + '</span> ';
                });
            }

            var timeStr = '';
            if (item.created_at) {
                try {
                    var d = new Date(item.created_at);
                    timeStr = d.toLocaleDateString('zh-CN') + ' ' + d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
                } catch (e) {
                    timeStr = item.created_at;
                }
            }

            var noteTypesStr = (item.note_types || []).join(',');
            html += '<div class="history-card" data-task-id="' + item.task_id + '" data-note-types="' + noteTypesStr + '">' +
                '<div class="history-card-main">' +
                    '<div class="history-card-header">' +
                        '<span class="history-card-filename">' + escapeHtml(item.filename) + '</span>' +
                        statusBadge +
                    '</div>' +
                    '<div class="history-card-meta">' +
                        '<span class="history-card-time"><i data-lucide="clock" class="icon-12"></i> ' + timeStr + '</span>' +
                    '</div>' +
                    '<div class="history-card-types">' + typeBadges + '</div>' +
                '</div>' +
                '<div class="history-card-actions">' +
                    (item.status === 'completed' ?
                        '<a class="shad-btn-ghost history-action-btn" href="/src/pages/result.html?id=' + item.task_id + '" title="查看"><i data-lucide="eye" class="icon-16"></i></a>' +
                        '<button class="shad-btn-ghost history-action-btn" onclick="downloadAll(\'' + item.task_id + '\')" title="下载"><i data-lucide="download" class="icon-16"></i></button>'
                        : '') +
                    '<button class="shad-btn-ghost history-action-btn history-delete-btn" data-task-id="' + item.task_id + '" title="删除"><i data-lucide="trash-2" class="icon-16"></i></button>' +
                '</div>' +
            '</div>';
        });

        list.innerHTML = html;

        list.querySelectorAll('.history-delete-btn').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var tid = btn.getAttribute('data-task-id');
                if (confirm('确定删除该历史记录？')) {
                    tauriInvoke('delete_history', { taskId: tid })
                        .then(function () { fetchHistory(); });
                }
            });
        });

        try { lucide.createIcons({ nodes: [list] }); } catch (e) {}

        // 应用当前筛选状态
        applyHistoryTypeFilter();

        if (pagination) {
            renderPagination(pagination, data.page, data.pages);
        }
    }

    function renderPagination(container, page, pages) {
        if (pages <= 1) { container.innerHTML = ''; return; }

        var html = '';
        html += '<button class="shad-btn-ghost pagination-btn" data-page="' + (page - 1) + '"' +
                (page <= 1 ? ' disabled' : '') + '><i data-lucide="chevron-left" class="icon-14"></i></button>';

        var start = Math.max(1, page - 2);
        var end = Math.min(pages, page + 2);
        for (var i = start; i <= end; i++) {
            html += '<button class="' + (i === page ? 'shad-btn-secondary' : 'shad-btn-ghost') + ' pagination-btn" data-page="' + i + '">' + i + '</button>';
        }

        html += '<span style="color:var(--muted-foreground);font-size:0.8rem;align-self:center;">/ ' + pages + '</span>';
        html += '<button class="shad-btn-ghost pagination-btn" data-page="' + (page + 1) + '"' +
                (page >= pages ? ' disabled' : '') + '><i data-lucide="chevron-right" class="icon-14"></i></button>';

        container.innerHTML = html;

        container.querySelectorAll('.pagination-btn').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var p = parseInt(btn.getAttribute('data-page'));
                if (p >= 1 && p <= pages) {
                    _historyPage = p;
                    fetchHistory();
                }
            });
        });

        try { lucide.createIcons({ nodes: [container] }); } catch (e) {}
    }

    function escapeHtml(str) {
        var div = document.createElement('div');
        div.textContent = str || '';
        return div.innerHTML;
    }

    /* ==================== MERMAID INIT ==================== */
    if (typeof mermaid !== 'undefined') {
        const isDarkTheme = ['dark', 'vibrant', 'ocean'].includes(document.documentElement.getAttribute('data-theme'));
        mermaid.initialize({
            startOnLoad: false,
            theme: 'base',
            securityLevel: 'loose',
            fontFamily: 'system-ui, -apple-system, sans-serif',
            fontSize: 13,
            themeVariables: isDarkTheme ? {
                // Dark — mindmap-aligned palette
                primaryColor: '#2d2a4a',
                primaryTextColor: '#e9ddd5',
                primaryBorderColor: 'rgba(139,92,246,0.35)',
                secondaryColor: '#1e2a3a',
                secondaryTextColor: '#cbd5e1',
                secondaryBorderColor: 'rgba(99,102,241,0.25)',
                tertiaryColor: '#2a2226',
                tertiaryTextColor: '#94a3b8',
                tertiaryBorderColor: 'rgba(255,255,255,0.08)',
                lineColor: 'rgba(139,92,246,0.45)',
                textColor: '#e9ddd5',
                mainBkg: '#2d2a4a',
                nodeBorder: 'rgba(139,92,246,0.35)',
                clusterBkg: '#1a1625',
                clusterBorder: 'rgba(139,92,246,0.15)',
                titleColor: '#e9ddd5',
                edgeLabelBackground: '#1e1b2e',
                nodeTextColor: '#e9ddd5',
            } : {
                // Light — mindmap-aligned palette
                primaryColor: '#f0ecff',
                primaryTextColor: '#1e1b4b',
                primaryBorderColor: 'rgba(139,92,246,0.25)',
                secondaryColor: '#faf5ff',
                secondaryTextColor: '#1e1b4b',
                secondaryBorderColor: 'rgba(99,102,241,0.2)',
                tertiaryColor: '#ffffff',
                tertiaryTextColor: '#6b21a8',
                tertiaryBorderColor: 'rgba(0,0,0,0.06)',
                lineColor: 'rgba(139,92,246,0.4)',
                textColor: '#1e1b4b',
                mainBkg: '#f0ecff',
                nodeBorder: 'rgba(139,92,246,0.25)',
                clusterBkg: '#faf5ff',
                clusterBorder: 'rgba(139,92,246,0.12)',
                titleColor: '#1e1b4b',
                edgeLabelBackground: '#ffffff',
                nodeTextColor: '#1e1b4b',
            },
            flowchart: {
                nodeSpacing: 35,
                rankSpacing: 55,
                curve: 'basis',
                padding: 12,
                useMaxWidth: false,
                htmlLabels: true,
                wrappingWidth: 180
            }
        });
    }

})();
