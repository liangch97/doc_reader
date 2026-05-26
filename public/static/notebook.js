/**
 * Notebook Manager — 笔记本管理系统
 * 支持: 多笔记本管理、笔记预览、PPT导入、文本标注
 */
(function () {
    'use strict';

    // ── Tauri 封装 ───────────────────────────────────────────────────────────
    function invoke(cmd, args) {
        if (window.__TAURI__ && window.__TAURI__.core)
            return window.__TAURI__.core.invoke(cmd, args || {});
        if (window.__TAURI_INTERNALS__)
            return window.__TAURI_INTERNALS__.invoke(cmd, args || {});
        return Promise.reject(new Error('Tauri not available'));
    }

    function listen(event, cb) {
        if (window.__TAURI__ && window.__TAURI__.event)
            return window.__TAURI__.event.listen(event, function (e) { cb(e.payload); });
        if (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.listen)
            return window.__TAURI_INTERNALS__.listen(event, function (e) { cb(e.payload); });
        return Promise.resolve(function () {});
    }

    // Round 5: lazy alias to global UI-busy helper exposed by doc_reader.js
    function UIBusy() {
        return window.UIBusy || { push: function () {}, pop: function () {}, toast: function (m) { console.log(m); } };
    }

    // ── State ────────────────────────────────────────────────────────────────
    var nbState = {
        notebooks: [],           // [ { notebook_id, name, description, color, entry_count, ... } ]
        activeNotebookId: null,  // 当前选中的笔记本ID
        entries: [],             // 当前笔记本的条目列表
        outline: null,           // Round 2: 来自 notebook_get_outline 的分组结构（来源分组，仍在用作兜底）
        learningOutline: null,   // Round 6: 学习路径大纲 { outline:{thesis, zones, entry_order, links, ...}, entries_by_zone, outline_ready }
        relatedCache: {},        // Round 6: entry_id -> { outgoing, incoming, prev_sibling, next_sibling }
        activeSectionId: null,   // Round 2: 大纲/预览反向高亮的当前 section
        previewEntryId: null,    // 当前预览的条目ID
        editingNotebookId: null, // 正在编辑的笔记本ID (null = 新建)
        pptFiles: [],            // PPT导入时选择的文件列表
        annotating: false,       // 是否正在进行文本标注
        buildingOutline: false,  // Round 6: 正在后台重构学习路径
    };

    // ── DOM refs ─────────────────────────────────────────────────────────────
    var $notebookSelect, $nbEntriesList, $nbPreviewPanel, $nbPreviewTitle, $nbPreviewBody;
    var $nbActionBar;
    // Round 2 picker
    var $nbPicker, $nbPickerBtn, $nbPickerColor, $nbPickerName, $nbPickerMeta;
    var $nbPickerMenu, $nbPickerSearch, $nbPickerList, $nbPickerCreate;
    var $nbFloatDock, $nbFloatMainBtn, $nbFloatGenerateBtn, $nbFloatExitBtn, $nbFloatRelayoutBtn, $nbFloatGen10Btn;

    // ── Init ─────────────────────────────────────────────────────────────────
    function init() {
        cacheDom();
        bindTabEvents();
        bindPicker();
        bindNotebookEvents();
        bindModalEvents();
        bindPptEvents();
        bindAnnotateEvents();
        bindNbPdfPageNoteBtn();
        bindPageRangeEvents();
        bindTextSelectEvents();
        bindRelayoutButton();
        bindRailToggle();
        bindFloatingDock();
        setupListeners();
        loadNotebooks();
        // Main pane default: guide the user to select a notebook instead of showing a loading placeholder.
        renderPreviewEmptyState();
        if (window.lucide) window.lucide.createIcons();
    }

    function cacheDom() {
        $notebookSelect = document.getElementById('notebookSelect');
        $nbEntriesList = document.getElementById('nbEntriesList');
        $nbPreviewPanel = document.getElementById('nbPreviewPanel');
        $nbPreviewTitle = document.getElementById('nbPreviewTitle');
        $nbPreviewBody = document.getElementById('nbPreviewBody');
        $nbActionBar = document.getElementById('nbActionBar');
        $nbPicker = document.getElementById('nbFloatingPicker') || document.getElementById('nbPicker');
        $nbPickerBtn = document.getElementById('nbPickerBtn');
        $nbPickerColor = document.getElementById('nbPickerColor');
        $nbPickerName = document.getElementById('nbPickerName');
        $nbPickerMeta = document.getElementById('nbPickerMeta');
        $nbPickerMenu = document.getElementById('nbFloatingPickerMenu') || document.getElementById('nbPickerMenu');
        $nbPickerSearch = document.getElementById('nbFloatingPickerSearch') || document.getElementById('nbPickerSearch');
        $nbPickerList = document.getElementById('nbFloatingPickerList') || document.getElementById('nbPickerList');
        $nbPickerCreate = document.getElementById('nbFloatingPickerCreate') || document.getElementById('nbPickerCreate');
        $nbFloatDock = document.getElementById('nbFloatDock');
        $nbFloatMainBtn = document.getElementById('nbFloatMainBtn');
        $nbFloatGenerateBtn = document.getElementById('nbFloatGenerateBtn');
        $nbFloatGen10Btn = document.getElementById('nbFloatGen10Btn');
        $nbFloatExitBtn = document.getElementById('nbFloatExitBtn');
        $nbFloatRelayoutBtn = document.getElementById('nbFloatRelayoutBtn');
    }

    // ── Round 2: tab-bar removed; legacy bindTabEvents becomes no-op ─────────
    function bindTabEvents() { /* Round 2: AI Notes tab DOM has been deleted; no tabs to bind */ }

    // ── Round 2: custom notebook picker ──────────────────────────────────────
    function bindPicker() {
        if (!$nbPicker) return;
        if ($nbPickerBtn) {
            $nbPickerBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                if ($nbPicker.classList.contains('open')) closeNotebookPicker();
                else openNotebookPicker($nbPickerBtn);
            });
        }
        document.addEventListener('click', function (e) {
            if (!$nbPicker.classList.contains('open')) return;
            if ($nbPicker.contains(e.target)) return;
            closeNotebookPicker();
        });
        if ($nbPickerSearch) {
            $nbPickerSearch.addEventListener('input', function () { renderPickerList($nbPickerSearch.value || ''); });
            $nbPickerSearch.addEventListener('keydown', function (e) {
                if (e.key === 'Escape') closeNotebookPicker();
            });
        }
        if ($nbPickerCreate) {
            $nbPickerCreate.addEventListener('click', function () {
                closeNotebookPicker();
                nbState.editingNotebookId = null;
                openNotebookModal('新建笔记本', '', '', '#7C5CFC');
            });
        }
    }

    function positionNotebookPicker(anchorEl) {
        if (!$nbPicker) return;
        var panelNotes = document.getElementById('panelNotes');
        if (!panelNotes) return;
        var panelRect = panelNotes.getBoundingClientRect();
        var anchorRect = anchorEl && anchorEl.getBoundingClientRect ? anchorEl.getBoundingClientRect() : null;
        var width = Math.min(320, Math.max(250, panelRect.width - 32));
        $nbPicker.style.width = width + 'px';
        if (!anchorRect) {
            $nbPicker.style.left = '16px';
            $nbPicker.style.right = 'auto';
            $nbPicker.style.bottom = '66px';
            return;
        }
        var left = Math.max(16, Math.round(anchorRect.left - panelRect.left));
        var bottom = Math.max(66, Math.round(panelRect.bottom - anchorRect.top + 10));
        $nbPicker.style.left = left + 'px';
        $nbPicker.style.right = 'auto';
        $nbPicker.style.bottom = bottom + 'px';
    }

    function openNotebookPicker(anchorEl) {
        if ($nbPicker) {
            positionNotebookPicker(anchorEl || $nbFloatMainBtn);
            setFloatingDockOpen(true);
            $nbPicker.classList.add('open');
            renderPickerList('');
            if ($nbPickerSearch) {
                $nbPickerSearch.value = '';
                setTimeout(function () { $nbPickerSearch.focus(); }, 30);
            }
            return;
        }
        if (nbState.activeNotebookId) exitActiveNotebook();
        else renderPreviewEmptyState();
    }

    function closeNotebookPicker() {
        if ($nbPicker) $nbPicker.classList.remove('open');
    }

    function setFloatingDockOpen(open) {
        if ($nbFloatDock) $nbFloatDock.classList.toggle('open', !!open);
    }

    // ── Round 8: 串行生成后续 N 页（每页生成完立即追加到笔记本） ───────────
    var _serialRunning = false;
    function triggerSerialNextPages(count) {
        if (_serialRunning) {
            if (window.UIBusy && window.UIBusy.toast) window.UIBusy.toast('已有串行生成任务进行中', 1800);
            return;
        }
        var drState = window.DocReader && window.DocReader.getState ? window.DocReader.getState() : null;
        if (!drState || !drState.sessionId) {
            if (window.UIBusy && window.UIBusy.toast) window.UIBusy.toast('请先打开一个文档', 1800, true);
            return;
        }
        var nbId = nbState.activeNotebookId;
        if (!nbId) {
            try {
                if (window.NotebookManager && typeof window.NotebookManager.openPicker === 'function') {
                    window.NotebookManager.openPicker();
                }
            } catch (_) { }
            if (window.UIBusy && window.UIBusy.toast) window.UIBusy.toast('请先选择一个笔记本', 1800, false);
            return;
        }
        var startPage = (drState.currentPage || 0) + 1; // 从下一页开始
        var totalPages = drState.pageCount || 0;
        if (startPage >= totalPages) {
            if (window.UIBusy && window.UIBusy.toast) window.UIBusy.toast('已是最后一页', 1800);
            return;
        }
        var actualCount = Math.min(count, totalPages - startPage);

        _serialRunning = true;
        if ($nbFloatGen10Btn) {
            $nbFloatGen10Btn.classList.add('running');
            $nbFloatGen10Btn.disabled = true;
            var badge = $nbFloatGen10Btn.querySelector('.nb-float-gen10-badge');
            if (badge) badge.textContent = '0';
        }
        if (window.UIBusy && window.UIBusy.push) {
            window.UIBusy.push('开始串行生成 ' + actualCount + ' 页（从第 ' + (startPage + 1) + ' 页起）');
        }
        invoke('notebook_generate_serial_next_pages', {
            notebookId: nbId,
            sessionId: drState.sessionId,
            startPage: startPage,
            count: actualCount,
        }).catch(function (err) {
            console.error('串行生成调度失败:', err);
            _serialRunning = false;
            if ($nbFloatGen10Btn) {
                $nbFloatGen10Btn.classList.remove('running');
                $nbFloatGen10Btn.disabled = false;
                var b = $nbFloatGen10Btn.querySelector('.nb-float-gen10-badge');
                if (b) b.textContent = '10';
            }
            if (window.UIBusy && window.UIBusy.toast) window.UIBusy.toast('串行生成失败: ' + String(err).slice(0, 80), 3000, true);
            if (window.UIBusy && window.UIBusy.pop) window.UIBusy.pop();
        });
    }

    function bindFloatingDock() {
        if (!$nbFloatDock || !$nbFloatMainBtn) return;
        $nbFloatMainBtn.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            var nextOpen = !$nbFloatDock.classList.contains('open');
            setFloatingDockOpen(nextOpen);
            if (!nextOpen) closeNotebookPicker();
        });
        if ($nbFloatGenerateBtn) {
            $nbFloatGenerateBtn.addEventListener('click', function (e) {
                var quickBtn = document.getElementById('quickGenCurrentBtn');
                if (!quickBtn) return;
                e.preventDefault();
                e.stopPropagation();
                // 直接触发主操作；ensureNotebook 会在缺笔记本时弹出选择器
                quickBtn.click();
            });
        }
        if ($nbFloatGen10Btn) {
            $nbFloatGen10Btn.addEventListener('click', function (e) {
                e.preventDefault();
                e.stopPropagation();
                if ($nbFloatGen10Btn.disabled) return;
                triggerSerialNextPages(10);
            });
        }
        if ($nbFloatExitBtn) {
            $nbFloatExitBtn.addEventListener('click', function (e) {
                e.preventDefault();
                e.stopPropagation();
                exitActiveNotebook();
                setFloatingDockOpen(false);
            });
        }
        if ($nbFloatRelayoutBtn) {
            $nbFloatRelayoutBtn.addEventListener('click', function (e) {
                var relayoutBtn = document.getElementById('nbRelayoutBtn');
                if (!relayoutBtn || relayoutBtn.disabled) return;
                e.preventDefault();
                e.stopPropagation();
                relayoutBtn.click();
                setFloatingDockOpen(false);
            });
        }
        var $nbFloatToolbarBtn = document.getElementById('nbFloatToolbarBtn');
        if ($nbFloatToolbarBtn) {
            $nbFloatToolbarBtn.addEventListener('click', function (e) {
                e.preventDefault();
                e.stopPropagation();
                if (window._setToolbarCollapsed && window._isToolbarCollapsed) {
                    window._setToolbarCollapsed(!window._isToolbarCollapsed());
                }
                setFloatingDockOpen(false);
            });
        }
        document.addEventListener('click', function (e) {
            if ($nbFloatDock.contains(e.target)) return;
            if ($nbPicker && $nbPicker.contains(e.target)) return;
            setFloatingDockOpen(false);
        });
        window.addEventListener('resize', function () {
            if ($nbPicker && $nbPicker.classList.contains('open')) {
                positionNotebookPicker($nbFloatMainBtn);
            }
        });
    }

    function renderPickerList(query) {
        if (!$nbPickerList) return;
        var q = (query || '').trim().toLowerCase();
        var list = nbState.notebooks.filter(function (n) {
            if (!q) return true;
            return (n.name || '').toLowerCase().indexOf(q) !== -1
                || (n.description || '').toLowerCase().indexOf(q) !== -1;
        });
        if (!list.length) {
            $nbPickerList.innerHTML = '<div class="nb-picker-empty">' + (q ? '没有匹配的笔记本' : '尚未创建任何笔记本') + '</div>';
            return;
        }
        var html = list.map(function (n) {
            var active = n.notebook_id === nbState.activeNotebookId ? ' active' : '';
            var color = (n.color || '#7C5CFC').replace(/"/g, '');
            var count = (typeof n.entry_count === 'number') ? (n.entry_count + ' 条') : '';
            var updated = n.updated_at ? formatPickerTime(n.updated_at) : '';
            var meta = [count, updated].filter(Boolean).join(' · ');
            return '<div class="nb-picker-item' + active + '" data-id="' + n.notebook_id + '">' +
                '<span class="nb-color" style="background:' + color + ';"></span>' +
                '<div class="nb-info">' +
                    '<div class="nb-info-name">' + escapeHtml(n.name || '未命名') + '</div>' +
                    (meta ? '<div class="nb-info-meta">' + meta + '</div>' : '') +
                '</div>' +
                '<div class="nb-item-actions">' +
                    '<button data-act="edit" data-id="' + n.notebook_id + '" title="编辑"><i data-lucide="settings" style="width:12px;height:12px"></i></button>' +
                    '<button data-act="delete" data-id="' + n.notebook_id + '" title="删除"><i data-lucide="trash-2" style="width:12px;height:12px"></i></button>' +
                '</div>' +
            '</div>';
        }).join('');
        $nbPickerList.innerHTML = html;
        if (window.lucide) window.lucide.createIcons();
        // Wire item clicks
        $nbPickerList.querySelectorAll('.nb-picker-item').forEach(function (el) {
            el.addEventListener('click', function (ev) {
                var actBtn = ev.target.closest('button[data-act]');
                if (actBtn) {
                    ev.stopPropagation();
                    var id = actBtn.getAttribute('data-id');
                    var nb = nbState.notebooks.find(function (n) { return n.notebook_id === id; });
                    if (!nb) return;
                    if (actBtn.getAttribute('data-act') === 'edit') {
                        $nbPicker.classList.remove('open');
                        nbState.editingNotebookId = id;
                        openNotebookModal('编辑笔记本', nb.name, nb.description || '', nb.color || '#7C5CFC');
                    } else {
                        if (!confirm('确定删除笔记本「' + nb.name + '」及其所有内容？此操作不可撤销。')) return;
                        invoke('notebook_delete', { notebookId: id }).then(function () {
                            if (nbState.activeNotebookId === id) {
                                nbState.activeNotebookId = null;
                                hidePreview();
                            }
                            loadNotebooks();
                        }).catch(function (err) { console.error('删除笔记本失败:', err); });
                    }
                    return;
                }
                var pickedId = el.getAttribute('data-id');
                if (!pickedId) return;
                $nbPicker.classList.remove('open');
                pickActiveNotebook(pickedId);
            });
        });
    }

    function pickActiveNotebook(id) {
        nbState.activeNotebookId = id;
        if ($notebookSelect) {
            // Keep hidden legacy select in sync (no change event needed; we drive state directly)
            try { $notebookSelect.value = id; } catch (_) {}
        }
        closeNotebookPicker();
        setFloatingDockOpen(false);
        loadNotebookEntries(id);
        loadOutline(id);
        enableNotebookActions(true);
        renderPickerHead();
    }

    function renderPickerHead() {
        var nb = nbState.notebooks.find(function (n) { return n.notebook_id === nbState.activeNotebookId; });
        if ($nbFloatGenerateBtn) {
            $nbFloatGenerateBtn.title = nb ? ('生成当前页笔记 · ' + (nb.name || '当前笔记本')) : '先选择笔记本，再生成当前页笔记';
        }
        if ($nbFloatMainBtn) {
            $nbFloatMainBtn.title = nb ? ((nb.name || '笔记本') + ' · 文档区快捷操作') : '文档区快捷操作';
        }
        if ($nbFloatDock) {
            var drState = window.DocReader && window.DocReader.getState ? window.DocReader.getState() : null;
            $nbFloatDock.style.display = (drState && drState.sessionId) ? 'flex' : 'none';
        }
        if (!$nbPickerName) return;
        if (!nb) {
            $nbPickerName.textContent = '选择笔记本';
            if ($nbPickerColor) $nbPickerColor.style.background = 'var(--muted)';
            if ($nbPickerMeta) $nbPickerMeta.textContent = nbState.notebooks.length ? '开始记录' : '新建一个';
            return;
        }
        $nbPickerName.textContent = nb.name || '未命名';
        if ($nbPickerColor) $nbPickerColor.style.background = nb.color || '#7C5CFC';
        if ($nbPickerMeta) $nbPickerMeta.textContent = (typeof nb.entry_count === 'number' ? (nb.entry_count + ' 条') : '');
    }

    function updatePreviewShell() {
        var closeBtn = document.getElementById('nbPreviewCloseBtn');
        if (!closeBtn) return;
        if (!nbState.activeNotebookId) {
            closeBtn.style.display = 'none';
            return;
        }
        closeBtn.style.display = 'inline-flex';
        closeBtn.title = '退出当前笔记本';
        closeBtn.innerHTML = '<i data-lucide="chevrons-left" style="width:12px;height:12px"></i>';
        if (window.lucide) { try { window.lucide.createIcons(); } catch (_) { } }
    }

    function exitActiveNotebook() {
        if (!nbState.activeNotebookId) {
            renderPreviewEmptyState();
            return;
        }
        nbState.activeNotebookId = null;
        nbState.entries = [];
        nbState.outline = null;
        nbState.activeSectionId = null;
        nbState.previewEntryId = null;
        if ($notebookSelect) {
            try { $notebookSelect.value = ''; } catch (_) { }
        }
        closeNotebookPicker();
        setFloatingDockOpen(false);
        setRailCollapsed(true, false);
        enableNotebookActions(false);
        renderPickerHead();
        renderEntries();
        renderPreviewEmptyState();
        updateRelayoutButtonState();
    }

    function formatPickerTime(s) {
        try {
            var d = new Date(s);
            var now = new Date();
            var diff = (now - d) / 1000;
            if (diff < 60) return '刚刚';
            if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
            if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
            if (diff < 86400 * 7) return Math.floor(diff / 86400) + ' 天前';
            return d.toLocaleDateString('zh-CN');
        } catch (e) { return ''; }
    }

    function escapeHtml(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    // Round 3: strip legacy emoji/page-number prefixes + "· 自动笔记"/"· 追加讲解"/"来源：..." so
    // old data renders cleanly until the user hits "一键排版知识区". Does NOT touch stored DB value.
    var BAD_TITLE_EMOJI_RE = /^[\u{1F300}-\u{1FAFF}\u{1F900}-\u{1F9FF}\u{2600}-\u{27BF}\u{1F000}-\u{1F02F}\u{1F4A0}-\u{1F4FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}]+\s*/u;
    function cleanTitle(raw) {
        if (!raw) return '无标题';
        var s = String(raw).trim();
        // strip leading emoji(s)
        for (var i = 0; i < 3; i++) { var n = s.replace(BAD_TITLE_EMOJI_RE, ''); if (n === s) break; s = n.trim(); }
        // drop trailing "· 自动笔记" / "· 追加讲解" / "· 问答补充"
        s = s.replace(/[·•・]\s*(自动笔记|追加讲解|问答补充|Auto\s*Note)\s*$/i, '').trim();
        // drop trailing "来源：xxx"
        s = s.replace(/[，,。.]?\s*来源[：:].*$/, '').trim();
        // Collapse "第 N 页 笔记" / "第N页笔记" when it's the full title → keep as-is (will be relaid out later),
        // but strip redundant "· 自动笔记" already done.
        if (!s) return '无标题';
        return s;
    }

    // Round 3: classify whether a title looks auto-generated — used to gate the relayout button hint.
    function titleLooksAuto(raw) {
        if (!raw) return true;
        var s = String(raw).trim();
        if (BAD_TITLE_EMOJI_RE.test(s)) return true;
        if (/^第\s*\d+/.test(s)) return true;
        if (/自动笔记|追加讲解/.test(s)) return true;
        return false;
    }

    // ── Notebook CRUD events (Round 2: hidden legacy <select>/buttons; picker drives state) ──
    function bindNotebookEvents() {
        // Hidden legacy select retained for backwards compat; null-safe
        if ($notebookSelect) {
            $notebookSelect.addEventListener('change', function () {
                var id = $notebookSelect.value;
                if (id && id !== nbState.activeNotebookId) pickActiveNotebook(id);
            });
        }

        // Create notebook (legacy hidden button)
        var _btnC = document.getElementById('nbCreateBtn');
        if (_btnC) _btnC.addEventListener('click', function () {
            nbState.editingNotebookId = null;
            openNotebookModal('新建笔记本', '', '', '#7C5CFC');
        });

        // Edit notebook
        var _btnE = document.getElementById('nbEditBtn');
        if (_btnE) _btnE.addEventListener('click', function () {
            if (!nbState.activeNotebookId) return;
            var nb = nbState.notebooks.find(function (n) { return n.notebook_id === nbState.activeNotebookId; });
            if (!nb) return;
            nbState.editingNotebookId = nbState.activeNotebookId;
            openNotebookModal('编辑笔记本', nb.name, nb.description || '', nb.color || '#7C5CFC');
        });

        // Delete notebook
        var _btnD = document.getElementById('nbDeleteBtn');
        if (_btnD) _btnD.addEventListener('click', function () {
            if (!nbState.activeNotebookId) return;
            var nb = nbState.notebooks.find(function (n) { return n.notebook_id === nbState.activeNotebookId; });
            if (!nb) return;
            if (!confirm('确定删除笔记本「' + nb.name + '」及其所有内容？此操作不可撤销。')) return;
            invoke('notebook_delete', { notebookId: nbState.activeNotebookId })
                .then(function () {
                    nbState.activeNotebookId = null;
                    hidePreview();
                    loadNotebooks();
                })
                .catch(function (err) { console.error('删除笔记本失败:', err); });
        });

        // Add manual note
        var _btnA = document.getElementById('nbAddNoteBtn');
        if (_btnA) _btnA.addEventListener('click', function () {
            if (!nbState.activeNotebookId) return;
            var content = prompt('输入笔记内容:');
            if (!content) return;
            var title = content.substring(0, 30).trim();
            invoke('notebook_add_entry', {
                notebookId: nbState.activeNotebookId,
                title: title,
                content: content,
                entryType: 'note',
                sourceInfo: '手动添加',
            }).then(function () {
                loadNotebookEntries(nbState.activeNotebookId);
            }).catch(function (err) { console.error('添加笔记失败:', err); });
        });

        // Add current AI note to notebook
        var addToNbBtn = document.getElementById('addToNotebookBtn');
        if (addToNbBtn) {
            addToNbBtn.addEventListener('click', function () {
                addCurrentNoteToNotebook();
            });
        }

        // Preview close
        var _btnPC = document.getElementById('nbPreviewCloseBtn');
        if (_btnPC) _btnPC.addEventListener('click', exitActiveNotebook);

        // Preview zoom
        var _nbPreviewZoom = 100;
        var nbZoomIn = document.getElementById('nbPreviewZoomIn');
        var nbZoomOut = document.getElementById('nbPreviewZoomOut');
        var nbZoomLevel = document.getElementById('nbPreviewZoomLevel');
        function applyNbPreviewZoom() {
            if (nbZoomLevel) nbZoomLevel.textContent = _nbPreviewZoom + '%';
            if ($nbPreviewBody) $nbPreviewBody.style.zoom = _nbPreviewZoom / 100;
        }
        if (nbZoomIn) nbZoomIn.addEventListener('click', function () {
            _nbPreviewZoom = Math.min(200, _nbPreviewZoom + 10);
            applyNbPreviewZoom();
        });
        if (nbZoomOut) nbZoomOut.addEventListener('click', function () {
            _nbPreviewZoom = Math.max(50, _nbPreviewZoom - 10);
            applyNbPreviewZoom();
        });

        // Preview outline toggle (moved from floating dock)
        var _btnPO = document.getElementById('nbPreviewOutlineBtn');
        if (_btnPO) _btnPO.addEventListener('click', function () {
            var rail = document.getElementById('nbSideRail');
            if (!rail) return;
            setRailCollapsed(!rail.classList.contains('collapsed'));
        });
    }

    function enableNotebookActions(enabled) {
        var _eB = document.getElementById('nbEditBtn'); if (_eB) _eB.disabled = !enabled;
        var _dB = document.getElementById('nbDeleteBtn'); if (_dB) _dB.disabled = !enabled;
        if ($nbActionBar) $nbActionBar.style.display = enabled ? 'flex' : 'none';

        // Enable add-to-notebook button if there's an active notebook
        var addBtn = document.getElementById('addToNotebookBtn');
        if (addBtn) addBtn.disabled = !enabled;

        // Enable page-range and text-select buttons if session exists
        var drState = window.DocReader && window.DocReader.getState ? window.DocReader.getState() : null;
        var hasSession = drState && drState.sessionId;
        var prBtn = document.getElementById('pageRangeBtn');
        var tsBtn = document.getElementById('textSelectBtn');
        if (prBtn) prBtn.disabled = !hasSession;
        if (tsBtn) tsBtn.disabled = !hasSession;

        // Keep quick-gen buttons visibly available once a document is open.
        var qgC = document.getElementById('quickGenCurrentBtn');
        var qgR = document.getElementById('quickGenRangeBtn');
        var sessionOn = !!hasSession;
        if (qgC) {
            qgC.disabled = !sessionOn;
            qgC.classList.toggle('needs-notebook', !!(sessionOn && !enabled));
        }
        if (qgR) qgR.disabled = !sessionOn;
        if ($nbFloatGenerateBtn) $nbFloatGenerateBtn.disabled = !sessionOn;
        if ($nbFloatGen10Btn) $nbFloatGen10Btn.disabled = !sessionOn;
        if ($nbFloatExitBtn) $nbFloatExitBtn.disabled = !enabled;
        if ($nbFloatRelayoutBtn) $nbFloatRelayoutBtn.disabled = !(!!enabled && nbState.entries && nbState.entries.length);
    }

    // ── Notebook Modal ───────────────────────────────────────────────────────
    function bindModalEvents() {
        var modal = document.getElementById('nbModal');
        var closeBtn = document.getElementById('nbModalClose');
        var cancelBtn = document.getElementById('nbModalCancel');
        var saveBtn = document.getElementById('nbModalSave');

        closeBtn.addEventListener('click', function () { modal.style.display = 'none'; });
        cancelBtn.addEventListener('click', function () { modal.style.display = 'none'; });

        // Color picker
        document.querySelectorAll('#nbColorPicker .nb-color-dot').forEach(function (dot) {
            dot.addEventListener('click', function () {
                document.querySelectorAll('#nbColorPicker .nb-color-dot').forEach(function (d) { d.classList.remove('active'); });
                dot.classList.add('active');
            });
        });

        // Save
        saveBtn.addEventListener('click', function () {
            var name = document.getElementById('nbNameInput').value.trim();
            if (!name) { document.getElementById('nbNameInput').focus(); return; }
            var desc = document.getElementById('nbDescInput').value.trim();
            var activeDot = document.querySelector('#nbColorPicker .nb-color-dot.active');
            var color = activeDot ? activeDot.dataset.color : '#7C5CFC';

            if (nbState.editingNotebookId) {
                // Update
                invoke('notebook_update', {
                    notebookId: nbState.editingNotebookId,
                    name: name,
                    description: desc,
                    color: color,
                }).then(function () {
                    modal.style.display = 'none';
                    loadNotebooks();
                }).catch(function (err) { console.error('更新笔记本失败:', err); });
            } else {
                // Create
                invoke('notebook_create', {
                    name: name,
                    description: desc,
                    color: color,
                }).then(function (res) {
                    modal.style.display = 'none';
                    nbState.activeNotebookId = res.notebook_id;
                    loadNotebooks();
                }).catch(function (err) { console.error('创建笔记本失败:', err); });
            }
        });

        // Close on overlay click
        modal.addEventListener('click', function (e) {
            if (e.target === modal) modal.style.display = 'none';
        });
    }

    function openNotebookModal(title, name, desc, color) {
        document.getElementById('nbModalTitle').textContent = title;
        document.getElementById('nbNameInput').value = name;
        document.getElementById('nbDescInput').value = desc;
        // Set color
        document.querySelectorAll('#nbColorPicker .nb-color-dot').forEach(function (d) {
            d.classList.toggle('active', d.dataset.color === color);
        });
        document.getElementById('nbModal').style.display = 'flex';
        if (window.lucide) window.lucide.createIcons();
        setTimeout(function () { document.getElementById('nbNameInput').focus(); }, 100);
    }

    // ── PPT Import ───────────────────────────────────────────────────────────
    function bindPptEvents() {
        var modal = document.getElementById('pptModal');
        var dropZone = document.getElementById('pptDropZone');
        var fileInput = document.getElementById('pptFileInput');
        var importBtn = document.getElementById('nbImportPptBtn');
        // Round 5: nbImportPptBtn 已从 DOM 删除；若旧代码仍可触达 #pptModal，保留其余逻辑
        if (!importBtn || !modal || !dropZone || !fileInput) return;

        importBtn.addEventListener('click', function () {
            if (!nbState.activeNotebookId) return;
            nbState.pptFiles = [];
            renderPptFileList();
            modal.style.display = 'flex';
            if (window.lucide) window.lucide.createIcons();
        });

        var pptClose = document.getElementById('pptModalClose');
        var pptCancel = document.getElementById('pptModalCancel');
        if (pptClose) pptClose.addEventListener('click', function () { modal.style.display = 'none'; });
        if (pptCancel) pptCancel.addEventListener('click', function () { modal.style.display = 'none'; });
        modal.addEventListener('click', function (e) { if (e.target === modal) modal.style.display = 'none'; });

        // Drop zone click → open file picker
        dropZone.addEventListener('click', function () { fileInput.click(); });

        // Drag & drop
        dropZone.addEventListener('dragover', function (e) {
            e.preventDefault();
            dropZone.classList.add('dragover');
        });
        dropZone.addEventListener('dragleave', function () {
            dropZone.classList.remove('dragover');
        });
        dropZone.addEventListener('drop', function (e) {
            e.preventDefault();
            dropZone.classList.remove('dragover');
            var files = Array.from(e.dataTransfer.files).filter(function (f) {
                return /\.(pptx?|ppt)$/i.test(f.name);
            });
            files.forEach(function (f) { addPptFile(f); });
        });

        // File input change
        fileInput.addEventListener('change', function (e) {
            Array.from(e.target.files).forEach(function (f) { addPptFile(f); });
            e.target.value = '';
        });

        // Import button
        document.getElementById('pptModalImport').addEventListener('click', handlePptImport);
    }

    function addPptFile(file) {
        // Avoid duplicates by name
        if (nbState.pptFiles.some(function (f) { return f.name === file.name; })) return;
        nbState.pptFiles.push(file);
        renderPptFileList();
    }

    function renderPptFileList() {
        var container = document.getElementById('pptSelectedFiles');
        container.innerHTML = '';
        document.getElementById('pptModalImport').disabled = nbState.pptFiles.length === 0;

        nbState.pptFiles.forEach(function (file, idx) {
            var div = document.createElement('div');
            div.className = 'ppt-file-item';
            div.innerHTML =
                '<span>' + escapeHtml(file.name) + ' (' + formatSize(file.size) + ')</span>' +
                '<button data-idx="' + idx + '" title="移除"><i data-lucide="x" style="width:12px;height:12px"></i></button>';
            container.appendChild(div);
        });

        container.querySelectorAll('button[data-idx]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var i = parseInt(btn.dataset.idx, 10);
                nbState.pptFiles.splice(i, 1);
                renderPptFileList();
            });
        });

        if (window.lucide) window.lucide.createIcons();
    }

    function handlePptImport() {
        if (nbState.pptFiles.length === 0 || !nbState.activeNotebookId) return;

        var importBtn = document.getElementById('pptModalImport');
        importBtn.disabled = true;
        importBtn.innerHTML = '<span>正在导入...</span>';

        var promises = nbState.pptFiles.map(function (file) {
            return new Promise(function (resolve, reject) {
                var reader = new FileReader();
                reader.onload = function (ev) {
                    var uint8 = new Uint8Array(ev.target.result);
                    var binary = '';
                    for (var i = 0; i < uint8.length; i++) { binary += String.fromCharCode(uint8[i]); }
                    resolve({ name: file.name, data: btoa(binary) });
                };
                reader.onerror = function () { reject(new Error('读取文件失败: ' + file.name)); };
                reader.readAsArrayBuffer(file);
            });
        });

        Promise.all(promises)
            .then(function (filesData) {
                return invoke('notebook_import_ppt', {
                    notebookId: nbState.activeNotebookId,
                    files: filesData,
                });
            })
            .then(function (res) {
                document.getElementById('pptModal').style.display = 'none';
                nbState.pptFiles = [];
                loadNotebookEntries(nbState.activeNotebookId);
            })
            .catch(function (err) {
                console.error('PPT导入失败:', err);
                alert('PPT导入失败: ' + String(err));
            })
            .finally(function () {
                importBtn.disabled = false;
                importBtn.innerHTML = '<i data-lucide="file-down" style="width:14px;height:14px"></i><span>开始导入</span>';
                if (window.lucide) window.lucide.createIcons();
            });
    }

    // ── Text Annotation (Round 5: 入口按钮已删除；改为笔记区选中文字浮条触发) ──
    function bindAnnotateEvents() {
        var modal = document.getElementById('annotateModal');
        var textArea = document.getElementById('annotateText');
        var submitBtn = document.getElementById('annotateModalSubmit');
        var annBtn = document.getElementById('nbAnnotateBtn');
        if (!annBtn || !modal || !textArea || !submitBtn) return;

        annBtn.addEventListener('click', function () {
            if (!nbState.activeNotebookId) return;
            textArea.value = '';
            document.getElementById('annotateContext').value = '';
            submitBtn.disabled = true;
            modal.style.display = 'flex';
            if (window.lucide) window.lucide.createIcons();
            setTimeout(function () { textArea.focus(); }, 100);
        });

        var annClose = document.getElementById('annotateModalClose');
        var annCancel = document.getElementById('annotateModalCancel');
        if (annClose) annClose.addEventListener('click', function () { modal.style.display = 'none'; });
        if (annCancel) annCancel.addEventListener('click', function () { modal.style.display = 'none'; });
        modal.addEventListener('click', function (e) { if (e.target === modal) modal.style.display = 'none'; });

        // Enable submit when text is entered
        textArea.addEventListener('input', function () {
            submitBtn.disabled = !textArea.value.trim();
        });

        submitBtn.addEventListener('click', handleAnnotateSubmit);
    }

    function handleAnnotateSubmit() {
        var text = document.getElementById('annotateText').value.trim();
        if (!text || !nbState.activeNotebookId) return;
        var context = document.getElementById('annotateContext').value.trim();

        var submitBtn = document.getElementById('annotateModalSubmit');
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<span>AI 分析中...</span>';
        nbState.annotating = true;

        invoke('notebook_annotate_text', {
            notebookId: nbState.activeNotebookId,
            selectedText: text,
            context: context || null,
        }).then(function () {
            document.getElementById('annotateModal').style.display = 'none';
            // Show generating indicator in entries list
            showGeneratingIndicator();
        }).catch(function (err) {
            console.error('文本标注失败:', err);
            alert('标注请求失败: ' + String(err));
        }).finally(function () {
            submitBtn.disabled = false;
            submitBtn.innerHTML = '<i data-lucide="sparkles" style="width:14px;height:14px"></i><span>AI 分析</span>';
            if (window.lucide) window.lucide.createIcons();
        });
    }

    var _genPending = Object.create(null);
    function beginGeneratingIndicator(id, message) {
        if (!id || !$nbEntriesList) return;
        _genPending[id] = (_genPending[id] || 0) + 1;
        var indicator = document.getElementById(id);
        var text = escapeHtml(message || 'AI 正在生成笔记...');
        var suffix = _genPending[id] > 1 ? ('（并行 ' + _genPending[id] + '）') : '';
        if (!indicator) {
            indicator = document.createElement('div');
            indicator.className = 'nb-generating';
            indicator.id = id;
            indicator.innerHTML = '<div class="spinner"></div><span>' + text + suffix + '</span>';
            $nbEntriesList.insertBefore(indicator, $nbEntriesList.firstChild);
            return;
        }
        var span = indicator.querySelector('span');
        if (span) span.textContent = (message || 'AI 正在生成笔记...') + suffix;
    }

    function endGeneratingIndicator(id) {
        if (!id) return;
        if (_genPending[id]) _genPending[id] = Math.max(0, _genPending[id] - 1);
        var indicator = document.getElementById(id);
        if (!indicator) return;
        var remain = _genPending[id] || 0;
        if (remain <= 0) {
            indicator.remove();
            delete _genPending[id];
            return;
        }
        var span = indicator.querySelector('span');
        if (span) {
            var base = span.textContent.replace(/（并行\s*\d+）$/, '').trim();
            span.textContent = base + '（并行 ' + remain + '）';
        }
    }

    // Backward-compatible wrappers
    function showGeneratingIndicator() {
        beginGeneratingIndicator('nbGeneratingIndicator', 'AI 正在分析文本...');
    }
    function showGeneratingIndicatorCustom(id, message) {
        beginGeneratingIndicator(id, message);
    }

    // ── Page Range Generation ────────────────────────────────────────────────
    function populateNotebookSelectors() {
        var selectors = [
            document.getElementById('pageRangeNotebook'),
            document.getElementById('textSelectNotebook')
        ];
        selectors.forEach(function (sel) {
            if (!sel) return;
            var val = sel.value;
            sel.innerHTML = '<option value="">-- 选择笔记本 --</option>';
            nbState.notebooks.forEach(function (nb) {
                var opt = document.createElement('option');
                opt.value = nb.notebook_id;
                opt.textContent = nb.name;
                sel.appendChild(opt);
            });
            if (val) sel.value = val;
        });
    }

    // ── PDF Page Note Button in Notebook tab action bar ──────────────────────
    function bindNbPdfPageNoteBtn() {
        var btn = document.getElementById('nbPdfPageNoteBtn');
        if (!btn) return;
        btn.addEventListener('click', function () {
            var drState = window.DocReader && window.DocReader.getState ? window.DocReader.getState() : null;
            if (!drState || !drState.sessionId) {
                alert('请先打开文档');
                return;
            }
            if (!nbState.activeNotebookId) {
                alert('请先选择一个笔记本');
                return;
            }
            // Open the page range modal and pre-select this notebook
            var modal = document.getElementById('pageRangeModal');
            var input = document.getElementById('pageRangeInput');
            var nbSelect = document.getElementById('pageRangeNotebook');
            if (!modal) return;
            input.value = '';
            document.getElementById('pageRangeModalSubmit').disabled = true;
            populateNotebookSelectors();
            if (nbState.activeNotebookId) nbSelect.value = nbState.activeNotebookId;
            modal.style.display = 'flex';
            if (window.lucide) window.lucide.createIcons();
            setTimeout(function () { input.focus(); }, 100);
        });
    }

    function bindPageRangeEvents() {
        var modal = document.getElementById('pageRangeModal');
        var input = document.getElementById('pageRangeInput');
        var submitBtn = document.getElementById('pageRangeModalSubmit');
        var nbSelect = document.getElementById('pageRangeNotebook');
        var openBtn = document.getElementById('pageRangeBtn');

        if (!modal || !openBtn) return;

        openBtn.addEventListener('click', function () {
            var drState = window.DocReader && window.DocReader.getState ? window.DocReader.getState() : null;
            if (!drState || !drState.sessionId) return;
            input.value = '';
            submitBtn.disabled = true;
            populateNotebookSelectors();
            // Pre-select active notebook if exists
            if (nbState.activeNotebookId) nbSelect.value = nbState.activeNotebookId;
            modal.style.display = 'flex';
            if (window.lucide) window.lucide.createIcons();
            setTimeout(function () { input.focus(); }, 100);
        });

        document.getElementById('pageRangeModalClose').addEventListener('click', function () { modal.style.display = 'none'; });
        document.getElementById('pageRangeModalCancel').addEventListener('click', function () { modal.style.display = 'none'; });
        modal.addEventListener('click', function (e) { if (e.target === modal) modal.style.display = 'none'; });

        function updateSubmitState() {
            submitBtn.disabled = !input.value.trim() || !nbSelect.value;
        }
        input.addEventListener('input', updateSubmitState);
        nbSelect.addEventListener('change', updateSubmitState);

        submitBtn.addEventListener('click', function () {
            var drState = window.DocReader && window.DocReader.getState ? window.DocReader.getState() : null;
            if (!drState || !drState.sessionId) return;
            var ranges = input.value.trim();
            var notebookId = nbSelect.value;
            var noteType = document.getElementById('pageRangeNoteType').value;
            if (!ranges || !notebookId) return;

            submitBtn.disabled = true;
            submitBtn.innerHTML = '<span>生成中...</span>';

            // 对 PDF 文件，从 pdf.js 提取每页文本（确保与渲染一致）
            var contentPromise;
            if (drState.isPdf && drState.pdfDoc) {
                contentPromise = extractPdfPagesText(drState.pdfDoc, ranges, drState.pageCount);
            } else {
                contentPromise = Promise.resolve(null);
            }

            contentPromise.then(function (pageContents) {
                var args = {
                    notebookId: notebookId,
                    sessionId: drState.sessionId,
                    pageRanges: ranges,
                    noteType: noteType,
                };
                if (pageContents) {
                    args.pageContents = pageContents;
                }
                return invoke('notebook_generate_from_pages', args);
            }).then(function () {
                modal.style.display = 'none';
                // Switch to notebooks tab and select the target notebook
                nbState.activeNotebookId = notebookId;
                $notebookSelect.value = notebookId;
                enableNotebookActions(true);
                // Switch tab
                document.querySelectorAll('.sidebar-tab').forEach(function (t) { t.classList.remove('active'); });
                document.querySelector('[data-tab="notebooks"]').classList.add('active');
                document.querySelectorAll('.sidebar-tab-content').forEach(function (c) { c.classList.remove('active'); });
                document.getElementById('tabNotebooks').classList.add('active');
                beginGeneratingIndicator('nbPageRangeIndicator', 'AI 正在生成第 ' + ranges + ' 页笔记...');
            }).catch(function (err) {
                console.error('选页生成失败:', err);
                alert('选页生成失败: ' + String(err));
            }).finally(function () {
                submitBtn.disabled = false;
                submitBtn.innerHTML = '<i data-lucide="sparkles" style="width:14px;height:14px"></i><span>生成笔记</span>';
                if (window.lucide) window.lucide.createIcons();
            });
        });
    }

    // ── Text Selection Generation ────────────────────────────────────────────
    function bindTextSelectEvents() {
        var modal = document.getElementById('textSelectModal');
        var textArea = document.getElementById('textSelectContent');
        var submitBtn = document.getElementById('textSelectModalSubmit');
        var nbSelect = document.getElementById('textSelectNotebook');
        var openBtn = document.getElementById('textSelectBtn');

        if (!modal || !openBtn) return;

        openBtn.addEventListener('click', function () {
            var drState = window.DocReader && window.DocReader.getState ? window.DocReader.getState() : null;
            if (!drState || !drState.sessionId) return;
            textArea.value = '';
            submitBtn.disabled = true;
            populateNotebookSelectors();
            if (nbState.activeNotebookId) nbSelect.value = nbState.activeNotebookId;
            // Pre-fill with browser selection if any
            var selection = window.getSelection();
            if (selection && selection.toString().trim()) {
                textArea.value = selection.toString().trim();
            }
            modal.style.display = 'flex';
            if (window.lucide) window.lucide.createIcons();
            setTimeout(function () { textArea.focus(); }, 100);
        });

        document.getElementById('textSelectModalClose').addEventListener('click', function () { modal.style.display = 'none'; });
        document.getElementById('textSelectModalCancel').addEventListener('click', function () { modal.style.display = 'none'; });
        modal.addEventListener('click', function (e) { if (e.target === modal) modal.style.display = 'none'; });

        function updateSubmitState() {
            submitBtn.disabled = !textArea.value.trim() || !nbSelect.value;
        }
        textArea.addEventListener('input', updateSubmitState);
        nbSelect.addEventListener('change', updateSubmitState);

        submitBtn.addEventListener('click', function () {
            var drState = window.DocReader && window.DocReader.getState ? window.DocReader.getState() : null;
            if (!drState || !drState.sessionId) return;
            var text = textArea.value.trim();
            var notebookId = nbSelect.value;
            var noteType = document.getElementById('textSelectNoteType').value;
            var customPromptEl = document.getElementById('textSelectCustomPrompt');
            var customPrompt = (customPromptEl && customPromptEl.value.trim()) ? customPromptEl.value.trim() : null;
            if (!text || !notebookId) return;

            submitBtn.disabled = true;
            submitBtn.innerHTML = '<span>生成中...</span>';

            invoke('notebook_generate_from_text', {
                notebookId: notebookId,
                sessionId: drState.sessionId,
                selectedText: text,
                noteType: noteType,
                pageIndex: drState.currentPage != null ? drState.currentPage : 0,
                customPrompt: customPrompt,
            }).then(function () {
                modal.style.display = 'none';
                nbState.activeNotebookId = notebookId;
                $notebookSelect.value = notebookId;
                enableNotebookActions(true);
                // Switch tab
                document.querySelectorAll('.sidebar-tab').forEach(function (t) { t.classList.remove('active'); });
                document.querySelector('[data-tab="notebooks"]').classList.add('active');
                document.querySelectorAll('.sidebar-tab-content').forEach(function (c) { c.classList.remove('active'); });
                document.getElementById('tabNotebooks').classList.add('active');
                beginGeneratingIndicator('nbTextNoteIndicator', 'AI 正在分析选中文本...');
            }).catch(function (err) {
                console.error('选文生成失败:', err);
                alert('选文生成失败: ' + String(err));
            }).finally(function () {
                submitBtn.disabled = false;
                submitBtn.innerHTML = '<i data-lucide="sparkles" style="width:14px;height:14px"></i><span>生成笔记</span>';
                if (window.lucide) window.lucide.createIcons();
            });
        });
    }

    // ── Tauri event listeners ────────────────────────────────────────────────
    // ── Round 6: 重构学习路径（两步 LLM：entry 元信息抽取 + 整本学习大纲规划） ─
    function bindRelayoutButton() {
        var btn = document.getElementById('nbRelayoutBtn');
        var hint = document.getElementById('nbRelayoutHint');
        if (!btn) return;
        btn.addEventListener('click', function () {
            if (!nbState.activeNotebookId) return;
            if (btn.classList.contains('running') || nbState.buildingOutline) return;
            var total = (nbState.entries || []).length;
            if (!total) { if (hint) hint.textContent = '当前笔记本没有可用条目'; return; }
            var confirmMsg = '即将用 AI 把当前笔记本重构成"可学习的知识书"：\n' +
                '• 为每条 section 抽取主题与学习角色（' + total + ' 条）\n' +
                '• 规划知识区、学习路径与前置依赖\n' +
                '• 生成每个知识区的回顾题\n\n' +
                '该过程可能需要 1–3 分钟，继续？';
            if (!confirm(confirmMsg)) return;
            nbState.buildingOutline = true;
            btn.classList.add('running');
            btn.disabled = true;
            if ($nbFloatRelayoutBtn) $nbFloatRelayoutBtn.disabled = true;
            var labelEl = btn.querySelector('.nb-relayout-label');
            if (labelEl) labelEl.textContent = '抽取元信息…';
            if (hint) hint.textContent = '';
            var busyToken = null;
            try { if (window.UIBusy) busyToken = window.UIBusy.push('重构学习路径中…'); } catch (_) { }
            invoke('notebook_build_learning_outline', { notebookId: nbState.activeNotebookId })
                .then(function (res) {
                    if (hint) {
                        hint.textContent = '已识别 ' + (res.zones || 0) + ' 个知识区 · ' + (res.meta_extracted || 0) + '/' + (res.total || 0) + ' 条 section';
                    }
                    try { if (window.UIBusy) window.UIBusy.toast('学习路径已重构完成'); } catch (_) { }
                    // 重新加载条目与学习大纲
                    return Promise.all([
                        loadNotebookEntries(nbState.activeNotebookId),
                        loadLearningOutline(nbState.activeNotebookId, true),
                    ]);
                })
                .catch(function (err) {
                    console.error('重构学习路径失败:', err);
                    if (hint) hint.textContent = '重构失败：' + String(err).slice(0, 80);
                    try { if (window.UIBusy) window.UIBusy.toast('重构失败: ' + String(err).slice(0, 60), 'error'); } catch (_) { }
                })
                .finally(function () {
                    nbState.buildingOutline = false;
                    btn.classList.remove('running');
                    btn.disabled = !nbState.activeNotebookId;
                    if ($nbFloatRelayoutBtn) $nbFloatRelayoutBtn.disabled = btn.disabled;
                    if (labelEl) labelEl.textContent = '重构学习路径';
                    try { if (window.UIBusy && busyToken) window.UIBusy.pop(busyToken); } catch (_) { }
                    setTimeout(function () { if (hint && !btn.classList.contains('running')) updateRelayoutButtonState(); }, 6000);
                });
        });
    }

    function updateRelayoutButtonState() {
        var btn = document.getElementById('nbRelayoutBtn');
        var hint = document.getElementById('nbRelayoutHint');
        if (!btn) return;
        if (!nbState.activeNotebookId || !nbState.entries.length) {
            btn.disabled = true;
            if ($nbFloatRelayoutBtn) $nbFloatRelayoutBtn.disabled = true;
            if (hint && !btn.classList.contains('running')) hint.textContent = '';
            return;
        }
        btn.disabled = false;
        if ($nbFloatRelayoutBtn) $nbFloatRelayoutBtn.disabled = false;
        var hasOutline = !!(nbState.learningOutline && nbState.learningOutline.outline_ready);
        var bad = nbState.entries.filter(function (e) { return titleLooksAuto(e.title); }).length;
        if (hint && !btn.classList.contains('running')) {
            if (!hasOutline) {
                hint.textContent = '还未规划学习路径，点击重构';
            } else if (bad > 0) {
                hint.textContent = bad + ' 个节点标题可再优化';
            } else {
                var zc = (nbState.learningOutline.outline && nbState.learningOutline.outline.zones || []).length;
                hint.textContent = '已规划 ' + zc + ' 个知识区 · 可重新生成';
            }
        }
    }

    // ── Round 4: 侧栏折叠/展开 ──────────────────────────────────────────────
    var NB_RAIL_COLLAPSED_KEY = 'nbRailCollapsed';
    function setRailCollapsed(collapsed, persist) {
        var rail = document.getElementById('nbSideRail');
        var btn = document.getElementById('nbRailToggle');
        var edge = document.getElementById('nbRailEdgeHandle');
        var panelNotes = document.getElementById('panelNotes');
        if (!rail || !btn) return;
        rail.classList.toggle('collapsed', !!collapsed);
        if (panelNotes) panelNotes.classList.toggle('rail-collapsed', !!collapsed);
        if (edge) edge.title = collapsed ? '展开笔记侧栏' : '折叠笔记侧栏';
        updateRailToggleIcon(btn, !!collapsed);
        var $nbPreviewOutlineBtn = document.getElementById('nbPreviewOutlineBtn');
        if ($nbPreviewOutlineBtn) {
            $nbPreviewOutlineBtn.innerHTML = '<i data-lucide="' + (collapsed ? 'panel-right-open' : 'panel-right-close') + '" style="width:12px;height:12px"></i>';
            $nbPreviewOutlineBtn.title = collapsed ? '展开知识目录' : '折叠知识目录';
            if (window.lucide) { try { window.lucide.createIcons(); } catch (_) { } }
        }
        if (persist !== false) {
            try { localStorage.setItem(NB_RAIL_COLLAPSED_KEY, collapsed ? '1' : '0'); } catch (_) { }
        }
    }
    function ensureRailExpanded() {
        setRailCollapsed(false);
    }
    function bindRailToggle() {
        var rail = document.getElementById('nbSideRail');
        var btn = document.getElementById('nbRailToggle');
        var edge = document.getElementById('nbRailEdgeHandle');
        if (!rail || !btn) return;

        function syncRailCollapsedUI(collapsed) {
            if (panelNotes) panelNotes.classList.toggle('rail-collapsed', !!collapsed);
            if (edge) edge.title = collapsed ? '展开笔记侧栏' : '折叠笔记侧栏';
        }
        // Restore persisted state
        try {
            var saved = localStorage.getItem(NB_RAIL_COLLAPSED_KEY);
            // 默认沉浸阅读：未配置时默认折叠
            var collapsed = (saved == null) ? true : (saved === '1');
            setRailCollapsed(collapsed, false);
        } catch (_) { }
        btn.addEventListener('click', function () {
            setRailCollapsed(!rail.classList.contains('collapsed'));
        });
        if (edge) edge.addEventListener('click', function () { setRailCollapsed(false); });
    }
    function updateRailToggleIcon(btn, collapsed) {
        // Swap the lucide icon name; lucide re-render picks it up.
        btn.innerHTML = '<i data-lucide="' + (collapsed ? 'panel-right-open' : 'panel-right-close') + '" style="width:14px;height:14px"></i>';
        btn.title = collapsed ? '展开侧栏' : '折叠侧栏';
        if (window.lucide) { try { window.lucide.createIcons(); } catch (_) { } }
    }

    function setupListeners() {
        listen('notebook-annotate-done', function (data) {            nbState.annotating = false;
            endGeneratingIndicator('nbGeneratingIndicator');
            // Refresh entries if the annotation was for the active notebook
            if (data.notebook_id === nbState.activeNotebookId) {
                loadNotebookEntries(nbState.activeNotebookId);
            }
        });

        listen('notebook-annotate-error', function (data) {
            nbState.annotating = false;
            endGeneratingIndicator('nbGeneratingIndicator');
            console.error('文本标注失败:', data.error);
        });

        listen('notebook-page-range-done', function (data) {
            endGeneratingIndicator('nbPageRangeIndicator');
            if (data.notebook_id === nbState.activeNotebookId) {
                loadNotebookEntries(nbState.activeNotebookId);
            }
        });

        listen('notebook-page-range-error', function (data) {
            endGeneratingIndicator('nbPageRangeIndicator');
            console.error('选页笔记生成失败:', data.error);
            alert('选页笔记生成失败: ' + (data.error || '未知错误'));
        });

        listen('notebook-text-note-done', function (data) {
            endGeneratingIndicator('nbTextNoteIndicator');
            if (data.notebook_id === nbState.activeNotebookId) {
                loadNotebookEntries(nbState.activeNotebookId);
            }
        });

        listen('notebook-text-note-error', function (data) {
            endGeneratingIndicator('nbTextNoteIndicator');
            console.error('选文笔记生成失败:', data.error);
            alert('选文笔记生成失败: ' + (data.error || '未知错误'));
        });

        // 新版：自动 section 生成完成（单页/批量/追加讲解 共用）
        listen('notebook-section-generated', function (data) {
            endGeneratingIndicator('nbSectionIndicator');
            if (!data || data.notebook_id !== nbState.activeNotebookId) return;
            // 重新加载条目并自动打开预览 + 滚动到新 section
            invoke('notebook_get', { notebookId: nbState.activeNotebookId }).then(function (res) {
                nbState.entries = res.entries || [];
                renderEntries();
                // Round 3: 工作台常显，直接重新渲染定位
                if (nbState.entries.length > 0) {
                    showPreview(data.entry_id, '', '');
                }
                setTimeout(function () {
                    var sec = document.getElementById('nb-sec-' + data.entry_id);
                    if (sec) {
                        sec.classList.add('nb-section-flash');
                        sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
                        setTimeout(function () { sec.classList.remove('nb-section-flash'); }, 1800);
                    }
                }, 120);
            });
        });

        listen('notebook-section-error', function (data) {
            endGeneratingIndicator('nbSectionIndicator');
            console.error('Section 生成失败:', data && data.error);
            if (data && data.error) alert('笔记生成失败: ' + data.error);
        });

        listen('notebook-generate-all-progress', function (data) {
            // 简单在控制台观察进度；生成结束后 done 事件会刷新
            if (data && data.total) {
                console.log('[Notebook 批量生成] ' + (data.completed || 0) + '/' + data.total);
            }
        });

        listen('notebook-generate-all-done', function (data) {
            if (data && data.notebook_id === nbState.activeNotebookId) {
                loadNotebookEntries(nbState.activeNotebookId);
            }
        });

        // Round 8: 串行生成进度 — 每页生成完更新徽章数字 + toast
        listen('notebook-serial-progress', function (data) {
            if (!data || data.notebook_id !== nbState.activeNotebookId) return;
            var done = data.completed || 0;
            var total = data.total || 0;
            var $btn = document.getElementById('nbFloatGen10Btn');
            if ($btn) {
                var badge = $btn.querySelector('.nb-float-gen10-badge');
                if (badge) badge.textContent = done + '/' + total;
            }
            if (data.error) {
                if (window.UIBusy && window.UIBusy.toast) {
                    window.UIBusy.toast('第 ' + ((data.page_index || 0) + 1) + ' 页生成失败', 1600, true);
                }
            } else if (data.skipped) {
                if (window.UIBusy && window.UIBusy.toast) {
                    window.UIBusy.toast('第 ' + ((data.page_index || 0) + 1) + ' 页已跳过', 1200);
                }
            } else if (data.entry_id) {
                if (window.UIBusy && window.UIBusy.toast) {
                    window.UIBusy.toast('第 ' + ((data.page_index || 0) + 1) + ' 页已完成 (' + done + '/' + total + ')', 1400);
                }
            }
        });

        listen('notebook-serial-done', function (data) {
            _serialRunning = false;
            var $btn = document.getElementById('nbFloatGen10Btn');
            if ($btn) {
                $btn.classList.remove('running');
                $btn.disabled = !(window.DocReader && window.DocReader.getState && window.DocReader.getState().sessionId);
                var badge = $btn.querySelector('.nb-float-gen10-badge');
                if (badge) badge.textContent = '10';
            }
            if (window.UIBusy && window.UIBusy.pop) window.UIBusy.pop();
            if (window.UIBusy && window.UIBusy.toast) {
                var done = (data && data.completed) || 0;
                var total = (data && data.total) || 0;
                window.UIBusy.toast('串行生成完成 ' + done + '/' + total, 2200);
            }
            if (data && data.notebook_id === nbState.activeNotebookId) {
                loadNotebookEntries(nbState.activeNotebookId);
            }
        });

        listen('notebook-serial-error', function (data) {
            _serialRunning = false;
            var $btn = document.getElementById('nbFloatGen10Btn');
            if ($btn) {
                $btn.classList.remove('running');
                $btn.disabled = false;
                var badge = $btn.querySelector('.nb-float-gen10-badge');
                if (badge) badge.textContent = '10';
            }
            if (window.UIBusy && window.UIBusy.pop) window.UIBusy.pop();
            console.error('串行生成失败:', data && data.error);
            if (window.UIBusy && window.UIBusy.toast) {
                window.UIBusy.toast('串行生成失败: ' + String((data && data.error) || '').slice(0, 80), 3000, true);
            }
        });

        // 重构学习路径 进度事件
        listen('notebook-outline-progress', function (data) {
            if (!data || data.notebook_id !== nbState.activeNotebookId) return;
            var stage = data.stage || '';
            var msg = '';
            if (stage === 'start') {
                msg = '开始重构学习路径…';
            } else if (stage === 'extract') {
                msg = '抽取元信息 ' + (data.done || 0) + '/' + (data.total || 0);
            } else if (stage === 'plan') {
                msg = '规划学习路径…';
            } else if (stage === 'plan_chunked') {
                msg = '分块规划中（笔记较多）…';
            } else if (stage === 'plan_merge') {
                msg = '合并学习路径…';
            } else if (stage === 'done') {
                msg = '完成 · ' + (data.zones || 0) + ' 个学习区';
            }
            if (msg) {
                var btn = document.getElementById('nbRelayoutBtn');
                if (btn) {
                    var lbl = btn.querySelector('.nb-btn-label');
                    if (lbl) lbl.textContent = msg;
                    else btn.textContent = msg;
                }
            }
        });

        listen('notebook-outline-done', function (data) {
            if (!data || data.notebook_id !== nbState.activeNotebookId) return;
            // 重置按钮文字 + 刷新
            var btn = document.getElementById('nbRelayoutBtn');
            if (btn) {
                var lbl = btn.querySelector('.nb-btn-label');
                if (lbl) lbl.textContent = '重构学习路径';
            }
            loadNotebookEntries(nbState.activeNotebookId);
            loadLearningOutline(nbState.activeNotebookId, true);
        });
    }

    // ── Data loading ─────────────────────────────────────────────────────────
    function loadNotebooks() {
        invoke('notebook_list')
            .then(function (res) {
                nbState.notebooks = res.notebooks || [];
                renderNotebookSelect();
                renderPickerHead();
                // Auto-select active notebook if it still exists
                if (nbState.activeNotebookId) {
                    var exists = nbState.notebooks.some(function (n) { return n.notebook_id === nbState.activeNotebookId; });
                    if (exists) {
                        if ($notebookSelect) try { $notebookSelect.value = nbState.activeNotebookId; } catch (_) {}
                        enableNotebookActions(true);
                        loadNotebookEntries(nbState.activeNotebookId);
                        loadOutline(nbState.activeNotebookId);
                    } else {
                        nbState.activeNotebookId = null;
                        nbState.outline = null;
                        nbState.previewEntryId = null;
                        enableNotebookActions(false);
                        renderPickerHead();
                        setRailCollapsed(true, false);
                        renderEntries();
                        renderPreviewEmptyState();
                    }
                } else {
                    nbState.outline = null;
                    nbState.previewEntryId = null;
                    enableNotebookActions(false);
                    setRailCollapsed(true, false);
                    renderEntries();
                    renderPreviewEmptyState();
                }
            })
            .catch(function (err) {
                console.error('加载笔记本列表失败:', err);
            });
    }

    function loadNotebookEntries(notebookId) {
        invoke('notebook_get', { notebookId: notebookId })
            .then(function (res) {
                nbState.entries = res.entries || [];
                var nb = nbState.notebooks.find(function (n) { return n.notebook_id === notebookId; });
                if (nb) nb.entry_count = nbState.entries.length;
                renderPickerHead();
                renderEntries();
                updateRelayoutButtonState();
                if (!nbState.entries.length) {
                    renderPreviewEmptyState('当前笔记本还没有内容，可以直接生成当前页笔记。');
                    loadOutline(notebookId);
                    return;
                }
                // Round 3: keep main pane in sync
                if (!nbState.entries.length) {
                    renderPreviewEmptyState('当前笔记本还没有节点。左侧可选择生成方式开始创建。');
                } else if (!nbState.previewEntryId || !findEntryById(nbState.previewEntryId)) {
                    // Auto-show the first entry when nothing is selected
                    showPreview(nbState.entries[0].entry_id, '', '');
                }
                loadOutline(notebookId);
            })
            .catch(function (err) {
                console.error('加载笔记条目失败:', err);
            });
    }

    // ── Rendering ────────────────────────────────────────────────────────────
    function renderNotebookSelect() {
        if (!$notebookSelect) return;
        var val = $notebookSelect.value;
        $notebookSelect.innerHTML = '<option value="">-- 选择笔记本 --</option>';
        nbState.notebooks.forEach(function (nb) {
            var opt = document.createElement('option');
            opt.value = nb.notebook_id;
            opt.textContent = nb.name + ' (' + (nb.entry_count || 0) + ')';
            opt.style.borderLeft = '3px solid ' + (nb.color || '#7C5CFC');
            $notebookSelect.appendChild(opt);
        });
        if (nbState.activeNotebookId) {
            try { $notebookSelect.value = nbState.activeNotebookId; } catch (_) {}
        } else if (val) {
            try { $notebookSelect.value = val; } catch (_) {}
        }
    }

    // ── Round 2: outline loader + tree renderer ──────────────────────────────
    function loadOutline(notebookId) {
        if (!notebookId) { nbState.outline = null; return Promise.resolve(); }
        // 同时拉取"文档来源分组"（兜底）和"学习路径大纲"（主渲染）
        var pLegacy = invoke('notebook_get_outline', { notebookId: notebookId })
            .then(function (res) { nbState.outline = res || null; })
            .catch(function (err) { console.warn('加载笔记本大纲失败:', err); nbState.outline = null; });
        var pLearn = loadLearningOutline(notebookId, false);
        return Promise.all([pLegacy, pLearn]).then(function () { renderEntries(); });
    }

    // Round 6: 加载学习路径大纲
    function loadLearningOutline(notebookId, forceRerender) {
        if (!notebookId) { nbState.learningOutline = null; return Promise.resolve(); }
        return invoke('notebook_get_learning_outline', { notebookId: notebookId })
            .then(function (res) {
                nbState.learningOutline = res || null;
                // outline 更新后，清掉按 entry 的关联缓存（links 可能变了）
                nbState.relatedCache = {};
                if (forceRerender) { renderEntries(); reloadActivePreview(); }
            })
            .catch(function (err) {
                console.warn('加载学习路径失败:', err);
                nbState.learningOutline = null;
            });
    }

    function reloadActivePreview() {
        if (nbState.previewEntryId) {
            var e = findEntryById(nbState.previewEntryId);
            if (e) showPreview(e.entry_id, e.title, e.content);
        } else {
            // 没激活 entry 时，直接渲染"整本书"视图
            if (nbState.entries && nbState.entries.length) {
                showPreview(nbState.entries[0].entry_id, '', '');
            }
        }
    }

    // Role 中文映射
    var LEARN_ROLE_LABELS = {
        foundation: '基础',
        mechanism: '机制',
        comparison: '对比',
        misconception: '易错',
        application: '应用',
        example: '示例',
        recap: '回顾',
    };
    var LEARN_ROLE_ICONS = {
        foundation: 'book-open',
        mechanism: 'cpu',
        comparison: 'git-compare',
        misconception: 'alert-triangle',
        application: 'target',
        example: 'layers',
        recap: 'list-checks',
    };
    var LEARN_ROLE_ORDER = ['foundation','mechanism','comparison','misconception','application','example','recap'];

    function renderOutlineTree(outline) {
        // 兼容入口：若存在学习大纲则渲染学习路径树；否则回退到原来源分组树
        if ($nbEntriesList == null) return;
        var learn = nbState.learningOutline;
        if (learn && learn.outline_ready && learn.outline && Array.isArray(learn.outline.zones) && learn.outline.zones.length) {
            return renderLearningOutlineTree(learn);
        }
        return renderLegacyOutlineTree(outline);
    }

    // Round 6: 学习路径目录树（主渲染）
    function renderLearningOutlineTree(learn) {
        var outline = learn.outline || {};
        var zones = outline.zones || [];
        var entriesByZone = learn.entries_by_zone || {};
        var totalZones = zones.length;
        var thesis = outline.thesis || '';
        var learningPath = outline.learning_path || [];

        var html = '<div class="nb-learn-outline">';

        // 顶部：核心主线 + 学习路径步骤
        if (thesis) {
            html += '<div class="nb-learn-thesis">' +
                '<div class="nb-learn-thesis-label">核心主线</div>' +
                '<div class="nb-learn-thesis-text">' + escapeHtml(thesis) + '</div>';
            if (learningPath.length) {
                html += '<div class="nb-learn-path-pills">';
                learningPath.forEach(function (step) {
                    html += '<span class="nb-learn-path-pill">' + escapeHtml(LEARN_ROLE_LABELS[step] || step) + '</span>';
                });
                html += '</div>';
            }
            html += '</div>';
        }

        zones.forEach(function (zone, zi) {
            var zid = zone.zone_id || ('z' + (zi + 1));
            var zoneEntries = entriesByZone[zid] || [];
            var itemsCount = zoneEntries.length || (zone.entries || []).length;
            html += '<div class="nb-lz" data-zone-id="' + escapeHtml(zid) + '">' +
                '<div class="nb-lz-header">' +
                    '<i data-lucide="chevron-down" class="nb-lz-caret"></i>' +
                    '<span class="nb-lz-badge">' + String(zi + 1) + '</span>' +
                    '<span class="nb-lz-title">' + escapeHtml(zone.title || ('知识区 ' + (zi + 1))) + '</span>' +
                    '<span class="nb-lz-count">' + itemsCount + '</span>' +
                '</div>' +
                '<div class="nb-lz-body">';

            if (zone.learning_goal) {
                html += '<div class="nb-lz-goal"><i data-lucide="target"></i>' + escapeHtml(zone.learning_goal) + '</div>';
            }

            var prereqIds = zone.prerequisite_zone_ids || [];
            if (prereqIds.length) {
                html += '<div class="nb-lz-prereq"><span style="font-size:10px;color:var(--muted-foreground);">前置</span>';
                prereqIds.forEach(function (pid) {
                    var pz = findZoneById(zones, pid);
                    if (pz) {
                        html += '<span class="nb-lz-prereq-chip" data-jump-zone="' + escapeHtml(pid) + '">' + escapeHtml(pz.title || pid) + '</span>';
                    }
                });
                html += '</div>';
            }

            // 该 zone 内的 entries（按 zone_order 已排序）
            var renderList = zoneEntries.length ? zoneEntries : (zone.entries || []).map(function (ze) {
                // 当 entries_by_zone 为空（旧数据）时回退到 outline 里自带的 entries 结构
                return findEntryById(ze.entry_id) || { entry_id: ze.entry_id, title: ze.new_title || '未命名', learning_role: ze.learning_role, difficulty: ze.difficulty };
            });
            renderList.forEach(function (entry, idx) {
                var role = entry.learning_role || entry.section_role || '';
                var diff = parseInt(entry.difficulty || 0, 10) || 0;
                var isChild = !!(entry.parent_entry_id && entry.parent_entry_id !== '');
                var cls = 'nb-lz-item' + (isChild ? ' child-section' : '') + (entry.entry_id === nbState.activeSectionId ? ' active' : '');
                html += '<div class="' + cls + '" data-entry-id="' + escapeHtml(entry.entry_id || '') + '" title="' + escapeHtml(LEARN_ROLE_LABELS[role] || '') + (diff ? ' · 难度 ' + diff : '') + '">' +
                    '<span class="nb-lz-item-role ' + escapeHtml(role) + '"></span>' +
                    '<span class="nb-lz-item-idx">' + (idx + 1) + '</span>' +
                    '<span class="nb-lz-item-title">' + escapeHtml(cleanTitle(entry.title || '')) + '</span>' +
                    (diff ? '<span class="nb-lz-item-diff">' + renderDifficultyDots(diff) + '</span>' : '') +
                '</div>';
            });

            html += '</div></div>';
        });

        // 未分区 fallback。后端会把 `zone_id == ""` 的条目分桁到 key="" 下（而不是 __unassigned__），
        // 且新生成的条目在 relayout 前 zone_id 始终为空。这里以 all_entries 为准，
        // 反猜所有不在有效 zone 内的条目，避免遯漏。
        var validZoneIds = {};
        zones.forEach(function (z) { if (z && z.zone_id) validZoneIds[z.zone_id] = true; });
        var allList = (learn && learn.all_entries) || nbState.entries || [];
        var unassigned = allList.filter(function (e) {
            var zid = e && e.zone_id;
            return !zid || !validZoneIds[zid];
        });
        unassigned.sort(function (a, b) {
            return (a.zone_order || 0) - (b.zone_order || 0)
                || (a.created_at || '').localeCompare(b.created_at || '');
        });
        if (unassigned.length) {
            html += '<div class="nb-lz" data-zone-id="__unassigned__">' +
                '<div class="nb-lz-header">' +
                    '<i data-lucide="chevron-down" class="nb-lz-caret"></i>' +
                    '<span class="nb-lz-badge" style="background:var(--muted-foreground);">+</span>' +
                    '<span class="nb-lz-title">未分区</span>' +
                    '<span class="nb-lz-count">' + unassigned.length + '</span>' +
                '</div><div class="nb-lz-body">';
            unassigned.forEach(function (entry, idx) {
                var cls = 'nb-lz-item' + (entry.entry_id === nbState.activeSectionId ? ' active' : '');
                html += '<div class="' + cls + '" data-entry-id="' + escapeHtml(entry.entry_id || '') + '">' +
                    '<span class="nb-lz-item-role"></span>' +
                    '<span class="nb-lz-item-idx">' + (idx + 1) + '</span>' +
                    '<span class="nb-lz-item-title">' + escapeHtml(cleanTitle(entry.title || '')) + '</span>' +
                '</div>';
            });
            html += '</div></div>';
        }

        html += '</div>';
        $nbEntriesList.innerHTML = html;
        if (window.lucide) window.lucide.createIcons();

        // Collapse toggle
        $nbEntriesList.querySelectorAll('.nb-lz-header').forEach(function (h) {
            h.addEventListener('click', function (ev) {
                ev.stopPropagation();
                h.parentElement.classList.toggle('collapsed');
            });
        });
        // Prereq chip → 跳到目标 zone
        $nbEntriesList.querySelectorAll('[data-jump-zone]').forEach(function (el) {
            el.addEventListener('click', function (ev) {
                ev.stopPropagation();
                var pid = el.getAttribute('data-jump-zone');
                var tgt = $nbEntriesList.querySelector('.nb-lz[data-zone-id="' + cssEscape(pid) + '"]');
                if (tgt) {
                    tgt.classList.remove('collapsed');
                    tgt.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
                // 主区滚动到该 zone 的导读
                var bookZone = $nbPreviewBody && $nbPreviewBody.querySelector('.nb-book-zone[data-zone-id="' + cssEscape(pid) + '"]');
                if (bookZone) bookZone.scrollIntoView({ behavior: 'smooth', block: 'start' });
            });
        });
        // Item click → 展示对应 section
        $nbEntriesList.querySelectorAll('.nb-lz-item').forEach(function (el) {
            el.addEventListener('click', function (ev) {
                ev.stopPropagation();
                var eid = el.getAttribute('data-entry-id');
                if (!eid) return;
                var entry = findEntryById(eid);
                if (!entry) return;
                $nbEntriesList.querySelectorAll('.nb-lz-item.active').forEach(function (a) { a.classList.remove('active'); });
                el.classList.add('active');
                nbState.activeSectionId = eid;
                showPreview(entry.entry_id, entry.title, entry.content);
                setTimeout(function () {
                    var sec = document.getElementById('nb-preview-section-' + eid);
                    if (sec && $nbPreviewBody) {
                        sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
                        sec.classList.add('nb-section-flash');
                        setTimeout(function () { sec.classList.remove('nb-section-flash'); }, 1600);
                    }
                }, 80);
            });
        });
    }

    function renderDifficultyDots(diff) {
        var s = '';
        for (var i = 1; i <= 5; i++) {
            s += '<i class="' + (i <= diff ? 'on' : '') + '"></i>';
        }
        return s;
    }
    function findZoneById(zones, zid) {
        for (var i = 0; i < zones.length; i++) if (zones[i].zone_id === zid) return zones[i];
        return null;
    }
    function cssEscape(s) { return String(s || '').replace(/"/g, '\\"'); }

    // Round 6: fallback — 保留原有的"来源分组"渲染作为 outline_ready=false 时的兜底
    function renderLegacyOutlineTree(outline) {
        if (!outline) outline = nbState.outline;
        if (!outline) {
            // 空提示：引导用户触发"重构学习路径"
            $nbEntriesList.innerHTML =
                '<div class="nb-learn-empty">' +
                    '<strong>还没有规划学习路径</strong>' +
                    '<p>点击下方的"重构学习路径"，让 AI 把当前笔记重组为按学习递进展示的知识书。</p>' +
                '</div>';
            if (window.lucide) window.lucide.createIcons();
            return;
        }
        var html = '<div class="nb-outline">';
        (outline.zones || []).forEach(function (zone, zi) {
            var pageRange = zone.page_range || [null, null];
            var pageLabel = '';
            if (pageRange[0] != null && pageRange[1] != null) {
                pageLabel = pageRange[0] === pageRange[1]
                    ? ('p' + (pageRange[0] + 1))
                    : ('p' + (pageRange[0] + 1) + '-' + (pageRange[1] + 1));
            }
            var title = zone.doc_title || '其它';
            var icon = zone.session_id ? 'file-text' : 'inbox';
            html += '<div class="nb-zone" data-zone-idx="' + zi + '">' +
                '<div class="nb-zone-header">' +
                    '<i data-lucide="chevron-down" class="nb-zone-caret"></i>' +
                    '<i data-lucide="' + icon + '" class="nb-zone-icon"></i>' +
                    '<span class="nb-zone-title">' + escapeHtml(title) + '</span>' +
                    '<span class="nb-zone-meta">' + (zone.entry_count || 0) + (pageLabel ? ' · ' + pageLabel : '') + '</span>' +
                '</div>' +
                '<div class="nb-zone-body">';
            (zone.roots || []).forEach(function (root) { html += renderOutlineRoot(root); });
            (zone.orphan_children || []).forEach(function (orph) { html += renderOutlineItem(orph, true); });
            html += '</div></div>';
        });
        html += '</div>';
        $nbEntriesList.innerHTML = html;
        if (window.lucide) window.lucide.createIcons();
        $nbEntriesList.querySelectorAll('.nb-zone-header').forEach(function (h) {
            h.addEventListener('click', function () { h.parentElement.classList.toggle('collapsed'); });
        });
        $nbEntriesList.querySelectorAll('.nb-outline-item').forEach(function (el) {
            el.addEventListener('click', function (ev) {
                ev.stopPropagation();
                var entryId = el.getAttribute('data-entry-id');
                var entry = findEntryById(entryId);
                if (!entry) return;
                $nbEntriesList.querySelectorAll('.nb-outline-item.active').forEach(function (a) { a.classList.remove('active'); });
                el.classList.add('active');
                nbState.activeSectionId = entryId;
                showPreview(entry.entry_id, entry.title, entry.content);
                setTimeout(function () {
                    var sec = document.getElementById('nb-preview-section-' + entry.entry_id);
                    if (sec && $nbPreviewBody) {
                        sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
                        sec.classList.add('nb-section-flash');
                        setTimeout(function () { sec.classList.remove('nb-section-flash'); }, 1600);
                    }
                }, 80);
            });
        });
    }

    function renderOutlineRoot(root) {
        var entry = root.entry || root;
        var children = root.children || [];
        var s = renderOutlineItem(entry, false);
        children.forEach(function (c) { s += renderOutlineItem(c, true); });
        return s;
    }

    function renderOutlineItem(entry, isChild) {
        var pageStr = '';
        if (typeof entry.source_page_start === 'number') {
            pageStr = entry.source_page_start === entry.source_page_end
                ? ('p' + (entry.source_page_start + 1))
                : ('p' + (entry.source_page_start + 1) + '-' + ((entry.source_page_end || entry.source_page_start) + 1));
        }
        var role = entry.section_role || '';
        var roleIcon = 'circle-dot';
        if (role === 'deep_explain') roleIcon = 'lightbulb';
        else if (role === 'chat_append') roleIcon = 'message-circle';
        else if (role === 'auto_section') roleIcon = 'file-text';
        else if (entry.entry_type === 'ppt_import') roleIcon = 'file-presentation';
        else if (entry.entry_type === 'annotation') roleIcon = 'highlighter';
        var cls = 'nb-outline-item' + (isChild ? ' child' : '') + (entry.entry_id === nbState.activeSectionId ? ' active' : '');
        return '<div class="' + cls + '" data-entry-id="' + entry.entry_id + '">' +
            '<i data-lucide="' + roleIcon + '" class="nb-ol-icon"></i>' +
            '<span class="nb-ol-title">' + escapeHtml(cleanTitle(entry.title)) + '</span>' +
            (pageStr ? '<span class="nb-ol-page">' + pageStr + '</span>' : '') +
        '</div>';
    }

    function findEntryById(entryId) {
        for (var i = 0; i < nbState.entries.length; i++) {
            if (nbState.entries[i].entry_id === entryId) return nbState.entries[i];
        }
        return null;
    }

    function renderEntries() {
        if (!$nbEntriesList) return;
        // Round 2: rich onboarding when no notebook is selected
        if (!nbState.activeNotebookId) {
            $nbEntriesList.innerHTML =
                '<div class="nb-onboarding">' +
                    '<div class="nb-onb-icon"><i data-lucide="library" style="width:28px;height:28px"></i></div>' +
                    '<h3>以笔记本为中心的阅读</h3>' +
                    '<p>这里是你的知识工作台。先在右侧主区选择一个笔记本，或创建你的第一个。</p>' +
                    '<button class="nb-onb-cta" id="nbOnbCreate"><i data-lucide="plus" style="width:14px;height:14px"></i><span>创建第一个笔记本</span></button>' +
                '</div>';
            if (window.lucide) window.lucide.createIcons();
            var ob = document.getElementById('nbOnbCreate');
            if (ob) ob.addEventListener('click', function () {
                nbState.editingNotebookId = null;
                openNotebookModal('新建笔记本', '', '', '#7C5CFC');
            });
            return;
        }

        // Round 2: empty notebook → quick-action tiles
        if (!nbState.entries.length && (!nbState.outline || !nbState.outline.zones || !nbState.outline.zones.length)) {
            var hasSession = !!(window.DocReader && window.DocReader.getState && window.DocReader.getState().sessionId);
            var tilesHtml = '';
            if (hasSession) {
                tilesHtml +=
                    '<button class="nb-qa-tile" id="nbQaCurrent">' +
                        '<div class="nb-qa-icon"><i data-lucide="file-plus-2" style="width:16px;height:16px"></i></div>' +
                        '<div class="nb-qa-title">当前页生成</div>' +
                        '<div class="nb-qa-desc">AI 为当前页创建一个节点</div>' +
                    '</button>' +
                    '<button class="nb-qa-tile" id="nbQaRange">' +
                        '<div class="nb-qa-icon"><i data-lucide="book-copy" style="width:16px;height:16px"></i></div>' +
                        '<div class="nb-qa-title">页范围生成</div>' +
                        '<div class="nb-qa-desc">指定页码范围,批量生成</div>' +
                    '</button>';
            }
            tilesHtml +=
                '<button class="nb-qa-tile" id="nbQaImport">' +
                    '<div class="nb-qa-icon"><i data-lucide="file-presentation" style="width:16px;height:16px"></i></div>' +
                    '<div class="nb-qa-title">导入 PPT</div>' +
                    '<div class="nb-qa-desc">将 PPT 转为长笔记</div>' +
                '</button>' +
                '<button class="nb-qa-tile" id="nbQaAnnotate">' +
                    '<div class="nb-qa-icon"><i data-lucide="highlighter" style="width:16px;height:16px"></i></div>' +
                    '<div class="nb-qa-title">文本标注</div>' +
                    '<div class="nb-qa-desc">粘贴任意文本,AI 联动解析</div>' +
                '</button>';
            $nbEntriesList.innerHTML =
                '<div class="nb-onboarding" style="padding:18px 12px;gap:6px;">' +
                    '<div class="nb-onb-icon"><i data-lucide="sparkles" style="width:28px;height:28px"></i></div>' +
                    '<h3>笔记本还是空的</h3>' +
                    '<p>从当前文档生成一些节点,或手动添加。</p>' +
                '</div>' +
                '<div class="nb-quickactions' + (hasSession ? '' : ' full') + '">' + tilesHtml + '</div>';
            if (window.lucide) window.lucide.createIcons();
            var qaC = document.getElementById('nbQaCurrent');
            if (qaC) qaC.addEventListener('click', function () { var b = document.getElementById('quickGenCurrentBtn'); if (b) b.click(); });
            var qaR = document.getElementById('nbQaRange');
            if (qaR) qaR.addEventListener('click', function () { var b = document.getElementById('quickGenRangeBtn'); if (b) b.click(); });
            var qaI = document.getElementById('nbQaImport');
            if (qaI) qaI.addEventListener('click', function () { var b = document.getElementById('nbImportPptBtn'); if (b) b.click(); });
            var qaA = document.getElementById('nbQaAnnotate');
            if (qaA) qaA.addEventListener('click', function () { var b = document.getElementById('nbAnnotateBtn'); if (b) b.click(); });
            return;
        }

        // Round 2: zone-grouped outline tree from notebook_get_outline
        if (nbState.outline && nbState.outline.zones && nbState.outline.zones.length) {
            renderOutlineTree(nbState.outline);
            return;
        }

        // Fallback: flat card list (legacy)
        $nbEntriesList.innerHTML = '';
        nbState.entries.forEach(function (entry) {
            var card = document.createElement('div');
            card.className = 'nb-entry-card' + (entry.entry_id === nbState.previewEntryId ? ' active' : '');
            card.dataset.entryId = entry.entry_id;

            var badgeClass = '';
            var badgeText = '笔记';
            if (entry.entry_type === 'ppt_import') { badgeClass = ' ppt'; badgeText = 'PPT'; }
            else if (entry.entry_type === 'annotation') { badgeClass = ' annotation'; badgeText = '标注'; }
            else if (entry.entry_type === 'ai_note') { badgeText = 'AI'; }
            else if (entry.entry_type === 'page_range') { badgeClass = ' ppt'; badgeText = '选页'; }
            else if (entry.entry_type === 'text_select') { badgeClass = ' annotation'; badgeText = '选文'; }

            var snippet = (entry.content || '').replace(/[#*>\-_`\[\]()]/g, '').substring(0, 100).trim();

            card.innerHTML =
                '<div class="nb-entry-card-top">' +
                    '<span class="nb-entry-title">' + escapeHtml(entry.title || '无标题') + '</span>' +
                    '<span class="nb-entry-badge' + badgeClass + '">' + badgeText + '</span>' +
                '</div>' +
                '<div class="nb-entry-snippet">' + escapeHtml(snippet) + '</div>' +
                '<div class="nb-entry-meta">' +
                    '<span class="nb-entry-time">' + formatTime(entry.updated_at) + '</span>' +
                    '<div class="nb-entry-actions">' +
                        '<button data-action="delete" title="删除"><i data-lucide="trash-2" style="width:12px;height:12px"></i></button>' +
                    '</div>' +
                '</div>';

            // Click to preview
            card.addEventListener('click', function (e) {
                // Don't trigger preview if clicking delete button
                if (e.target.closest('[data-action="delete"]')) return;
                showPreview(entry.entry_id, entry.title, entry.content);
                // Update active state in entries list
                $nbEntriesList.querySelectorAll('.nb-entry-card').forEach(function (c) { c.classList.remove('active'); });
                card.classList.add('active');
            });

            // Delete action
            var delBtn = card.querySelector('[data-action="delete"]');
            if (delBtn) {
                delBtn.addEventListener('click', function (e) {
                    e.stopPropagation();
                    if (!confirm('确定删除此笔记条目？')) return;
                    invoke('notebook_delete_entry', { entryId: entry.entry_id })
                        .then(function () {
                            if (nbState.previewEntryId === entry.entry_id) hidePreview();
                            loadNotebookEntries(nbState.activeNotebookId);
                        })
                        .catch(function (err) { console.error('删除条目失败:', err); });
                });
            }

            $nbEntriesList.appendChild(card);
        });

        if (window.lucide) window.lucide.createIcons();
    }

    // ── Preview panel ────────────────────────────────────────────────────────
    // Round 3: The workspace is always visible. "showPreview" renders all entries and scrolls
    // to the requested one; "hidePreview" just shows a friendly empty state in the main pane.
    function renderPreviewEmptyState(msg) {
        if (!$nbPreviewBody) return;
        var drState = window.DocReader && window.DocReader.getState ? window.DocReader.getState() : null;
        var hasSession = !!(drState && drState.sessionId);
        var hasNotebook = !!nbState.activeNotebookId;
        var safeMsg2 = escapeHtml(msg || (hasNotebook
            ? '当前笔记本还没有内容，可以从当前页面直接开始生成。'
            : '先选择一个笔记本，再开始围绕当前文档整理知识。'));
        var html2 =
            '<div class="nb-main-empty">' +
                '<div class="nb-main-empty-icon"><i data-lucide="book-open" style="width:28px;height:28px"></i></div>' +
                '<h3>' + (hasNotebook ? '开始记录' : '选择笔记本') + '</h3>' +
                '<p>' + safeMsg2 + '</p>';
        if (!hasNotebook) {
            html2 += '<div class="nb-notebook-chooser">';
            if (nbState.notebooks && nbState.notebooks.length) {
                html2 += '<div class="nb-notebook-chooser-list">';
                nbState.notebooks.forEach(function (nb) {
                    var count = typeof nb.entry_count === 'number' ? (nb.entry_count + ' 条') : '0 条';
                    var updated = nb.updated_at ? formatPickerTime(nb.updated_at) : '';
                    var meta = [count, updated].filter(Boolean).join(' · ');
                    html2 +=
                        '<button type="button" class="nb-notebook-choice" data-empty-notebook="' + nb.notebook_id + '">' +
                            '<span class="nb-notebook-choice-dot" style="background:' + escapeHtml(nb.color || '#7C5CFC') + ';"></span>' +
                            '<span class="nb-notebook-choice-main">' +
                                '<span class="nb-notebook-choice-name">' + escapeHtml(nb.name || '未命名笔记本') + '</span>' +
                                '<span class="nb-notebook-choice-meta">' + escapeHtml(meta || '立即进入') + '</span>' +
                            '</span>' +
                            '<span class="nb-notebook-choice-enter"><i data-lucide="arrow-right" style="width:14px;height:14px"></i></span>' +
                        '</button>';
                });
                html2 += '</div>';
            }
            html2 += '<div class="nb-main-empty-actions">';
            html2 += '<button class="primary" type="button" data-empty-act="create"><i data-lucide="plus" style="width:14px;height:14px"></i><span>' + (nbState.notebooks.length ? '新建笔记本' : '创建第一个笔记本') + '</span></button>';
            html2 += '</div></div>';
        } else {
            html2 += '<div class="nb-main-empty-actions">';
            if (hasSession) {
                html2 += '<button class="primary" type="button" data-empty-act="generate-current"><i data-lucide="sparkles" style="width:14px;height:14px"></i><span>生成当前页笔记</span></button>';
            }
            html2 += '<button type="button" data-empty-act="exit-notebook"><i data-lucide="chevrons-left" style="width:14px;height:14px"></i><span>返回笔记本选择</span></button>';
            html2 += '</div>';
        }
        html2 += '</div>';
        $nbPreviewBody.innerHTML = html2;
        updatePreviewShell();
        if (window.lucide) window.lucide.createIcons();
        $nbPreviewBody.querySelectorAll('[data-empty-notebook]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var id = btn.getAttribute('data-empty-notebook');
                if (id) pickActiveNotebook(id);
            });
        });
        $nbPreviewBody.querySelectorAll('[data-empty-act]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var act = btn.getAttribute('data-empty-act');
                if (act === 'create') {
                    nbState.editingNotebookId = null;
                    openNotebookModal('新建笔记本', '', '', '#7C5CFC');
                    return;
                }
                if (act === 'generate-current') {
                    var quickBtn = document.getElementById('quickGenCurrentBtn');
                    if (quickBtn) quickBtn.click();
                    return;
                }
                if (act === 'exit-notebook') {
                    exitActiveNotebook();
                }
            });
        });
    }

    function showPreview(entryId, title, content) {
        nbState.previewEntryId = entryId;
        if ($nbPreviewTitle) $nbPreviewTitle.textContent = '笔记工作台';
        updatePreviewShell();

        var html = '';
        var learn = nbState.learningOutline;
        var useBook = !!(learn && learn.outline_ready && learn.outline && learn.entries_by_zone);

        if (useBook) {
            html = renderBookView(learn, entryId);
        } else {
            nbState.entries.forEach(function (entry) {
                html += renderSectionHtml(entry, entry.entry_id === entryId);
            });
        }

        if (!html) {
            renderPreviewEmptyState('当前笔记本还没有节点。从左侧侧边栏或工具栏开始生成。');
            return;
        }
        $nbPreviewBody.innerHTML = html;
        $nbPreviewBody.classList.add('markdown-body');

        // Post-process each section markdown
        $nbPreviewBody.querySelectorAll('.nb-preview-section .markdown-body').forEach(function (el) {
            postProcessMarkdown(el);
        });

        // Attach per-section event handlers
        $nbPreviewBody.querySelectorAll('.nb-preview-section').forEach(function (sec) {
            attachSectionHandlers(sec);
        });

        // 绑定 book-view 交互（zone prereq 跳转 / recap 展开 / link 跳转）
        if (useBook) bindBookViewInteractions();

        bindAnnotateBubble();
        if (window.lucide) window.lucide.createIcons();

        // Scroll to the clicked entry
        var activeSection = document.getElementById('nb-preview-active');
        if (activeSection) {
            setTimeout(function () {
                activeSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }, 50);
        }
    }

    // ── Book-style view: 章节化渲染（zone 导读 + sections + 区末回顾） ──
    function renderBookView(learn, activeEntryId) {
        var outline = learn.outline || {};
        var zones = Array.isArray(outline.zones) ? outline.zones : [];
        var entriesByZone = learn.entries_by_zone || {};
        var allEntries = learn.all_entries || nbState.entries || [];
        var byId = {};
        allEntries.forEach(function (e) { byId[e.entry_id] = e; });

        var html = '';

        // 顶部：核心论点 + 学习路径
        if (outline.thesis) {
            html += '<div class="nb-book-thesis">' +
                '<div class="nb-book-thesis-label"><i data-lucide="book-open"></i> 这本笔记讲什么</div>' +
                '<div class="nb-book-thesis-text">' + escapeHtml(outline.thesis) + '</div>';
            if (Array.isArray(outline.learning_path) && outline.learning_path.length) {
                html += '<div class="nb-book-path">';
                outline.learning_path.forEach(function (step, i) {
                    html += '<span class="nb-book-path-step">' + (i + 1) + '. ' + escapeHtml(String(step)) + '</span>';
                });
                html += '</div>';
            }
            html += '</div>';
        }

        // 按 zone 顺序渲染章节
        var zoneTitleById = {};
        zones.forEach(function (z) { zoneTitleById[z.zone_id] = z.title || z.zone_id; });

        zones.forEach(function (zone, zIdx) {
            var zoneEntries = entriesByZone[zone.zone_id] || [];
            html += '<div class="nb-book-zone" data-zone-id="' + escapeHtml(zone.zone_id) + '" id="nb-book-zone-' + escapeHtml(zone.zone_id) + '">';
            // Zone 导读卡
            html += '<div class="nb-book-zone-intro">';
            html += '<div class="nb-book-zone-title"><span class="nb-book-zone-num">第 ' + (zIdx + 1) + ' 区</span>' + escapeHtml(zone.title || '') + '</div>';
            if (zone.summary) html += '<div class="nb-book-zone-summary">' + escapeHtml(zone.summary) + '</div>';
            if (zone.learning_goal) html += '<div class="nb-book-zone-goal"><i data-lucide="target"></i> 学习目标：' + escapeHtml(zone.learning_goal) + '</div>';
            var prereqs = Array.isArray(zone.prerequisite_zone_ids) ? zone.prerequisite_zone_ids.filter(function (pid) { return zoneTitleById[pid]; }) : [];
            if (prereqs.length) {
                html += '<div class="nb-book-zone-prereq">前置：';
                prereqs.forEach(function (pid) {
                    html += '<span class="nb-book-zone-prereq-chip" data-jump-zone="' + escapeHtml(pid) + '">' + escapeHtml(zoneTitleById[pid]) + '</span>';
                });
                html += '</div>';
            }
            html += '</div>';

            // Sections
            if (!zoneEntries.length) {
                html += '<div class="nb-book-zone-empty">本区暂无 section。</div>';
            } else {
                zoneEntries.forEach(function (e) {
                    html += renderSectionHtml(e, e.entry_id === activeEntryId);
                });
            }

            // 区末回顾
            var recap = Array.isArray(zone.recap_questions) ? zone.recap_questions : [];
            if (recap.length) {
                html += '<div class="nb-book-recap"><div class="nb-book-recap-title"><i data-lucide="help-circle"></i> 本区回顾</div>';
                recap.forEach(function (r, i) {
                    var q = (r && r.q) ? r.q : '';
                    var hint = (r && r.hint) ? r.hint : '';
                    if (!q) return;
                    html += '<div class="nb-book-recap-item">' +
                        '<div class="nb-book-recap-q">Q' + (i + 1) + '. ' + escapeHtml(q) + '</div>' +
                        (hint ? '<button class="nb-book-recap-toggle" data-action="toggle-hint" type="button">查看思路</button>' +
                            '<div class="nb-book-recap-hint" style="display:none;">' + escapeHtml(hint) + '</div>' : '') +
                    '</div>';
                });
                html += '</div>';
            }

            html += '</div>'; // /.nb-book-zone
        });

        // 未分区 fallback：以 all_entries 为准，凡不在有效 zone 内的一律列为"待归入"。
        // 修复：新生成的条目 zone_id == "" 以前会被丢掉，这里造一个完整补集。
        var validZoneIdsBV = {};
        zones.forEach(function (z) { if (z && z.zone_id) validZoneIdsBV[z.zone_id] = true; });
        var unassigned = (allEntries || []).filter(function (e) {
            var zid = e && e.zone_id;
            return !zid || !validZoneIdsBV[zid];
        });
        unassigned.sort(function (a, b) {
            return (a.zone_order || 0) - (b.zone_order || 0)
                || String(a.created_at || '').localeCompare(String(b.created_at || ''));
        });
        if (unassigned.length) {
            html += '<div class="nb-book-zone" data-zone-id="__unassigned__">';
            html += '<div class="nb-book-zone-intro"><div class="nb-book-zone-title">待归入</div><div class="nb-book-zone-summary">以下 section 尚未归入任何学习区，可重新执行"重构学习路径"。</div></div>';
            unassigned.forEach(function (e) {
                html += renderSectionHtml(e, e.entry_id === activeEntryId);
            });
            html += '</div>';
        }

        return html;
    }

    function bindBookViewInteractions() {
        // 跳转到 zone
        $nbPreviewBody.querySelectorAll('[data-jump-zone]').forEach(function (el) {
            el.addEventListener('click', function () {
                var zid = el.getAttribute('data-jump-zone');
                var target = document.getElementById('nb-book-zone-' + zid);
                if (target) {
                    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    target.classList.add('nb-book-zone-flash');
                    setTimeout(function () { target.classList.remove('nb-book-zone-flash'); }, 1500);
                }
            });
        });
        // 跨节链接跳转
        $nbPreviewBody.querySelectorAll('[data-jump-entry]').forEach(function (el) {
            el.addEventListener('click', function () {
                var eid = el.getAttribute('data-jump-entry');
                var target = document.getElementById('nb-sec-' + eid);
                if (target) {
                    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    target.classList.add('nb-section-flash');
                    setTimeout(function () { target.classList.remove('nb-section-flash'); }, 1500);
                }
            });
        });
        // 回顾题 hint 展开
        $nbPreviewBody.querySelectorAll('[data-action="toggle-hint"]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var hint = btn.parentElement.querySelector('.nb-book-recap-hint');
                if (!hint) return;
                var show = hint.style.display === 'none';
                hint.style.display = show ? 'block' : 'none';
                btn.textContent = show ? '收起' : '查看思路';
            });
        });
    }

    // 把一条 entry 渲染成 <section> HTML（Round 3: 干净标题 + 金属徽章行，替代 emoji 内联）
    function renderSectionHtml(entry, isActive) {
        var role = entry.section_role || 'root_note';
        var learningRole = entry.learning_role || '';

        // ── Metadata chips (replace inline emoji badges) ────────────────────
        var chips = [];
        var compactMetaParts = [];
        if (entry.source_page_start != null && entry.source_page_start !== undefined) {
            var s = entry.source_page_start, e = entry.source_page_end;
            var pageLabel = (s === e || e == null) ? ('P. ' + ((s|0) + 1)) : ('P. ' + ((s|0) + 1) + '–' + ((e|0) + 1));
            compactMetaParts.push(pageLabel);
        }
        if (role === 'deep_explain') {
            chips.push('<span class="nb-chip nb-chip-role-deep">追加讲解</span>');
        } else if (role === 'chat_append') {
            chips.push('<span class="nb-chip nb-chip-role-chat">问答补充</span>');
        } else if (role === 'auto_section') {
            chips.push('<span class="nb-chip nb-chip-role-auto">自动节</span>');
        }
        if (entry.entry_type === 'ppt_import') {
            chips.push('<span class="nb-chip nb-chip-role-auto">PPT 导入</span>');
        } else if (entry.entry_type === 'annotation' || entry.entry_type === 'text_select') {
            chips.push('<span class="nb-chip nb-chip-role-auto">标注</span>');
        }
        if (entry.source_info) compactMetaParts.push('来源 · ' + entry.source_info);
        var chipsHtml = chips.length ? '<div class="nb-section-chips">' + chips.join('') + '</div>' : '';
        var compactMeta = compactMetaParts.length
            ? '<span class="nb-section-submeta" title="' + escapeHtml(compactMetaParts.join(' · ')) + '">' + escapeHtml(compactMetaParts.join(' · ')) + '</span>'
            : '';

        // Learning role banner（替代主预览的顶部标签）
        var roleBanner = '';
        if (learningRole && LEARN_ROLE_LABELS[learningRole]) {
            var ic = LEARN_ROLE_ICONS[learningRole] || 'circle-dot';
            roleBanner = '<div class="nb-section-role-banner nb-section-role-' + learningRole + '">' +
                '<i data-lucide="' + ic + '"></i>' + escapeHtml(LEARN_ROLE_LABELS[learningRole]) +
                (entry.difficulty ? ' · 难度 ' + entry.difficulty : '') +
            '</div>';
        }

        // 跨节关联：从学习大纲 links 中拿到本 entry 的出/入边
        var linksHtml = renderSectionLinksHtml(entry.entry_id);

        // 嵌入式聊天的历史预渲染
        var historyArr = [];
        if (entry.chat_history_json) {
            try { historyArr = JSON.parse(entry.chat_history_json) || []; } catch (e) { historyArr = []; }
        }
        var chatMsgsHtml = historyArr.map(function (m, idx) {
            var isUser = m.role === 'user';
            var safeRaw = escapeHtml(m.content || '');
            var bodyHtml = isUser
                ? '<div class="nb-chat-bubble">' + safeRaw + '</div>'
                : '<div class="nb-chat-bubble"><div class="markdown-body nb-chat-md">' + renderMarkdown(m.content || '') + '</div></div>'
                  + '<div class="nb-chat-msg-actions">'
                    + '<button data-msg-action="copy" title="复制"><i data-lucide="copy" style="width:11px;height:11px"></i><span>复制</span></button>'
                    + '<button data-msg-action="append" title="追加到本节笔记"><i data-lucide="arrow-down-to-line" style="width:11px;height:11px"></i><span>追加</span></button>'
                    + '<button data-msg-action="replace" title="替换本节笔记内容"><i data-lucide="replace" style="width:11px;height:11px"></i><span>替换</span></button>'
                    + '<button data-msg-action="spawn" title="为这段回答新建子 section"><i data-lucide="git-branch-plus" style="width:11px;height:11px"></i><span>新建子节</span></button>'
                  + '</div>';
            var avatar = isUser
                ? '<div class="nb-chat-avatar user-avatar">你</div>'
                : '<div class="nb-chat-avatar ai-avatar"><i data-lucide="sparkles" style="width:12px;height:12px"></i></div>';
            return '<div class="nb-chat-msg ' + (isUser ? 'user' : 'assistant') + '" data-msg-idx="' + idx + '" data-raw="' + escapeHtml(m.content || '') + '">'
                + avatar
                + '<div class="nb-chat-msg-main">' + bodyHtml + '</div>'
                + '</div>';
        }).join('');

        var sectionId = 'nb-sec-' + entry.entry_id;
        var titleText = cleanTitle(entry.title);

        return '<section class="nb-preview-section' + (isActive ? ' nb-section-active' : '') + '" data-entry-id="' + entry.entry_id +
            '" data-page-start="' + (entry.source_page_start == null ? '' : entry.source_page_start) +
            '" data-page-end="' + (entry.source_page_end == null ? '' : entry.source_page_end) +
            '" data-session-id="' + escapeHtml(entry.source_session_id || '') +
            '" data-role="' + role +
            '" data-learning-role="' + escapeHtml(learningRole) +
            '" id="' + sectionId + '">' +
            (isActive ? '<span id="nb-preview-active" style="display:block;height:0;"></span>' : '') +
            roleBanner +
            '<div class="nb-section-title-row">' +
                '<h2 class="nb-section-title" contenteditable="true" spellcheck="false" data-field="title" data-entry-id="' + entry.entry_id + '">' + escapeHtml(titleText) + '</h2>' +
                compactMeta +
                '<span class="nb-section-saving" data-entry-id="' + entry.entry_id + '" style="display:none;"><span class="spinner"></span>保存中</span>' +
            '</div>' +
            chipsHtml +
            '<div class="nb-section-toolbar">' +
                (role !== 'deep_explain' ?
                    '<button data-action="append-explanation" title="让 AI 再深入讲一层"><i data-lucide="sparkles" style="width:12px;height:12px"></i>追加讲解</button>'
                    : '') +
                '<button data-action="toggle-chat" title="在这段笔记下和 AI 聊"><i data-lucide="message-circle" style="width:12px;height:12px"></i>嵌入问答</button>' +
                '<button data-action="delete-entry" title="删除本 section" style="margin-left:auto;"><i data-lucide="trash-2" style="width:12px;height:12px"></i></button>' +
            '</div>' +
            '<div class="markdown-body" contenteditable="true" spellcheck="false" data-field="content" data-entry-id="' + entry.entry_id + '" data-raw="' + escapeHtml(entry.content || '') + '" style="padding:4px 0 16px;">' +
                renderMarkdown(entry.content || '') +
            '</div>' +
            linksHtml +
            '<div class="nb-section-chat ' + (historyArr.length === 0 ? 'collapsed' : '') + '" data-entry-id="' + entry.entry_id + '">' +
                '<div class="nb-section-chat-body">' +
                    '<div class="nb-chat-head">' +
                        '<i data-lucide="sparkles" style="width:12px;height:12px;color:var(--primary)"></i>' +
                        '<span class="nb-chat-head-title">AI 助手 · 基于本节内容</span>' +
                        '<button class="nb-chat-head-btn" data-action="clear-chat" title="清空对话历史"><i data-lucide="eraser" style="width:11px;height:11px"></i></button>' +
                    '</div>' +
                    '<div class="nb-chat-msgs">' + chatMsgsHtml + '</div>' +
                    '<div class="nb-chat-quick">' +
                        '<button data-quick="summary" title="把本节凝练成 3-5 行要点">📌 摘要</button>' +
                        '<button data-quick="quiz" title="围绕本节出 3 道自测题">🎯 出题</button>' +
                        '<button data-quick="example" title="给一个生活化的例子">💡 举例</button>' +
                        '<button data-quick="simplify" title="用更直白的话重写">✂️ 简化</button>' +
                        '<button data-quick="critique" title="找出本节的薄弱点 / 易错点">🔍 反思</button>' +
                    '</div>' +
                    '<div class="nb-chat-input-row">' +
                        '<textarea placeholder="问问题或输入命令：/append 追加内容  /replace 重写本节  /new 派生子节" rows="1"></textarea>' +
                        '<button data-action="send-chat" title="发送 (Enter)"><i data-lucide="send" style="width:13px;height:13px"></i></button>' +
                    '</div>' +
                    '<div class="nb-chat-hint">回答后可点 <b>追加</b>/<b>替换</b>/<b>新建子节</b> 直接落入笔记 · /append /replace /new 让 AI 直接写</div>' +
                '</div>' +
            '</div>' +
        '</section>';
    }

    // Round 6: 根据学习大纲 links，渲染当前 entry 的"跨节关联"面板
    var LINK_KIND_LABELS = { cause: '因果', compare: '对比', extend: '延伸', example: '举例', common_mistake: '易错' };
    function renderSectionLinksHtml(entryId) {
        var learn = nbState.learningOutline;
        if (!learn || !learn.outline) return '';
        var links = learn.outline.links || [];
        if (!links.length) return '';
        var out = [], inn = [];
        var byId = {};
        (learn.all_entries || nbState.entries || []).forEach(function (e) { byId[e.entry_id] = e; });
        links.forEach(function (l) {
            if (!l) return;
            if (l.from === entryId && byId[l.to]) {
                out.push({ kind: l.kind || 'extend', note: l.note || '', entry: byId[l.to] });
            } else if (l.to === entryId && byId[l.from]) {
                inn.push({ kind: l.kind || 'extend', note: l.note || '', entry: byId[l.from] });
            }
        });
        if (!out.length && !inn.length) return '';
        var html = '<div class="nb-section-links">';
        html += '<div class="nb-section-links-title">与其它 section 的关联</div>';
        out.forEach(function (l) {
            html += '<div class="nb-section-link" data-jump-entry="' + escapeHtml(l.entry.entry_id) + '">' +
                '<span class="nb-section-link-kind ' + escapeHtml(l.kind) + '">' + escapeHtml(LINK_KIND_LABELS[l.kind] || l.kind) + ' →</span>' +
                '<span class="nb-section-link-target">' + escapeHtml(cleanTitle(l.entry.title || '')) + '</span>' +
                (l.note ? '<span class="nb-section-link-note">· ' + escapeHtml(l.note) + '</span>' : '') +
            '</div>';
        });
        inn.forEach(function (l) {
            html += '<div class="nb-section-link" data-jump-entry="' + escapeHtml(l.entry.entry_id) + '">' +
                '<span class="nb-section-link-kind ' + escapeHtml(l.kind) + '">← ' + escapeHtml(LINK_KIND_LABELS[l.kind] || l.kind) + '</span>' +
                '<span class="nb-section-link-target">' + escapeHtml(cleanTitle(l.entry.title || '')) + '</span>' +
                (l.note ? '<span class="nb-section-link-note">· ' + escapeHtml(l.note) + '</span>' : '') +
            '</div>';
        });
        html += '</div>';
        return html;
    }

    function attachSectionHandlers(sec) {
        var entryId = sec.dataset.entryId;

        var appendBtn = sec.querySelector('[data-action="append-explanation"]');
        if (appendBtn) appendBtn.addEventListener('click', function () {
            var hint = prompt('想要重点讲解的角度？（可留空让 AI 自由发挥）', '') || '';
            appendBtn.disabled = true;
            var origHtml = appendBtn.innerHTML;
            appendBtn.innerHTML = '生成中…';
            beginGeneratingIndicator('nbSectionIndicator', 'AI 正在追加讲解...');
            invoke('notebook_append_explanation', {
                parentEntryId: entryId,
                userHint: hint.trim() || null,
            }).catch(function (err) {
                console.error('追加讲解失败:', err);
                alert('追加讲解失败：' + String(err));
                endGeneratingIndicator('nbSectionIndicator');
            }).finally(function () {
                // 事件 notebook-section-generated 到达时会自动刷新；如失败也复位按钮
                setTimeout(function () { appendBtn.disabled = false; appendBtn.innerHTML = origHtml; if (window.lucide) window.lucide.createIcons(); }, 3000);
            });
        });

        var toggleChatBtn = sec.querySelector('[data-action="toggle-chat"]');
        var chatPanel = sec.querySelector('.nb-section-chat');
        if (toggleChatBtn && chatPanel) toggleChatBtn.addEventListener('click', function () {
            chatPanel.classList.toggle('collapsed');
            if (!chatPanel.classList.contains('collapsed')) {
                var ta = chatPanel.querySelector('textarea');
                if (ta) ta.focus();
            }
        });

        var delBtn = sec.querySelector('[data-action="delete-entry"]');
        if (delBtn) delBtn.addEventListener('click', function () {
            if (!confirm('删除本 section？')) return;
            invoke('notebook_delete_entry', { entryId: entryId }).then(function () {
                loadNotebookEntries(nbState.activeNotebookId);
            }).catch(function (err) { alert('删除失败：' + String(err)); });
        });

        var sendBtn = sec.querySelector('[data-action="send-chat"]');
        var ta = sec.querySelector('.nb-chat-input-row textarea');
        var msgsBox = sec.querySelector('.nb-chat-msgs');

        // 文本域自适应高度
        if (ta) {
            ta.addEventListener('input', function () {
                ta.style.height = 'auto';
                ta.style.height = Math.min(140, ta.scrollHeight) + 'px';
            });
        }

        // ── Round 6: 快捷提示词
        var QUICK_PROMPTS = {
            summary:  '请把本节凝练为 3–5 行的核心要点，使用项目符号列表。',
            quiz:     '围绕本节内容出 3 道自测题（含 1 道概念题、1 道应用题、1 道易错题），每题给参考答案。',
            example: '请用一个生活化或工程化的具体例子来说明本节的核心概念，例子要贴近现实。',
            simplify: '用更直白的语言把本节内容重写一遍，目标是没有相关背景的人也能看懂；保留所有关键事实。',
            critique: '指出本节内容里读者最容易卡住或误解的点，并给出修正建议。',
        };

        // ── Round 6: 在助手消息上挂 actions ──
        function bindAssistantActions(msgEl) {
            if (!msgEl || msgEl.dataset.actionsBound === '1') return;
            msgEl.dataset.actionsBound = '1';
            msgEl.querySelectorAll('[data-msg-action]').forEach(function (btn) {
                btn.addEventListener('click', function () {
                    var act = btn.getAttribute('data-msg-action');
                    var raw = msgEl.dataset.raw || '';
                    if (!raw) return;
                    if (act === 'copy') {
                        try { navigator.clipboard.writeText(raw); UIBusy().toast('已复制'); }
                        catch (_) { var t = document.createElement('textarea'); t.value = raw; document.body.appendChild(t); t.select(); document.execCommand('copy'); document.body.removeChild(t); UIBusy().toast('已复制'); }
                        return;
                    }
                    var actionMap = { append: 'append', replace: 'replace', spawn: 'spawn_child' };
                    var backendAction = actionMap[act];
                    if (!backendAction) return;
                    if (act === 'replace' && !confirm('用这段 AI 回答替换当前 section 的全部正文？')) return;
                    btn.disabled = true;
                    UIBusy().push();
                    invoke('notebook_apply_chat_action', {
                        entryId: entryId,
                        action: backendAction,
                        content: raw,
                        title: null,
                    }).then(function () {
                        UIBusy().toast(act === 'append' ? '已追加到笔记'
                            : act === 'replace' ? '已替换笔记内容'
                            : '已新建子 section');
                        // 刷新当前笔记本（确保正文/树重渲染）
                        if (typeof loadNotebookEntries === 'function' && nbState.activeNotebookId) {
                            loadNotebookEntries(nbState.activeNotebookId);
                        }
                    }).catch(function (err) {
                        UIBusy().toast('操作失败：' + String(err).slice(0, 80), 2600, true);
                    }).finally(function () {
                        btn.disabled = false;
                        UIBusy().pop();
                    });
                });
            });
        }

        // 初始化已有历史消息
        msgsBox.querySelectorAll('.nb-chat-msg.assistant').forEach(bindAssistantActions);

        // 清空历史
        var clearBtn = sec.querySelector('[data-action="clear-chat"]');
        if (clearBtn) clearBtn.addEventListener('click', function () {
            if (!confirm('清空本节的对话历史？')) return;
            UIBusy().push();
            invoke('notebook_apply_chat_action', {
                entryId: entryId, action: 'clear_chat', content: '', title: null,
            }).then(function () {
                msgsBox.innerHTML = '';
                UIBusy().toast('已清空对话');
            }).catch(function (err) {
                UIBusy().toast('清空失败：' + String(err).slice(0, 60), 2200, true);
            }).finally(function () { UIBusy().pop(); });
        });

        // 快捷提示词
        sec.querySelectorAll('.nb-chat-quick [data-quick]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var key = btn.getAttribute('data-quick');
                var prompt = QUICK_PROMPTS[key];
                if (!prompt) return;
                ta.value = prompt;
                ta.dispatchEvent(new Event('input'));
                sendChat();
            });
        });

        function appendUserBubble(q) {
            var uDiv = document.createElement('div');
            uDiv.className = 'nb-chat-msg user';
            uDiv.innerHTML = '<div class="nb-chat-avatar user-avatar">你</div>'
                + '<div class="nb-chat-msg-main"><div class="nb-chat-bubble">' + escapeHtml(q) + '</div></div>';
            msgsBox.appendChild(uDiv);
            return uDiv;
        }
        function appendThinkingBubble() {
            var aDiv = document.createElement('div');
            aDiv.className = 'nb-chat-msg assistant';
            aDiv.innerHTML = '<div class="nb-chat-avatar ai-avatar"><i data-lucide="sparkles" style="width:12px;height:12px"></i></div>'
                + '<div class="nb-chat-msg-main"><div class="nb-chat-bubble nb-chat-thinking"><span class="spinner"></span><span>AI 正在思考…</span></div></div>';
            msgsBox.appendChild(aDiv);
            if (window.lucide) { try { window.lucide.createIcons(); } catch (_) {} }
            return aDiv;
        }

        function sendChat() {
            var q = (ta.value || '').trim();
            if (!q) return;

            // /append /replace /new 直接转化为 apply 流程 + AI 写正文
            var slashMatch = q.match(/^\/(append|replace|new)\b\s*(.*)$/i);
            if (slashMatch) {
                var slashAction = slashMatch[1].toLowerCase();
                var instruction = slashMatch[2].trim() || '请基于本节内容补充更深入的内容。';
                var actionLabel = slashAction === 'append' ? '追加到笔记'
                    : slashAction === 'replace' ? '重写本节笔记'
                    : '派生子节';
                var question = '请生成一段可以直接' + actionLabel
                    + '的 Markdown 内容（不要写"以下是..."这类前言，直接是可入笔记的正文）。具体要求：' + instruction;

                ta.value = ''; ta.style.height = 'auto';
                sendBtn.disabled = true; ta.disabled = true;
                appendUserBubble('/' + slashAction + ' ' + instruction);
                var thinkingEl = appendThinkingBubble();
                msgsBox.scrollTop = msgsBox.scrollHeight;
                UIBusy().push();

                invoke('notebook_section_chat', { entryId: entryId, question: question })
                    .then(function (res) {
                        var ans = (res && res.answer) ? res.answer : '';
                        thinkingEl.classList.remove('assistant');
                        thinkingEl.classList.add('assistant');
                        thinkingEl.dataset.raw = ans;
                        thinkingEl.innerHTML = '<div class="nb-chat-avatar ai-avatar"><i data-lucide="sparkles" style="width:12px;height:12px"></i></div>'
                            + '<div class="nb-chat-msg-main">'
                            +   '<div class="nb-chat-bubble"><div class="markdown-body nb-chat-md">' + renderMarkdown(ans) + '</div></div>'
                            +   '<div class="nb-chat-msg-actions">'
                            +     '<button data-msg-action="copy"><i data-lucide="copy" style="width:11px;height:11px"></i><span>复制</span></button>'
                            +     '<button data-msg-action="append"><i data-lucide="arrow-down-to-line" style="width:11px;height:11px"></i><span>追加</span></button>'
                            +     '<button data-msg-action="replace"><i data-lucide="replace" style="width:11px;height:11px"></i><span>替换</span></button>'
                            +     '<button data-msg-action="spawn"><i data-lucide="git-branch-plus" style="width:11px;height:11px"></i><span>新建子节</span></button>'
                            +   '</div>'
                            + '</div>';
                        var mdEl = thinkingEl.querySelector('.markdown-body'); if (mdEl) postProcessMarkdown(mdEl);
                        if (window.lucide) { try { window.lucide.createIcons(); } catch (_) {} }
                        bindAssistantActions(thinkingEl);
                        // 自动落入笔记
                        var backendAction = slashAction === 'append' ? 'append'
                            : slashAction === 'replace' ? 'replace' : 'spawn_child';
                        return invoke('notebook_apply_chat_action', {
                            entryId: entryId, action: backendAction, content: ans, title: null,
                        });
                    })
                    .then(function () {
                        UIBusy().toast('已自动' + actionLabel);
                        if (typeof loadNotebookEntries === 'function' && nbState.activeNotebookId) {
                            loadNotebookEntries(nbState.activeNotebookId);
                        }
                    })
                    .catch(function (err) {
                        thinkingEl.innerHTML = '<div class="nb-chat-avatar ai-avatar">!</div>'
                            + '<div class="nb-chat-msg-main"><div class="nb-chat-bubble" style="color:#E5484D;">错误：' + escapeHtml(String(err)) + '</div></div>';
                    })
                    .finally(function () {
                        sendBtn.disabled = false; ta.disabled = false; ta.focus();
                        UIBusy().pop();
                    });
                return;
            }

            // 普通问答
            ta.value = ''; ta.style.height = 'auto';
            sendBtn.disabled = true; ta.disabled = true;
            appendUserBubble(q);
            var aDiv = appendThinkingBubble();
            msgsBox.scrollTop = msgsBox.scrollHeight;

            invoke('notebook_section_chat', { entryId: entryId, question: q })
                .then(function (res) {
                    var ans = (res && res.answer) ? res.answer : '(空回复)';
                    aDiv.dataset.raw = ans;
                    aDiv.innerHTML = '<div class="nb-chat-avatar ai-avatar"><i data-lucide="sparkles" style="width:12px;height:12px"></i></div>'
                        + '<div class="nb-chat-msg-main">'
                        +   '<div class="nb-chat-bubble"><div class="markdown-body nb-chat-md">' + renderMarkdown(ans) + '</div></div>'
                        +   '<div class="nb-chat-msg-actions">'
                        +     '<button data-msg-action="copy"><i data-lucide="copy" style="width:11px;height:11px"></i><span>复制</span></button>'
                        +     '<button data-msg-action="append"><i data-lucide="arrow-down-to-line" style="width:11px;height:11px"></i><span>追加</span></button>'
                        +     '<button data-msg-action="replace"><i data-lucide="replace" style="width:11px;height:11px"></i><span>替换</span></button>'
                        +     '<button data-msg-action="spawn"><i data-lucide="git-branch-plus" style="width:11px;height:11px"></i><span>新建子节</span></button>'
                        +   '</div>'
                        + '</div>';
                    var mdEl = aDiv.querySelector('.markdown-body'); if (mdEl) postProcessMarkdown(mdEl);
                    if (window.lucide) { try { window.lucide.createIcons(); } catch (_) {} }
                    bindAssistantActions(aDiv);
                    msgsBox.scrollTop = msgsBox.scrollHeight;
                })
                .catch(function (err) {
                    aDiv.innerHTML = '<div class="nb-chat-avatar ai-avatar">!</div>'
                        + '<div class="nb-chat-msg-main"><div class="nb-chat-bubble" style="color:#E5484D;">错误：' + escapeHtml(String(err)) + '</div></div>';
                })
                .finally(function () { sendBtn.disabled = false; ta.disabled = false; ta.focus(); });
        }
        if (sendBtn) sendBtn.addEventListener('click', sendChat);
        if (ta) ta.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
        });

        // ── Round 5: 内联编辑（标题 + 正文），实时渲染+防抖保存 ──
        bindInlineEditing(sec);
    }

    // ── Round 5: 内联编辑 —— 标题直改；正文支持"编辑原始 Markdown / 再渲染"切换 ──
    var _saveTimers = {};
    function bindInlineEditing(sec) {
        var entryId = sec.dataset.entryId;
        var titleEl = sec.querySelector('.nb-section-title[contenteditable]');
        var bodyEl = sec.querySelector('.markdown-body[contenteditable][data-field="content"]');
        var savingEl = sec.querySelector('.nb-section-saving');

        function showSaving(on) { if (savingEl) savingEl.style.display = on ? '' : 'none'; }

        function scheduleSave() {
            if (_saveTimers[entryId]) clearTimeout(_saveTimers[entryId]);
            showSaving(true);
            _saveTimers[entryId] = setTimeout(function () {
                var title = titleEl ? (titleEl.textContent || '').trim() : '';
                var raw = bodyEl ? (bodyEl.dataset.raw != null ? bodyEl.dataset.raw : bodyEl.innerText) : '';
                if (!title) title = '(未命名)';
                invoke('notebook_update_entry', {
                    entryId: entryId,
                    title: title,
                    content: raw,
                }).then(function () {
                    // Sync to nbState cache so we don't refetch
                    for (var i = 0; i < nbState.entries.length; i++) {
                        if (nbState.entries[i].entry_id === entryId) {
                            nbState.entries[i].title = title;
                            nbState.entries[i].content = raw;
                            break;
                        }
                    }
                }).catch(function (err) {
                    console.error('保存笔记失败:', err);
                    UIBusy().toast('笔记保存失败：' + String(err).slice(0, 60), 2600, true);
                }).finally(function () {
                    showSaving(false);
                });
            }, 600);
        }

        if (titleEl) {
            titleEl.addEventListener('input', scheduleSave);
            titleEl.addEventListener('keydown', function (e) {
                if (e.key === 'Enter') { e.preventDefault(); titleEl.blur(); }
            });
        }

        if (bodyEl) {
            // 双击进入"编辑原文"模式（源码 Markdown）；点外部或按 Esc 退出并重渲染。
            bodyEl.addEventListener('dblclick', function () {
                if (bodyEl.dataset.editing === '1') return;
                var raw = bodyEl.dataset.raw || '';
                bodyEl.dataset.editing = '1';
                bodyEl.textContent = raw;
                bodyEl.style.fontFamily = 'var(--font-mono)';
                bodyEl.style.whiteSpace = 'pre-wrap';
                bodyEl.focus();
                // Place caret at end
                try {
                    var sel = window.getSelection();
                    var r = document.createRange();
                    r.selectNodeContents(bodyEl); r.collapse(false);
                    sel.removeAllRanges(); sel.addRange(r);
                } catch (_) { }
            });
            function exitRawMode() {
                if (bodyEl.dataset.editing !== '1') return;
                var raw = bodyEl.innerText;
                bodyEl.dataset.raw = raw;
                bodyEl.dataset.editing = '';
                bodyEl.style.fontFamily = '';
                bodyEl.style.whiteSpace = '';
                bodyEl.innerHTML = renderMarkdown(raw || '');
                try { postProcessMarkdown(bodyEl); } catch (_) { }
            }
            bodyEl.addEventListener('blur', function () {
                if (bodyEl.dataset.editing === '1') {
                    // Save raw then re-render
                    scheduleSave();
                    setTimeout(exitRawMode, 20);
                }
            });
            bodyEl.addEventListener('keydown', function (e) {
                if (e.key === 'Escape' && bodyEl.dataset.editing === '1') {
                    e.preventDefault();
                    scheduleSave();
                    exitRawMode();
                    bodyEl.blur();
                }
            });
            bodyEl.addEventListener('input', function () {
                if (bodyEl.dataset.editing === '1') {
                    bodyEl.dataset.raw = bodyEl.innerText;
                } else {
                    // 渲染后模式下的快速编辑：把当前 DOM 文本当作 raw（简化处理）
                    bodyEl.dataset.raw = bodyEl.innerText;
                }
                scheduleSave();
            });
        }
    }

    // ── Round 5: 笔记区选中文字 → 浮条（高亮 / AI 解释） ────────────────────
    var _annotateBubbleBound = false;
    function bindAnnotateBubble() {
        var bubble = document.getElementById('nbAnnotateBubble');
        if (!bubble || !$nbPreviewBody) return;
        if (_annotateBubbleBound) return;
        _annotateBubbleBound = true;

        var hlBtn = document.getElementById('nbHighlightBtn');
        var explainBtn = document.getElementById('nbExplainBtn');
        var currentRange = null;

        function hideBubble() {
            bubble.classList.remove('visible');
            currentRange = null;
        }

        function pickSelection() {
            var sel = window.getSelection();
            if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
            var r = sel.getRangeAt(0);
            if (!$nbPreviewBody.contains(r.commonAncestorContainer)) return null;
            var txt = sel.toString().trim();
            if (!txt) return null;
            return { range: r, text: txt, rect: r.getBoundingClientRect() };
        }

        document.addEventListener('mouseup', function (e) {
            if (bubble.contains(e.target)) return;
            setTimeout(function () {
                var picked = pickSelection();
                if (!picked) { hideBubble(); return; }
                currentRange = picked.range.cloneRange();
                var r = picked.rect;
                // Render first to measure
                bubble.classList.add('visible');
                var top = window.scrollY + r.top - bubble.offsetHeight - 8;
                var left = window.scrollX + r.left + r.width / 2 - bubble.offsetWidth / 2;
                if (top < 4) top = window.scrollY + r.bottom + 8;
                bubble.style.top = Math.max(4, top) + 'px';
                bubble.style.left = Math.max(4, left) + 'px';
            }, 10);
        });

        document.addEventListener('mousedown', function (e) {
            if (!bubble.contains(e.target)) hideBubble();
        });
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') hideBubble();
        });

        if (hlBtn) hlBtn.addEventListener('click', function () {
            if (!currentRange) return;
            try {
                var span = document.createElement('span');
                span.className = 'nb-hl';
                span.appendChild(currentRange.extractContents());
                currentRange.insertNode(span);
                window.getSelection().removeAllRanges();
                var sec = span.closest('.nb-preview-section');
                if (sec) {
                    var body = sec.querySelector('.markdown-body[contenteditable][data-field="content"]');
                    if (body) {
                        body.dataset.raw = body.innerHTML;
                        body.dispatchEvent(new Event('input', { bubbles: true }));
                    }
                }
                UIBusy().toast('已高亮', 900);
            } catch (err) {
                console.error('高亮失败', err);
            }
            hideBubble();
        });

        if (explainBtn) explainBtn.addEventListener('click', function () {
            if (!currentRange) return;
            var text = currentRange.toString().trim();
            if (!text || !nbState.activeNotebookId) { hideBubble(); return; }
            explainBtn.disabled = true;
            explainBtn.innerHTML = '<span class="spinner"></span><span>分析中…</span>';
            UIBusy().push('AI 正在解释选中文本…');
            var parentEl = currentRange.startContainer.nodeType === 1
                ? currentRange.startContainer
                : currentRange.startContainer.parentElement;
            var sec = parentEl ? parentEl.closest('.nb-preview-section') : null;
            var ctxEl = sec ? sec.querySelector('.markdown-body') : null;
            var ctx = ctxEl ? ctxEl.innerText : '';
            invoke('notebook_annotate_text', {
                notebookId: nbState.activeNotebookId,
                selectedText: text,
                context: ctx ? ctx.slice(0, 2000) : null,
            }).then(function () {
                UIBusy().toast('已提交 AI 解释，生成完成后将自动插入', 2400);
            }).catch(function (err) {
                UIBusy().toast('解释请求失败：' + String(err).slice(0, 60), 2800, true);
            }).finally(function () {
                explainBtn.disabled = false;
                explainBtn.innerHTML = '<i data-lucide="sparkles" style="width:12px;height:12px"></i><span>AI 解释</span>';
                if (window.lucide) { try { window.lucide.createIcons(); } catch (_) {} }
                UIBusy().pop();
                hideBubble();
            });
        });
    }

    // 供 doc_reader.js 在翻页时调用：滚动预览到匹配 page 的 section
    var _lastHighlightedSection = null;
    function onPageChanged(pageIndex) {
        if (!nbState.activeNotebookId) return;
        // Round 3: 工作台常显，无需判断 display
        if (!$nbPreviewBody) return;
        var docState = (window.DocReader && window.DocReader.getState) ? window.DocReader.getState() : null;
        var sessionId = docState ? docState.sessionId : null;
        if (!sessionId) return;
        // 在已渲染 DOM 中查找即可，避免来回 invoke
        var sections = $nbPreviewBody.querySelectorAll('.nb-preview-section');
        var match = null;
        for (var i = 0; i < sections.length; i++) {
            var s = sections[i];
            if (s.dataset.sessionId !== sessionId) continue;
            var ps = s.dataset.pageStart, pe = s.dataset.pageEnd;
            if (ps === '' || ps == null) continue;
            var ni = +pageIndex, nps = +ps, npe = (pe === '' || pe == null) ? nps : +pe;
            if (ni >= nps && ni <= npe) { match = s; break; }
        }
        if (!match) return;
        if (_lastHighlightedSection && _lastHighlightedSection !== match) {
            _lastHighlightedSection.classList.remove('nb-section-active');
        }
        match.classList.add('nb-section-active');
        _lastHighlightedSection = match;
        match.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function showAllPreview() {
        if (!nbState.entries || nbState.entries.length === 0) return;
        showPreview(nbState.entries[0].entry_id, '', '');
    }

    function hidePreview() {
        nbState.previewEntryId = null;
        // Round 3: panel is always visible — replace with empty state instead of display:none
        renderPreviewEmptyState();
        updatePreviewShell();
        if ($nbPreviewTitle) $nbPreviewTitle.textContent = '笔记工作台';
        if ($nbEntriesList) {
            $nbEntriesList.querySelectorAll('.nb-entry-card, .nb-outline-item').forEach(function (c) { c.classList.remove('active'); });
        }
        // Legacy expand/fullscreen cleanup — harmless if stripped CSS
        var tabContent = $nbPreviewPanel && $nbPreviewPanel.closest ? $nbPreviewPanel.closest('.sidebar-tab-content') : null;
        var panelNotes = $nbPreviewPanel && $nbPreviewPanel.closest ? $nbPreviewPanel.closest('.panel-notes') : null;
        if (tabContent) tabContent.classList.remove('preview-expanded');
        if (panelNotes) panelNotes.classList.remove('preview-fullscreen');
    }

    // ── Add current AI note to notebook ──────────────────────────────────────
    function addCurrentNoteToNotebook() {
        if (!nbState.activeNotebookId) {
            alert('请先在「笔记本」标签页中选择或创建一个笔记本');
            return;
        }
        // Access DocReader state
        var drState = window.DocReader && window.DocReader.getState ? window.DocReader.getState() : null;
        if (!drState || !drState.sessionId) {
            alert('请先打开文档');
            return;
        }
        var note = drState.notes[drState.currentPage];
        if (!note || !note.content) {
            alert('当前页面没有笔记可添加');
            return;
        }

        var title = '第 ' + (drState.currentPage + 1) + ' 页笔记 — ' + (drState.title || '文档');
        invoke('notebook_add_entry', {
            notebookId: nbState.activeNotebookId,
            title: title,
            content: note.content,
            entryType: 'ai_note',
            sourceInfo: drState.title + ' · 第 ' + (drState.currentPage + 1) + ' 页',
        }).then(function () {
            loadNotebookEntries(nbState.activeNotebookId);
            // Brief visual feedback
            var btn = document.getElementById('addToNotebookBtn');
            if (btn) {
                btn.style.color = 'var(--secondary)';
                setTimeout(function () { btn.style.color = ''; }, 1000);
            }
        }).catch(function (err) { console.error('添加到笔记本失败:', err); });
    }

    // ── Helpers ──────────────────────────────────────────────────────────────
    /** 解析页码范围字符串，返回 0-indexed 页码数组 */
    function parsePageRangesLocal(rangesStr, pageCount) {
        var indices = [];
        var parts = rangesStr.split(',');
        for (var p = 0; p < parts.length; p++) {
            var part = parts[p].trim();
            if (!part) continue;
            if (part.indexOf('-') !== -1) {
                var bounds = part.split('-');
                var start = parseInt(bounds[0], 10);
                var end = parseInt(bounds[1], 10);
                if (isNaN(start) || isNaN(end) || start < 1 || end < start) continue;
                for (var i = start; i <= Math.min(end, pageCount); i++) {
                    indices.push(i - 1);
                }
            } else {
                var page = parseInt(part, 10);
                if (!isNaN(page) && page >= 1 && page <= pageCount) {
                    indices.push(page - 1);
                }
            }
        }
        return indices;
    }

    /** 从 pdf.js 文档对象中提取指定页码范围的文本 */
    function extractPdfPagesText(pdfDoc, rangesStr, pageCount) {
        var indices = parsePageRangesLocal(rangesStr, pageCount);
        if (indices.length === 0) return Promise.resolve(null);

        var promises = indices.map(function (idx) {
            return pdfDoc.getPage(idx + 1).then(function (page) {
                return page.getTextContent();
            }).then(function (textContent) {
                var text = textContent.items.map(function (item) { return item.str; }).join(' ');
                return { idx: idx, text: text };
            });
        });

        return Promise.all(promises).then(function (results) {
            var combined = '';
            results.forEach(function (r) {
                if (r.text && r.text.trim()) {
                    combined += '\n\n--- 第 ' + (r.idx + 1) + ' 页 ---\n\n' + r.text;
                }
            });
            return combined || null;
        });
    }

    function escapeHtml(str) {
        var div = document.createElement('div');
        div.textContent = str || '';
        return div.innerHTML;
    }

    function renderMarkdown(text) {
        if (window.RenderUtils) return window.RenderUtils.renderMarkdown(text);
        if (!text) return '';
        return '<pre>' + escapeHtml(text) + '</pre>';
    }

    /** Post-process a DOM element: apply KaTeX math + Heti Chinese typography + Lucide icons */
    function postProcessMarkdown(el) {
        if (window.RenderUtils) { window.RenderUtils.postProcessMarkdown(el); return; }
        if (!el) return;
        if (window.renderMathInElement) {
            try {
                renderMathInElement(el, {
                    delimiters: [
                        { left: '$$', right: '$$', display: true },
                        { left: '$', right: '$', display: false },
                        { left: '\\(', right: '\\)', display: false },
                        { left: '\\[', right: '\\]', display: true }
                    ],
                    throwOnError: false
                });
            } catch (e) {}
        }
        if (window.lucide) window.lucide.createIcons();
        if (window.Heti) {
            try { var heti = new Heti('.markdown-body'); heti.spacingElement(el); } catch (e) {}
        }
    }

    function formatTime(str) {
        if (!str) return '';
        try {
            var d = new Date(str);
            return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' }) + ' ' +
                   d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
        } catch (e) { return str; }
    }

    function formatSize(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    // ── Expose ───────────────────────────────────────────────────────────────
    window.NotebookManager = {
        init: init,
        loadNotebooks: loadNotebooks,
        openPicker: openNotebookPicker,
        closePicker: closeNotebookPicker,
        refreshControls: function () {
            enableNotebookActions(!!nbState.activeNotebookId);
            if (!nbState.activeNotebookId) {
                setRailCollapsed(true, false);
                renderPreviewEmptyState();
            }
        },
        getState: function () { return nbState; },
        onPageChanged: onPageChanged,
        beginSectionGenerating: function (msg) { beginGeneratingIndicator('nbSectionIndicator', msg || 'AI 正在生成笔记...'); },
        endSectionGenerating: function () { endGeneratingIndicator('nbSectionIndicator'); },
    };

})();

