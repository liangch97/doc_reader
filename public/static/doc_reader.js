/**
 * Doc Reader — 文档阅读器前端逻辑
 * 完全沿用 doc_reader_1.html 原型设计，对接 Tauri 后端
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

    // ── PDF.js 配置 ──────────────────────────────────────────────────────────
    if (window.pdfjsLib) {
        pdfjsLib.GlobalWorkerOptions.workerSrc = '/static/vendor/pdf.worker.min.js';
    }

    // ── State ────────────────────────────────────────────────────────────────
    var state = {
        sessionId: null,
        title: '',
        pages: [],          // [{ page_index, word_count, has_note }]
        pageContents: {},    // page_index -> content string (缓存)
        notes: {},           // page_index -> { content, source, created_at, updated_at }
        currentPage: 0,
        pageCount: 0,
        kgStatus: 'ready',
        generating: {},      // page_index -> true
        zoom: 100,
        isPdf: false,        // 当前文档是否为 PDF
        pdfDoc: null,        // pdf.js 文档对象
        isPpt: false,        // 当前文档是否为 PPTX/PPT
        slideImages: [],     // PPTX slide 图片 base64 数组
        isSelecting: false,  // 是否正在选择文字
        _lastPdfRender: null, // { idx, zoom, containerWidth } 上次 PDF 渲染参数
        _pdfRenderTimer: null, // 延迟渲染定时器
    };

    // ── DOM refs ─────────────────────────────────────────────────────────────
    var $thumbnails, $docPage, $pageContent, $notesList;
    var $fileName, $currentPage, $totalPages, $kgBadge, $notesCount;
    var $generateAllBtn, $progressBar, $progressFill;
    var $welcomeState, $pageBadge, $pageControls, $prevPage, $nextPage;
    var $pageNum, $pageTotal; // bottom page controls

    // ── Init ─────────────────────────────────────────────────────────────────
    function init() {
        cacheDOM();
        bindEvents();
        setupResizer();
        setupSettings();
        setupListeners();
        setupWindowControls();

        // 检查 URL 参数
        var params = new URLSearchParams(window.location.search);
        var sid = params.get('session');
        if (sid) {
            loadSession(sid);
        } else {
            // 尝试恢复上次工作区状态
            restoreWorkspace();
        }

        if (window.lucide) window.lucide.createIcons();
    }

    function cacheDOM() {
        $thumbnails = document.getElementById('thumbnailSidebar');
        $docPage = document.getElementById('docPage');
        $pageContent = document.getElementById('pageContent');
        $notesList = document.getElementById('notesList');
        $fileName = document.getElementById('fileName');
        $currentPage = document.getElementById('currentPage');
        $totalPages = document.getElementById('totalPages');
        $kgBadge = document.getElementById('kgBadge');
        $notesCount = document.getElementById('notesCount');
        $generateAllBtn = document.getElementById('generateAllBtn');
        $progressBar = document.getElementById('progressBar');
        $progressFill = document.getElementById('progressFill');
        $welcomeState = document.getElementById('welcomeState');
        $pageBadge = document.getElementById('pageBadge');
        $pageControls = document.getElementById('pageControls');
        $prevPage = document.getElementById('prevPage');
        $nextPage = document.getElementById('nextPage');
        $pageNum = document.getElementById('pageNum');
        $pageTotal = document.getElementById('pageTotal');
    }

    // ── Event binding ────────────────────────────────────────────────────────
    function bindEvents() {
        // File upload
        document.getElementById('uploadBtn').addEventListener('click', function () {
            document.getElementById('fileInput').click();
        });
        document.getElementById('fileInput').addEventListener('change', handleFileSelect);

        // Welcome page open button
        var welcomeOpenBtn = document.getElementById('welcomeOpenBtn');
        if (welcomeOpenBtn) {
            welcomeOpenBtn.addEventListener('click', function () {
                document.getElementById('fileInput').click();
            });
        }

        // Page nav
        document.getElementById('prevPage').addEventListener('click', function () { goToPage(state.currentPage - 1); });
        document.getElementById('nextPage').addEventListener('click', function () { goToPage(state.currentPage + 1); });

        // Generate all
        $generateAllBtn.addEventListener('click', handleGenerateAll);

        // Zoom
        document.getElementById('zoomIn').addEventListener('click', function () {
            state.zoom = Math.min(200, state.zoom + 10);
            document.getElementById('zoomLevel').textContent = state.zoom + '%';
            var vm = document.getElementById('docViewport');
            if (vm && vm.dataset.view === 'scroll') { cleanupScrollView(); renderScrollView(); }
            else if (state.isPdf) { renderPdfPage(state.currentPage); }
            else if (state.isPpt && state.slideImages.length > 0) { renderPptSlide(state.currentPage); }
            else { applyNonPdfZoom(); }
        });
        document.getElementById('zoomOut').addEventListener('click', function () {
            state.zoom = Math.max(50, state.zoom - 10);
            document.getElementById('zoomLevel').textContent = state.zoom + '%';
            var vm = document.getElementById('docViewport');
            if (vm && vm.dataset.view === 'scroll') { cleanupScrollView(); renderScrollView(); }
            else if (state.isPdf) { renderPdfPage(state.currentPage); }
            else if (state.isPpt && state.slideImages.length > 0) { renderPptSlide(state.currentPage); }
            else { applyNonPdfZoom(); }
        });

        // View mode toggle
        document.querySelectorAll('[data-view]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                document.querySelectorAll('[data-view]').forEach(function (b) { b.classList.remove('active'); });
                btn.classList.add('active');
                var mode = btn.dataset.view;
                var viewport = document.getElementById('docViewport');
                if (viewport) viewport.dataset.view = mode;
                // 退出连续模式时清理
                cleanupScrollView();
                // 网格模式下渲染所有页面，其他模式渲染当前页
                if (mode === 'scroll' && (state.pdfDoc || (state.isPpt && state.slideImages.length > 0))) {
                    renderScrollView();
                } else if (mode === 'grid' && (state.pdfDoc || (state.isPpt && state.slideImages.length > 0))) {
                    renderGridView();
                } else if (mode === 'double' && (state.pdfDoc || (state.isPpt && state.slideImages.length > 0))) {
                    renderDoubleView();
                } else {
                    // 恢复单页模式
                    restoreSingleView();
                    if (state.isPdf) renderPdfPage(state.currentPage);
                }
            });
        });

        // Sidebar collapse toggles
        var thumbToggle = document.getElementById('thumbToggle');
        var thumbDrawer = document.getElementById('thumbDrawer');
        var docFullscreen = document.getElementById('docFullscreen');
        var notesFullscreen = document.getElementById('notesFullscreen');
        var panelDoc = document.getElementById('panelDoc');
        var panelNotes = document.getElementById('panelNotes');

        if (thumbToggle && thumbDrawer) {
            thumbToggle.addEventListener('click', function () {
                var open = thumbDrawer.classList.toggle('open');
                var viewport = document.getElementById('docViewport');
                if (viewport) viewport.classList.toggle('has-thumbs', open);
                thumbToggle.title = open ? '关闭缩略图' : '打开缩略图';
                if (window.lucide) window.lucide.createIcons();
                // Re-render after layout change
                if (state.isPdf && state.pdfDoc) {
                    var vm = document.getElementById('docViewport');
                    if (vm && vm.dataset.view === 'scroll') {
                        cleanupScrollView(); renderScrollView();
                    } else {
                        state._lastPdfRender = null;
                        deferRenderPdfPage(state.currentPage, 250);
                    }
                }
            });
        }

        if (docFullscreen && panelDoc) {
            docFullscreen.addEventListener('click', function () {
                var mc = panelDoc.parentElement;
                var isFs = mc.classList.toggle('doc-fullscreen');
                if (isFs) mc.classList.remove('notes-fullscreen');
                panelDoc.style.flex = '';
                panelNotes.style.flex = '';
                var icon = docFullscreen.querySelector('[data-lucide]');
                if (icon) icon.setAttribute('data-lucide', isFs ? 'minimize-2' : 'maximize-2');
                if (window.lucide) window.lucide.createIcons();
                if (state.isPdf && state.pdfDoc) {
                    var vm = document.getElementById('docViewport');
                    if (vm && vm.dataset.view === 'scroll') {
                        cleanupScrollView(); renderScrollView();
                    } else {
                        state._lastPdfRender = null;
                        deferRenderPdfPage(state.currentPage, 100);
                    }
                }
            });
        }

        if (notesFullscreen && panelNotes) {
            notesFullscreen.addEventListener('click', function () {
                var mc = panelNotes.parentElement;
                var isFs = mc.classList.toggle('notes-fullscreen');
                if (isFs) mc.classList.remove('doc-fullscreen');
                panelDoc.style.flex = '';
                panelNotes.style.flex = '';
                var icon = notesFullscreen.querySelector('[data-lucide]');
                if (icon) icon.setAttribute('data-lucide', isFs ? 'minimize-2' : 'maximize-2');
                if (window.lucide) window.lucide.createIcons();
            });
        }

        // Keyboard nav
        document.addEventListener('keydown', function (e) {
            if (!state.sessionId) return;
            if (e.target.contentEditable === 'true') return;
            if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
            if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); goToPage(state.currentPage - 1); }
            if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); goToPage(state.currentPage + 1); }
        });

        // 全局 mouseup 重置选择状态
        document.addEventListener('mouseup', function () {
            state.isSelecting = false;
        });

        // ── Toolbar auto-hide ───────────────────────────────────────────────
        setupToolbarAutoHide();

        // ── Notebook resizer (vertical) ─────────────────────────────────────
        setupNbResizer();

        // ── Notebook preview expand toggle ──────────────────────────────────
        setupNbPreviewExpand();

        // ── AI Notes zoom ───────────────────────────────────────────────────
        setupNotesZoom();

        // ── PDF text selection floating toolbar ─────────────────────────────
        setupFloatingToolbar();

        // ── Q&A Chat ────────────────────────────────────────────────────────
        setupQAChat();
    }

    // ── Toolbar auto-hide logic ──────────────────────────────────────────────
    function setupToolbarAutoHide() {
        var toolbar = document.querySelector('.toolbar');
        var revealZone = document.getElementById('toolbarReveal');
        var appContainer = document.querySelector('.app-container');
        if (!toolbar || !revealZone) return;

        function showToolbar() {
            toolbar.classList.remove('auto-hidden');
            if (appContainer) appContainer.classList.remove('toolbar-collapsed');
        }

        function hideToolbar() {
            toolbar.classList.add('auto-hidden');
            if (appContainer) appContainer.classList.add('toolbar-collapsed');
        }

        var revealTimer = null;

        // 默认折叠
        hideToolbar();

        // 鼠标进入顶部感应区 → 延迟展开
        revealZone.addEventListener('mouseenter', function () {
            revealTimer = setTimeout(showToolbar, 400);
        });

        // 鼠标离开感应区 → 取消延迟
        revealZone.addEventListener('mouseleave', function () {
            if (revealTimer) { clearTimeout(revealTimer); revealTimer = null; }
        });

        // 鼠标在工具栏上 → 保持展开
        toolbar.addEventListener('mouseenter', function () {
            if (revealTimer) { clearTimeout(revealTimer); revealTimer = null; }
            showToolbar();
        });

        // 鼠标离开工具栏 → 折叠
        toolbar.addEventListener('mouseleave', function () {
            hideToolbar();
        });
    }

    // ── Notebook vertical resizer between entries-list and preview ────────────
    function setupNbResizer() {
        var resizer = document.getElementById('nbResizerV');
        if (!resizer) return;

        var entriesList = resizer.previousElementSibling;
        var previewPanel = resizer.nextElementSibling;
        if (!entriesList || !previewPanel) return;

        var startY, startH, parentH, snapped;
        var snapThreshold = 40;

        function onMouseDown(e) {
            e.preventDefault();
            startY = e.clientY;
            startH = entriesList.getBoundingClientRect().height;
            parentH = entriesList.parentElement.getBoundingClientRect().height;
            snapped = null;
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
            document.body.style.cursor = 'row-resize';
            document.body.style.userSelect = 'none';
        }

        function onMouseMove(e) {
            var delta = e.clientY - startY;
            var newH = startH + delta;

            // Snap: entries shrink to near 0 → preview fullscreen
            if (newH < snapThreshold) {
                snapped = 'preview';
                entriesList.style.flex = 'none';
                entriesList.style.height = '0px';
                resizer.style.opacity = '0.3';
                return;
            }
            // Snap: preview shrink to near 0 → entries fullscreen
            if (newH > parentH - snapThreshold) {
                snapped = 'entries';
                entriesList.style.flex = '1';
                entriesList.style.height = '';
                resizer.style.opacity = '0.3';
                return;
            }

            snapped = null;
            resizer.style.opacity = '';
            entriesList.style.flex = 'none';
            entriesList.style.height = Math.max(40, newH) + 'px';
        }

        function onMouseUp() {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            resizer.style.opacity = '';

            if (snapped === 'preview') {
                // Trigger preview expand (same as expand button)
                entriesList.style.flex = '';
                entriesList.style.height = '';
                var tabContent = resizer.closest('.sidebar-tab-content');
                var panelNotes = resizer.closest('.panel-notes');
                if (tabContent) tabContent.classList.add('preview-expanded');
                if (panelNotes) panelNotes.classList.add('preview-fullscreen');
                // Update expand button icon
                var btn = document.getElementById('nbPreviewExpandBtn');
                if (btn) {
                    var icon = btn.querySelector('[data-lucide]');
                    if (icon) icon.setAttribute('data-lucide', 'minimize-2');
                    if (window.lucide) window.lucide.createIcons();
                }
            } else if (snapped === 'entries') {
                // Collapse preview
                previewPanel.style.display = 'none';
                resizer.style.display = 'none';
            }
        }

        resizer.addEventListener('mousedown', onMouseDown);
    }

    // ── Notebook preview expand/collapse toggle ──────────────────────────────
    function setupNbPreviewExpand() {
        var btn = document.getElementById('nbPreviewExpandBtn');
        if (!btn) return;

        btn.addEventListener('click', function () {
            var tabContent = btn.closest('.sidebar-tab-content');
            var panelNotes = btn.closest('.panel-notes');
            if (!tabContent) return;
            var expanded = tabContent.classList.toggle('preview-expanded');
            if (panelNotes) panelNotes.classList.toggle('preview-fullscreen', expanded);
            var icon = btn.querySelector('[data-lucide]');
            if (icon) icon.setAttribute('data-lucide', expanded ? 'minimize-2' : 'maximize-2');
            if (window.lucide) window.lucide.createIcons();
        });
    }

    // ── AI Notes zoom ────────────────────────────────────────────────────────
    function setupNotesZoom() {
        var notesList = document.getElementById('notesList');
        var zoomInBtn = document.getElementById('notesZoomIn');
        var zoomOutBtn = document.getElementById('notesZoomOut');
        var zoomLevel = document.getElementById('notesZoomLevel');
        if (!notesList || !zoomInBtn || !zoomOutBtn) return;

        var _notesZoom = 100;
        function applyZoom() {
            if (zoomLevel) zoomLevel.textContent = _notesZoom + '%';
            notesList.style.zoom = _notesZoom / 100;
        }
        zoomInBtn.addEventListener('click', function () {
            _notesZoom = Math.min(200, _notesZoom + 10);
            applyZoom();
        });
        zoomOutBtn.addEventListener('click', function () {
            _notesZoom = Math.max(50, _notesZoom - 10);
            applyZoom();
        });
    }

    // ── Floating Toolbar for PDF text selection ──────────────────────────────
    function setupFloatingToolbar() {
        var toolbar = document.getElementById('floatingToolbar');
        var viewport = document.getElementById('docViewport');
        if (!toolbar || !viewport) return;

        var selectedText = '';

        function hideToolbar() {
            toolbar.style.display = 'none';
            selectedText = '';
            var pr = document.getElementById('ftbPromptRow');
            if (pr) pr.classList.remove('visible');
            var pi = document.getElementById('ftbPromptInput');
            if (pi) pi.value = '';
        }

        function showToolbar(x, y, text) {
            selectedText = text;
            toolbar.style.display = 'flex';
            // Position relative to viewport
            var vpRect = viewport.getBoundingClientRect();
            var tbWidth = toolbar.offsetWidth || 180;
            var left = x - vpRect.left - tbWidth / 2;
            var top = y - vpRect.top - 44;
            // Clamp to viewport bounds
            left = Math.max(4, Math.min(left, vpRect.width - tbWidth - 4));
            if (top < 4) top = y - vpRect.top + 20; // Show below if near top
            toolbar.style.left = left + 'px';
            toolbar.style.top = top + 'px';
            // Re-parent to viewport if needed
            if (toolbar.parentElement !== viewport) {
                viewport.style.position = 'relative';
                viewport.appendChild(toolbar);
            }
            if (window.lucide) window.lucide.createIcons();
        }

        // Detect text selection on mouseup within PDF area
        viewport.addEventListener('mouseup', function (e) {
            // Don't process if click was inside the floating toolbar itself
            if (toolbar.contains(e.target)) return;
            state.isSelecting = false;
            setTimeout(function () {
                var sel = window.getSelection();
                var text = sel ? sel.toString().trim() : '';
                if (text.length > 0) {
                    showToolbar(e.clientX, e.clientY, text);
                } else {
                    hideToolbar();
                }
            }, 10);
        });

        // Track selection state to prevent re-renders during selection
        viewport.addEventListener('mousedown', function (e) {
            var textLayer = e.target.closest('.pdf-text-layer, .ppt-text-overlay');
            if (textLayer) {
                state.isSelecting = true;
            }
        });

        // Hide on click outside
        document.addEventListener('mousedown', function (e) {
            if (toolbar.style.display !== 'none' && !toolbar.contains(e.target)) {
                hideToolbar();
            }
        });

        // Prevent toolbar interactions from clearing selection
        toolbar.addEventListener('mousedown', function (e) {
            e.stopPropagation();
        });

        // Copy button
        var copyBtn = document.getElementById('ftbCopy');
        if (copyBtn) {
            copyBtn.addEventListener('click', function () {
                if (selectedText) {
                    navigator.clipboard.writeText(selectedText).then(function () {
                        copyBtn.querySelector('span').textContent = '已复制';
                        setTimeout(function () {
                            copyBtn.querySelector('span').textContent = '复制';
                            hideToolbar();
                        }, 800);
                    });
                }
            });
        }

        // Toggle prompt row
        var togglePromptBtn = document.getElementById('ftbTogglePrompt');
        var promptRow = document.getElementById('ftbPromptRow');
        var promptInput = document.getElementById('ftbPromptInput');
        if (togglePromptBtn && promptRow) {
            togglePromptBtn.addEventListener('click', function () {
                promptRow.classList.toggle('visible');
                if (promptRow.classList.contains('visible') && promptInput) {
                    promptInput.focus();
                }
            });
        }

        // Generate note button
        var genBtn = document.getElementById('ftbGenerateNote');
        if (genBtn) {
            genBtn.addEventListener('click', function () {
                if (!selectedText) return;
                // Check if we have an active notebook
                var nbState = window.NotebookManager && window.NotebookManager.getState ? window.NotebookManager.getState() : null;
                if (!nbState || !nbState.activeNotebookId) {
                    alert('请先在「笔记本」标签页中选择或创建一个笔记本');
                    return;
                }
                if (!state.sessionId) {
                    alert('请先打开文档');
                    return;
                }
                // Use the textSelectModal flow or directly invoke
                genBtn.querySelector('span').textContent = '生成中...';
                genBtn.disabled = true;
                var customPrompt = (promptInput && promptInput.value.trim()) ? promptInput.value.trim() : null;
                invoke('notebook_generate_from_text', {
                    notebookId: nbState.activeNotebookId,
                    sessionId: state.sessionId,
                    selectedText: selectedText,
                    noteType: 'note',
                    pageIndex: state.currentPage,
                    customPrompt: customPrompt,
                }).then(function () {
                    genBtn.querySelector('span').textContent = '已提交';
                    setTimeout(function () {
                        genBtn.querySelector('span').textContent = '生成笔记';
                        genBtn.disabled = false;
                        hideToolbar();
                    }, 1000);
                    // Refresh notebook
                    if (window.NotebookManager && window.NotebookManager.loadNotebooks) {
                        window.NotebookManager.loadNotebooks();
                    }
                }).catch(function (err) {
                    console.error('生成笔记失败:', err);
                    alert('生成笔记失败: ' + String(err));
                    genBtn.querySelector('span').textContent = '生成笔记';
                    genBtn.disabled = false;
                });
            });
        }

        // AI Annotate button
        var annotateBtn = document.getElementById('ftbAnnotate');
        if (annotateBtn) {
            annotateBtn.addEventListener('click', function () {
                if (!selectedText) return;
                var nbState = window.NotebookManager && window.NotebookManager.getState ? window.NotebookManager.getState() : null;
                if (!nbState || !nbState.activeNotebookId) {
                    alert('请先在「笔记本」标签页中选择或创建一个笔记本');
                    return;
                }
                annotateBtn.querySelector('span').textContent = '标注中...';
                annotateBtn.disabled = true;
                invoke('notebook_annotate_text', {
                    notebookId: nbState.activeNotebookId,
                    selectedText: selectedText,
                    context: null,
                }).then(function () {
                    annotateBtn.querySelector('span').textContent = '已提交';
                    setTimeout(function () {
                        annotateBtn.querySelector('span').textContent = 'AI标注';
                        annotateBtn.disabled = false;
                        hideToolbar();
                    }, 1000);
                    if (window.NotebookManager && window.NotebookManager.loadNotebooks) {
                        window.NotebookManager.loadNotebooks();
                    }
                }).catch(function (err) {
                    console.error('AI标注失败:', err);
                    alert('AI标注失败: ' + String(err));
                    annotateBtn.querySelector('span').textContent = 'AI标注';
                    annotateBtn.disabled = false;
                });
            });
        }
    }

    // ── Q&A Chat Logic ─────────────────────────────────────────────────────
    function setupQAChat() {
        var modal = document.getElementById('qaModal');
        var chatBody = document.getElementById('qaChatBody');
        var input = document.getElementById('qaInput');
        var sendBtn = document.getElementById('qaSendBtn');
        var openBtn = document.getElementById('qaBtn');
        var closeBtn = document.getElementById('qaModalClose');
        var welcome = document.getElementById('qaWelcome');

        if (!modal || !openBtn) return;

        var chatHistory = []; // [{role, content}]

        openBtn.addEventListener('click', function () {
            if (!state.sessionId) return;
            modal.style.display = 'flex';
            if (window.lucide) window.lucide.createIcons();
            setTimeout(function () { input.focus(); }, 100);
        });

        closeBtn.addEventListener('click', function () { modal.style.display = 'none'; });
        modal.addEventListener('click', function (e) { if (e.target === modal) modal.style.display = 'none'; });

        input.addEventListener('input', function () {
            sendBtn.disabled = !input.value.trim();
            // Auto-resize
            input.style.height = 'auto';
            input.style.height = Math.min(input.scrollHeight, 100) + 'px';
        });

        input.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (input.value.trim()) sendQuestion();
            }
        });

        sendBtn.addEventListener('click', function () {
            if (input.value.trim()) sendQuestion();
        });

        function sendQuestion() {
            var question = input.value.trim();
            if (!question || !state.sessionId) return;

            // Hide welcome
            if (welcome) welcome.style.display = 'none';

            // Add user message
            addMessage('user', question);
            input.value = '';
            input.style.height = 'auto';
            sendBtn.disabled = true;

            // Show thinking indicator
            var thinkingEl = document.createElement('div');
            thinkingEl.className = 'qa-thinking';
            thinkingEl.innerHTML = '<div class="spinner"></div><span>AI 思考中...</span>';
            chatBody.appendChild(thinkingEl);
            chatBody.scrollTop = chatBody.scrollHeight;

            // Get current page text for context
            var textPromise;
            if (state.isPdf && state.pdfDoc) {
                textPromise = state.pdfDoc.getPage(state.currentPage + 1).then(function (page) {
                    return page.getTextContent();
                }).then(function (textContent) {
                    return textContent.items.map(function (item) { return item.str; }).join(' ');
                }).catch(function () { return ''; });
            } else if (state.pageContents[state.currentPage] !== undefined) {
                textPromise = Promise.resolve(state.pageContents[state.currentPage]);
            } else {
                textPromise = Promise.resolve('');
            }

            textPromise.then(function (pageText) {
                // Build history for multi-turn
                var hist = chatHistory.map(function (m) { return [m.role, m.content]; });

                return invoke('doc_reader_chat', {
                    sessionId: state.sessionId,
                    question: question,
                    pageIndex: state.currentPage,
                    pageContent: pageText || null,
                    history: hist.length > 0 ? hist : null,
                });
            }).then(function (res) {
                if (thinkingEl.parentNode) thinkingEl.remove();
                var answer = res.answer || '抱歉，无法生成回答。';
                addMessage('ai', answer);
                // Save to history for multi-turn
                chatHistory.push({ role: 'user', content: question });
                chatHistory.push({ role: 'assistant', content: answer });
                // Keep history manageable (last 10 turns)
                if (chatHistory.length > 20) chatHistory = chatHistory.slice(-20);
            }).catch(function (err) {
                if (thinkingEl.parentNode) thinkingEl.remove();
                addMessage('ai', '回答失败: ' + String(err));
                console.error('Q&A error:', err);
            });
        }

        function addMessage(role, content) {
            var div = document.createElement('div');
            div.className = 'qa-msg ' + role;

            if (role === 'ai') {
                var bodyHtml = renderMarkdown(content);
                div.innerHTML = '<div class="markdown-body">' + bodyHtml + '</div>' +
                    '<div class="qa-msg-actions">' +
                        '<button class="qa-copy-btn" title="复制"><i data-lucide="copy" style="width:12px;height:12px"></i><span>复制</span></button>' +
                        '<button class="qa-save-btn" title="保存到笔记本"><i data-lucide="book-plus" style="width:12px;height:12px"></i><span>存入笔记本</span></button>' +
                    '</div>';

                // Post-process markdown
                var mdEl = div.querySelector('.markdown-body');
                postProcessMarkdown(mdEl);

                // Copy button
                div.querySelector('.qa-copy-btn').addEventListener('click', function () {
                    navigator.clipboard.writeText(content).then(function () {
                        var span = div.querySelector('.qa-copy-btn span');
                        span.textContent = '已复制';
                        setTimeout(function () { span.textContent = '复制'; }, 1000);
                    });
                });

                // Save to notebook button
                div.querySelector('.qa-save-btn').addEventListener('click', function () {
                    var nbState = window.NotebookManager && window.NotebookManager.getState ? window.NotebookManager.getState() : null;
                    if (!nbState || !nbState.activeNotebookId) {
                        alert('请先在「笔记本」标签页中选择或创建一个笔记本');
                        return;
                    }
                    var title = 'Q&A — ' + content.substring(0, 30).replace(/[#*>\-_`\[\]()]/g, '').trim();
                    invoke('notebook_add_entry', {
                        notebookId: nbState.activeNotebookId,
                        title: title,
                        content: content,
                        entryType: 'qa',
                        sourceInfo: state.title + ' · 第 ' + (state.currentPage + 1) + ' 页 · AI答疑',
                    }).then(function () {
                        var btn = div.querySelector('.qa-save-btn');
                        btn.innerHTML = '<i data-lucide="check" style="width:12px;height:12px"></i><span>已保存</span>';
                        if (window.lucide) window.lucide.createIcons();
                        if (window.NotebookManager && window.NotebookManager.loadNotebooks) {
                            window.NotebookManager.loadNotebooks();
                        }
                    }).catch(function (err) {
                        alert('保存失败: ' + String(err));
                    });
                });
            } else {
                div.textContent = content;
            }

            chatBody.appendChild(div);
            chatBody.scrollTop = chatBody.scrollHeight;
            if (window.lucide) window.lucide.createIcons();
        }
    }

    // ── Window controls (minimize/maximize/close) ─────────────────────────
    function setupWindowControls() {
        function winInvoke(cmd) {
            if (window.__TAURI_INTERNALS__) return window.__TAURI_INTERNALS__.invoke('plugin:window|' + cmd, { label: 'main' });
            if (window.__TAURI__ && window.__TAURI__.core) return window.__TAURI__.core.invoke('plugin:window|' + cmd, { label: 'main' });
            return Promise.reject('no tauri');
        }
        var minBtn = document.getElementById('windowMinimize');
        var maxBtn = document.getElementById('windowMaximize');
        var closeBtn = document.getElementById('windowClose');
        if (!minBtn || !maxBtn || !closeBtn) return;
        if (!window.__TAURI_INTERNALS__ && !(window.__TAURI__ && window.__TAURI__.core)) {
            var wc = document.querySelector('.window-controls');
            if (wc) wc.style.display = 'none';
            return;
        }
        minBtn.addEventListener('click', function () { winInvoke('minimize'); });
        maxBtn.addEventListener('click', function () {
            winInvoke('is_maximized').then(function (m) {
                if (m) {
                    winInvoke('unmaximize');
                    maxBtn.innerHTML = '<i data-lucide="square" style="width:12px;height:12px"></i>';
                    maxBtn.title = '最大化';
                } else {
                    winInvoke('maximize');
                    maxBtn.innerHTML = '<i data-lucide="copy" style="width:12px;height:12px"></i>';
                    maxBtn.title = '还原';
                }
                if (window.lucide) window.lucide.createIcons({ nodes: [maxBtn] });
            });
        });
        closeBtn.addEventListener('click', function () { winInvoke('close'); });
    }

    // ── Tauri event listeners ────────────────────────────────────────────────
    function setupListeners() {
        listen('doc-note-generated', function (data) {
            if (data.session_id !== state.sessionId) return;
            var idx = data.page_index;
            state.generating[idx] = false;

            // 优先使用事件中直接携带的笔记内容（避免额外 DB 查询）
            if (data.note) {
                state.notes[idx] = data.note;
                state.pages[idx].has_note = true;
                updateThumbNote(idx);
                updateNotesCount();
                if (idx === state.currentPage) renderNote(idx);
                return;
            }

            // 回退：从 DB 获取
            invoke('doc_reader_get_page', { sessionId: state.sessionId, pageIndex: idx })
                .then(function (res) {
                    if (res.note) {
                        state.notes[idx] = res.note;
                        state.pages[idx].has_note = true;
                        updateThumbNote(idx);
                        updateNotesCount();
                        if (idx === state.currentPage) renderNote(idx);
                    }
                })
                .catch(function (err) {
                    console.error('获取生成笔记失败:', err);
                });
        });

        listen('doc-note-error', function (data) {
            if (data.session_id !== state.sessionId) return;
            state.generating[data.page_index] = false;
            if (data.page_index === state.currentPage) renderNote(data.page_index);
        });

        listen('doc-generate-all-progress', function (data) {
            if (data.session_id !== state.sessionId) return;
            $progressBar.classList.add('active');
            var pct = data.total > 0 ? Math.round((data.completed / data.total) * 100) : 0;
            $progressFill.style.width = pct + '%';
        });

        listen('doc-generate-all-done', function (data) {
            if (data.session_id !== state.sessionId) return;
            $progressBar.classList.remove('active');
            $progressFill.style.width = '0%';
            $generateAllBtn.disabled = false;
            $generateAllBtn.innerHTML = '<i data-lucide="sparkles" style="width:14px;height:14px"></i><span>全部生成</span><div class="shimmer"></div>';
            if (window.lucide) window.lucide.createIcons();
            // 刷新所有笔记
            loadAllNotes();
        });
    }

    // ── UI state toggle ────────────────────────────────────────────────────
    function showDocUI() {
        $welcomeState.style.display = 'none';
        $docPage.classList.add('visible');
        $pageBadge.style.display = '';
        $kgBadge.style.display = '';
        $pageControls.style.display = '';
        $generateAllBtn.disabled = false;
        // Enable page-range and text-select buttons
        var prBtn = document.getElementById('pageRangeBtn');
        var tsBtn = document.getElementById('textSelectBtn');
        var qaButton = document.getElementById('qaBtn');
        if (prBtn) prBtn.disabled = false;
        if (tsBtn) tsBtn.disabled = false;
        if (qaButton) qaButton.disabled = false;
        // Notify toolbar auto-hide that doc is loaded
        document.dispatchEvent(new Event('doc-loaded'));
    }

    // ── File handling ─────────────────────────────────────────────────────────
    function handleFileSelect(e) {
        var file = e.target.files[0];
        if (!file) return;

        var ext = file.name.split('.').pop().toLowerCase();
        state.isPdf = (ext === 'pdf');
        state.isPpt = (ext === 'pptx' || ext === 'ppt');
        state.slideImages = [];
        console.log('[handleFileSelect] file:', file.name, 'ext:', ext, 'isPdf:', state.isPdf, 'isPpt:', state.isPpt, 'pdfjsLib:', !!window.pdfjsLib);

        $fileName.textContent = file.name;
        $welcomeState.style.display = 'none';
        // 隐藏 PDF 渲染容器，避免加载阶段出现白色空框
        var pdfWrap = document.getElementById('pdfPageWrapper');
        if (pdfWrap) pdfWrap.style.display = 'none';
        var pdfCvs = document.getElementById('pdfCanvas');
        if (pdfCvs) pdfCvs.style.display = 'none';
        $docPage.classList.add('visible');
        $pageContent.innerHTML = '<div style="text-align:center;color:var(--muted-foreground);"><p>正在解析文档...</p></div>';

        var reader = new FileReader();
        reader.onload = function (ev) {
            var arrayBuffer = ev.target.result;

            // 转 base64 给后端（KG + 文本提取）
            var uint8 = new Uint8Array(arrayBuffer);
            var binary = '';
            for (var i = 0; i < uint8.length; i++) { binary += String.fromCharCode(uint8[i]); }
            var base64 = btoa(binary);

            // 后端调用（文本提取 + KG）
            var backendPromise = invoke('doc_reader_open', { fileName: file.name, fileData: base64 })
                .then(function (res) {
                    state.sessionId = res.session_id;
                    state.title = res.title;
                    state.kgStatus = 'ready';
                    state.notes = {};
                    state.pageContents = {};
                    state.generating = {};
                    state._lastPdfRender = null;

                    // 非 PDF：页数由后端决定
                    if (!state.isPdf) {
                        state.pageCount = res.page_count;
                        state.pages = res.pages;
                    } else {
                        // PDF：补齐 pages 摘要（后端可能只有 1 页）
                        // 真实页数由 pdf.js 决定，已在 pdfPromise 中设置
                        // 这里用 pdf.js 的页数生成摘要
                        if (state.pages.length === 0) {
                            state.pages = [];
                            for (var j = 0; j < state.pageCount; j++) {
                                state.pages.push({ page_index: j, word_count: 0, has_note: false });
                            }
                        }
                    }

                    return res;
                });

            if (state.isPdf && window.pdfjsLib) {
                console.log('[handleFileSelect] PDF mode, pdfjsLib available');
                // PDF：并行加载 pdf.js
                var pdfPromise = pdfjsLib.getDocument({ data: arrayBuffer.slice(0) }).promise
                    .then(function (pdfDoc) {
                        console.log('[handleFileSelect] pdfDoc loaded, pages:', pdfDoc.numPages);
                        state.pdfDoc = pdfDoc;
                        state.pageCount = pdfDoc.numPages;
                        // 生成 pages 摘要
                        state.pages = [];
                        for (var k = 0; k < pdfDoc.numPages; k++) {
                            state.pages.push({ page_index: k, word_count: 0, has_note: false });
                        }
                    });

                // 等两者都完成后再渲染 UI
                Promise.all([backendPromise, pdfPromise])
                    .then(function () {
                        $totalPages.textContent = state.pageCount;
                        if ($pageTotal) $pageTotal.textContent = state.pageCount;
                        updateKgBadge();
                        showDocUI();
                        renderThumbnails();
                        goToPage(0);
                        updateNotesCount();
                    })
                    .catch(function (err) {
                        console.error('doc open failed:', err);
                        $pageContent.innerHTML = '<div style="text-align:center;color:var(--destructive);padding:48px;"><p>文档加载失败: ' + escapeHtml(String(err)) + '</p></div>';
                    });
            } else {
                // 非 PDF：只等后端
                backendPromise
                    .then(function () {
                        $totalPages.textContent = state.pageCount;
                        if ($pageTotal) $pageTotal.textContent = state.pageCount;
                        updateKgBadge();
                        showDocUI();

                        if (state.isPpt) {
                            // PPTX：加载 slide 图片预览
                            $pageContent.innerHTML = '<div style="text-align:center;color:var(--muted-foreground);padding:48px;"><p>正在生成幻灯片预览...</p></div>';
                            return invoke('doc_reader_export_ppt_slides', { fileData: base64, fileName: file.name })
                                .then(function (imgRes) {
                                    state.slideImages = imgRes.slides || [];
                                    renderThumbnails();
                                    goToPage(0);
                                    updateNotesCount();
                                })
                                .catch(function (err) {
                                    console.error('PPT 图片导出失败:', err);
                                    state.slideImages = [];
                                    renderThumbnails();
                                    goToPage(0);
                                    updateNotesCount();
                                });
                        }

                        renderThumbnails();
                        goToPage(0);
                        updateNotesCount();
                    })
                    .catch(function (err) {
                        console.error('doc_reader_open failed:', err);
                        $pageContent.innerHTML = '<div style="text-align:center;color:var(--destructive);padding:48px;"><p>文档解析失败: ' + escapeHtml(String(err)) + '</p></div>';
                    });
            }
        };
        reader.readAsArrayBuffer(file);
        e.target.value = '';
    }

    // ── Session loading (从历史恢复) ──────────────────────────────────────────
    function loadSession(sessionId) {
        invoke('doc_reader_get_session', { sessionId: sessionId })
            .then(function (res) {
                var session = res.session;
                state.sessionId = session.session_id;
                state.title = session.filename;
                state.pageCount = session.page_count;
                state.kgStatus = 'ready';
                state.pages = res.pages;
                state.currentPage = 0;
                state.pageContents = {};
                state.generating = {};

                // 检测文件类型
                var ext = (session.filename || '').split('.').pop().toLowerCase();
                state.isPdf = (ext === 'pdf');
                state.isPpt = (ext === 'pptx' || ext === 'ppt');
                state.pdfDoc = null;
                state.slideImages = [];

                // 加载已有笔记
                state.notes = {};
                (res.notes || []).forEach(function (n) {
                    state.notes[n.page_index] = n;
                    if (state.pages[n.page_index]) state.pages[n.page_index].has_note = true;
                });

                $fileName.textContent = state.title;
                $totalPages.textContent = state.pageCount;
                if ($pageTotal) $pageTotal.textContent = state.pageCount;
                updateKgBadge();
                // 隐藏 PDF 渲染容器，避免加载阶段出现白色空框
                var pdfWrap = document.getElementById('pdfPageWrapper');
                if (pdfWrap) pdfWrap.style.display = 'none';
                var pdfCvs = document.getElementById('pdfCanvas');
                if (pdfCvs) pdfCvs.style.display = 'none';
                showDocUI();

                // 尝试恢复原始文件渲染
                var filePath = session.file_path || '';
                if (filePath && (state.isPdf || state.isPpt)) {
                    invoke('doc_reader_get_file', { sessionId: sessionId })
                        .then(function (fileRes) {
                            var fileData = fileRes.file_data;

                            if (state.isPdf && window.pdfjsLib) {
                                // 将 base64 转为 ArrayBuffer 给 pdf.js
                                var binary = atob(fileData);
                                var len = binary.length;
                                var uint8 = new Uint8Array(len);
                                for (var i = 0; i < len; i++) { uint8[i] = binary.charCodeAt(i); }
                                pdfjsLib.getDocument({ data: uint8.buffer }).promise
                                    .then(function (pdfDoc) {
                                        state.pdfDoc = pdfDoc;
                                        state.pageCount = pdfDoc.numPages;
                                        $totalPages.textContent = state.pageCount;
                                        if ($pageTotal) $pageTotal.textContent = state.pageCount;
                                        renderThumbnails();
                                        goToPage(0);
                                        updateNotesCount();
                                    })
                                    .catch(function (err) {
                                        console.error('PDF 恢复渲染失败:', err);
                                        renderThumbnails();
                                        goToPage(0);
                                        updateNotesCount();
                                    });
                            } else if (state.isPpt) {
                                // PPT：用原始文件数据导出幻灯片图片
                                $pageContent.innerHTML = '<div style="text-align:center;color:var(--muted-foreground);padding:48px;"><p>正在生成幻灯片预览...</p></div>';
                                invoke('doc_reader_export_ppt_slides', { fileData: fileData, fileName: session.filename })
                                    .then(function (imgRes) {
                                        state.slideImages = imgRes.slides || [];
                                        renderThumbnails();
                                        goToPage(0);
                                        updateNotesCount();
                                    })
                                    .catch(function (err) {
                                        console.error('PPT 历史图片恢复失败:', err);
                                        state.slideImages = [];
                                        renderThumbnails();
                                        goToPage(0);
                                        updateNotesCount();
                                    });
                            }
                        })
                        .catch(function (err) {
                            console.error('获取原始文件失败:', err);
                            renderThumbnails();
                            goToPage(0);
                            updateNotesCount();
                        });
                } else {
                    // 无原始文件，纯文本模式
                    renderThumbnails();
                    goToPage(0);
                    updateNotesCount();
                }
            })
            .catch(function (err) {
                console.error('loadSession failed:', err);
            });
    }

    // ── Thumbnails ────────────────────────────────────────────────────────────
    function renderThumbnails() {
        $thumbnails.innerHTML = '';
        for (var i = 0; i < state.pageCount; i++) {
            var div = document.createElement('div');
            div.className = 'thumb-item' + (i === state.currentPage ? ' active' : '');
            if (state.pages[i] && state.pages[i].has_note) div.className += ' has-note';
            div.dataset.page = i;

            if (state.isPdf && state.pdfDoc) {
                var canvas = document.createElement('canvas');
                canvas.style.width = '100%';
                canvas.style.height = 'auto';
                canvas.style.borderRadius = '2px';
                div.appendChild(canvas);
                renderThumbnailCanvas(canvas, i);
            } else if (state.isPpt && state.slideImages[i]) {
                var img = document.createElement('img');
                img.src = state.slideImages[i];
                img.style.width = '100%';
                img.style.height = 'auto';
                img.style.borderRadius = '2px';
                img.style.objectFit = 'cover';
                div.appendChild(img);
            } else {
                var span = document.createElement('span');
                span.className = 'thumb-num';
                span.textContent = i + 1;
                div.appendChild(span);
            }

            $thumbnails.appendChild(div);
        }

        // Bind click
        $thumbnails.querySelectorAll('.thumb-item').forEach(function (el) {
            el.addEventListener('click', function () {
                goToPage(parseInt(el.dataset.page, 10));
            });
        });
    }

    function renderThumbnailCanvas(canvas, pageIndex) {
        state.pdfDoc.getPage(pageIndex + 1).then(function (page) {
            var viewport = page.getViewport({ scale: 1 });
            // 基准宽度 56px，再乘以 devicePixelRatio 确保高清屏清晰
            var dpr = Math.max(window.devicePixelRatio || 1, 2);
            var scale = (56 / viewport.width) * dpr;
            var thumbViewport = page.getViewport({ scale: scale });
            canvas.width = thumbViewport.width;
            canvas.height = thumbViewport.height;
            // CSS 尺寸设为实际像素 / dpr，保证清晰度
            canvas.style.width = (thumbViewport.width / dpr) + 'px';
            canvas.style.height = (thumbViewport.height / dpr) + 'px';
            canvas.style.borderRadius = '2px';
            page.render({
                canvasContext: canvas.getContext('2d'),
                viewport: thumbViewport,
            });
        });
    }

    function updateThumbActive(idx) {
        $thumbnails.querySelectorAll('.thumb-item').forEach(function (el, i) {
            el.classList.toggle('active', i === idx);
        });
        // Scroll into view
        var active = $thumbnails.querySelector('.thumb-item.active');
        if (active) active.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }

    function updateThumbNote(idx) {
        var thumbs = $thumbnails.querySelectorAll('.thumb-item');
        if (thumbs[idx]) {
            thumbs[idx].classList.toggle('has-note', !!state.notes[idx]);
        }
    }

    // ── Page navigation ───────────────────────────────────────────────────────
    function goToPage(idx) {
        if (idx < 0 || idx >= state.pageCount) return;

        var direction = idx >= state.currentPage ? 'forward' : 'reverse';
        state.currentPage = idx;
        $currentPage.textContent = idx + 1;
        if ($pageNum) $pageNum.textContent = idx + 1;
        updateThumbActive(idx);

        // 更新翻页按钮
        $prevPage.disabled = idx <= 0;
        $nextPage.disabled = idx >= state.pageCount - 1;

        // 自动保存工作区状态
        saveWorkspace();

        // 动画
        $docPage.style.animation = 'none';
        $docPage.offsetHeight; // reflow
        $docPage.style.animation = direction === 'forward' ? 'pageIn 300ms ease-out' : 'pageInReverse 300ms ease-out';

        // 加载页面内容
        console.log('[goToPage] isPdf:', state.isPdf, 'isPpt:', state.isPpt, 'pdfDoc:', !!state.pdfDoc, 'idx:', idx);

        // 根据当前视图模式分发渲染
        var currentView = document.getElementById('docViewport');
        var viewMode = currentView ? (currentView.dataset.view || 'single') : 'single';
        if (viewMode === 'scroll') {
            // 连续模式：滚动到对应页
            scrollToPageInScrollView(idx);
            renderNote(idx);
            return;
        }
        if (viewMode === 'double' && (state.pdfDoc || (state.isPpt && state.slideImages.length > 0))) {
            renderDoubleView();
            renderNote(idx);
            return;
        }
        if (viewMode === 'grid') {
            renderNote(idx);
            return;
        }

        if (state.isPdf && state.pdfDoc) {
            // 立即切换显示状态，避免闪烁文本
            var pdfCanvas = document.getElementById('pdfCanvas');
            if (pdfCanvas) pdfCanvas.style.display = 'block';
            $pageContent.style.display = 'none';
            renderPdfPage(idx);
        } else if (state.isPpt && state.slideImages.length > 0) {
            // PPT 图片预览模式
            renderPptSlide(idx);
        } else if (state.pageContents[idx] !== undefined) {
            renderPageContent(state.pageContents[idx]);
        } else {
            $pageContent.innerHTML = '<div style="text-align:center;color:var(--muted-foreground);"><p>加载中...</p></div>';
            invoke('doc_reader_get_page', { sessionId: state.sessionId, pageIndex: idx })
                .then(function (res) {
                    var content = res.page.content;
                    state.pageContents[idx] = content;
                    if (res.note) {
                        state.notes[idx] = res.note;
                        state.pages[idx].has_note = true;
                        updateThumbNote(idx);
                        updateNotesCount();
                    }
                    if (state.currentPage === idx) {
                        renderPageContent(content);
                    }
                })
                .catch(function (err) {
                    if (state.currentPage === idx) {
                        $pageContent.innerHTML = '<p style="color:var(--destructive);">加载失败: ' + escapeHtml(String(err)) + '</p>';
                    }
                });
        }

        // 渲染笔记
        renderNote(idx);
    }

    function renderPageContent(content) {
        // 非 PDF 模式：隐藏 canvas，显示文本
        var pdfCanvas = document.getElementById('pdfCanvas');
        var pdfWrapper = document.getElementById('pdfPageWrapper');
        if (pdfCanvas) pdfCanvas.style.display = 'none';
        if (pdfWrapper) pdfWrapper.style.display = 'none';
        $pageContent.style.display = '';

        if (!content || !content.trim()) {
            $pageContent.innerHTML = '<h2 style="font-family:var(--font-serif)!important;font-size:28px!important;font-weight:600!important;color:var(--muted-foreground)!important;">空白页</h2>';
            return;
        }
        // 将纯文本渲染为段落
        var paragraphs = content.split(/\n\n+/);
        var html = '';
        for (var i = 0; i < paragraphs.length; i++) {
            var p = paragraphs[i].trim();
            if (!p) continue;
            if (i === 0 && p.length < 100) {
                html += '<h2 style="font-family:var(--font-serif)!important;font-size:28px!important;font-weight:600!important;margin-bottom:16px!important;color:var(--foreground)!important;">' + escapeHtml(p) + '</h2>';
            } else {
                html += '<p style="font-family:var(--font-serif)!important;font-size:16px!important;color:var(--muted-foreground)!important;line-height:1.7!important;margin-bottom:12px!important;">' + escapeHtml(p) + '</p>';
            }
        }
        $pageContent.innerHTML = html;
    }

    // ── PPT slide 图片渲染 ────────────────────────────────────────────────────
    function renderPptSlide(idx) {
        // 文字选中期间不重新渲染，避免闪烁
        if (state.isSelecting) return;
        var pdfCanvas = document.getElementById('pdfCanvas');
        var pdfWrapper = document.getElementById('pdfPageWrapper');
        if (pdfCanvas) pdfCanvas.style.display = 'none';
        if (pdfWrapper) pdfWrapper.style.display = 'none';
        $pageContent.style.display = '';

        var imgSrc = state.slideImages[idx];
        if (!imgSrc) {
            // 没有图片时 fallback 到文本
            if (state.pageContents[idx] !== undefined) {
                renderPageContent(state.pageContents[idx]);
            } else {
                invoke('doc_reader_get_page', { sessionId: state.sessionId, pageIndex: idx })
                    .then(function (res) {
                        state.pageContents[idx] = res.page.content;
                        if (state.currentPage === idx) renderPageContent(res.page.content);
                    });
            }
            return;
        }

        var scaleFactor = state.zoom / 100;

        // 加载并渲染图片 + 文本覆盖层（使文本可选中）
        $pageContent.innerHTML =
            '<div class="ppt-slide-wrapper" style="position:relative;display:inline-block;max-width:' + (100 * scaleFactor) + '%;">' +
                '<img src="' + imgSrc + '" style="width:100%;height:auto;border-radius:4px;display:block;" />' +
                '<div class="ppt-text-overlay" style="position:absolute;top:0;left:0;width:100%;height:100%;' +
                    'z-index:1;cursor:text;user-select:text;-webkit-user-select:text;' +
                    'overflow:hidden;"></div>' +
            '</div>';

        // 获取页面文本内容并渲染为可选中覆盖层
        var loadText = state.pageContents[idx] !== undefined
            ? Promise.resolve(state.pageContents[idx])
            : invoke('doc_reader_get_page', { sessionId: state.sessionId, pageIndex: idx })
                .then(function (res) {
                    state.pageContents[idx] = res.page.content;
                    return res.page.content;
                });

        loadText.then(function (content) {
            if (state.currentPage !== idx) return;
            if (!content || !content.trim()) return;
            var overlay = $pageContent.querySelector('.ppt-text-overlay');
            if (!overlay) return;
            // 将文本渲染为透明段落覆盖在图片上（通过 CSS ::selection 显示选中效果）
            var paragraphs = content.split(/\n+/);
            var html = '';
            for (var i = 0; i < paragraphs.length; i++) {
                var p = paragraphs[i].trim();
                if (!p) continue;
                html += '<span style="display:block;color:transparent;font-size:14px;' +
                    'line-height:1.6;padding:2px 8px;white-space:pre-wrap;word-break:break-word;' +
                    'cursor:text;-webkit-user-select:text;user-select:text;">' +
                    escapeHtml(p) + '</span>';
            }
            overlay.innerHTML = html;
        }).catch(function () { /* ignore */ });
    }

    // ── PDF.js 页面渲染 ──────────────────────────────────────────────────────
    function applyNonPdfZoom() {
        // 非 PDF 模式：使用 transform scale 实现等比缩放
        var scaleFactor = state.zoom / 100;
        $docPage.style.transform = 'scale(' + scaleFactor + ')';
        $docPage.style.transformOrigin = 'center center';
        // 保持 maxWidth 不变，让 transform 处理缩放
        $docPage.style.maxWidth = '';
    }

    // 延迟渲染 PDF（用于布局变化后的重新渲染，合并多次调用）
    function deferRenderPdfPage(idx, delay) {
        if (state._pdfRenderTimer) clearTimeout(state._pdfRenderTimer);
        state._pdfRenderTimer = setTimeout(function () {
            state._pdfRenderTimer = null;
            if (!state.isSelecting) renderPdfPage(idx);
        }, delay);
    }

    function renderPdfPage(idx) {
        if (!state.pdfDoc) return;
        // 文字选中期间不重新渲染，避免闪烁
        if (state.isSelecting) return;
        var canvas = document.getElementById('pdfCanvas');
        if (!canvas) return;
        var container = document.getElementById('docViewport');
        var textLayerDiv = document.getElementById('pdfTextLayer');
        var wrapper = document.getElementById('pdfPageWrapper');

        // 强制触发 layout 以获取准确容器宽度
        var containerWidth = container ? (container.clientWidth || 800) : 800;
        if (containerWidth <= 64) {
            // 容器未就绪，等待一帧后重试
            requestAnimationFrame(function () { if (!state.isSelecting) renderPdfPage(idx); });
            return;
        }
        containerWidth = containerWidth - 64;

        // 如果渲染参数没有变化，跳过重新渲染（避免选中/布局无变化时闪烁）
        var renderKey = idx + '|' + state.zoom + '|' + containerWidth;
        if (state._lastPdfRender === renderKey) return;
        state._lastPdfRender = renderKey;

        state.pdfDoc.getPage(idx + 1).then(function(page) {
            var viewport = page.getViewport({ scale: 1 });
            // 根据容器宽度自适应
            var baseScale = containerWidth / viewport.width;
            var scale = baseScale * (state.zoom / 100);
            // 高分屏支持：canvas 内部用高分辨率渲染，最低 2x 保证清晰
            var dpr = Math.max(window.devicePixelRatio || 1, 2);
            var renderScale = scale * dpr;
            var scaledViewport = page.getViewport({ scale: renderScale });

            canvas.width = scaledViewport.width;
            canvas.height = scaledViewport.height;
            // CSS 尺寸 = 实际像素 / dpr，保证清晰度
            var cssWidth = scaledViewport.width / dpr;
            var cssHeight = scaledViewport.height / dpr;
            canvas.style.width = cssWidth + 'px';
            canvas.style.height = cssHeight + 'px';
            canvas.style.display = 'block';
            $pageContent.style.display = 'none';

            // Show wrapper for PDF mode
            if (wrapper) {
                wrapper.style.display = '';
                wrapper.style.width = cssWidth + 'px';
                wrapper.style.height = cssHeight + 'px';
            }

            // 清除旧内容后再渲染，避免残影
            var ctx = canvas.getContext('2d');
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            page.render({ canvasContext: ctx, viewport: scaledViewport });

            // ── Text Layer ──────────────────────────────────────
            if (textLayerDiv) {
                textLayerDiv.innerHTML = '';
                textLayerDiv.style.width = cssWidth + 'px';
                textLayerDiv.style.height = cssHeight + 'px';

                page.getTextContent().then(function(textContent) {
                    // pdf.js text layer uses the CSS-size viewport
                    var textViewport = page.getViewport({ scale: scale });
                    if (window.pdfjsLib && window.pdfjsLib.renderTextLayer) {
                        window.pdfjsLib.renderTextLayer({
                            textContentSource: textContent,
                            container: textLayerDiv,
                            viewport: textViewport,
                            textDivs: []
                        });
                    } else {
                        // Manual text layer fallback
                        var items = textContent.items;
                        for (var i = 0; i < items.length; i++) {
                            var item = items[i];
                            if (!item.str) continue;
                            var tx = item.transform;
                            var span = document.createElement('span');
                            span.textContent = item.str;
                            // transform[4]=x, transform[5]=y (from bottom), item.height for font size
                            var x = tx[4] * scale;
                            var y = cssHeight - (tx[5] * scale);
                            var fontSize = Math.sqrt(tx[0] * tx[0] + tx[1] * tx[1]) * scale;
                            span.style.left = x + 'px';
                            span.style.top = (y - fontSize) + 'px';
                            span.style.fontSize = fontSize + 'px';
                            span.style.fontFamily = item.fontName || 'sans-serif';
                            if (item.width) {
                                span.style.width = (item.width * scale) + 'px';
                            }
                            textLayerDiv.appendChild(span);
                        }
                    }
                }).catch(function(err) {
                    console.warn('Text layer 渲染失败:', err);
                });
            }
        }).catch(function (err) {
            console.error('PDF 页面渲染失败:', err);
            $pageContent.innerHTML = '<div style="text-align:center;color:var(--destructive);padding:48px;"><p>PDF 渲染失败: ' + escapeHtml(String(err)) + '</p></div>';
            $pageContent.style.display = '';
            canvas.style.display = 'none';
        });
    }

    // ── View mode helpers ─────────────────────────────────────────────────────
    function restoreSingleView() {
        var viewport = document.getElementById('docViewport');
        // 移除多页时动态创建的额外 doc-page 元素
        var extras = viewport.querySelectorAll('.doc-page-extra');
        extras.forEach(function (el) { el.remove(); });
        $docPage.classList.add('visible');
        // 恢复 canvas / pageContent 显示状态
        var pdfCanvas = document.getElementById('pdfCanvas');
        if (state.isPdf && pdfCanvas) {
            pdfCanvas.style.display = 'block';
            $pageContent.style.display = 'none';
        } else if (state.isPpt && state.slideImages.length > 0) {
            if (pdfCanvas) pdfCanvas.style.display = 'none';
            $pageContent.style.display = '';
            renderPptSlide(state.currentPage);
        } else {
            if (pdfCanvas) pdfCanvas.style.display = 'none';
            $pageContent.style.display = '';
        }
    }

    function renderDoubleView() {
        if (!state.pdfDoc && !(state.isPpt && state.slideImages.length > 0)) return;
        var viewport = document.getElementById('docViewport');
        // 清除之前的额外页面
        viewport.querySelectorAll('.doc-page-extra').forEach(function (el) { el.remove(); });
        $docPage.classList.remove('visible');

        // 渲染当前页和下一页（两页并排）
        var startPage = state.currentPage;
        var endPage = Math.min(startPage + 2, state.pageCount);
        var containerWidth = (viewport.clientWidth - 64) / 2 - 16;

        for (var i = startPage; i < endPage; i++) {
            var pageDiv = document.createElement('div');
            pageDiv.className = 'doc-page doc-page-extra visible';

            if (state.isPdf && state.pdfDoc) {
                var canvas = document.createElement('canvas');
                canvas.style.display = 'block';
                canvas.style.maxWidth = '100%';
                pageDiv.appendChild(canvas);
                viewport.appendChild(pageDiv);
                renderExtraCanvas(canvas, i, containerWidth);
            } else if (state.isPpt && state.slideImages[i]) {
                var img = document.createElement('img');
                img.src = state.slideImages[i];
                img.style.maxWidth = '100%';
                img.style.height = 'auto';
                img.style.borderRadius = '4px';
                pageDiv.appendChild(img);
                viewport.appendChild(pageDiv);
            }
        }
    }

    function renderGridView() {
        if (!state.pdfDoc && !(state.isPpt && state.slideImages.length > 0)) return;
        var viewport = document.getElementById('docViewport');
        viewport.querySelectorAll('.doc-page-extra').forEach(function (el) { el.remove(); });
        $docPage.classList.remove('visible');

        var gridWidth = 200;
        for (var i = 0; i < state.pageCount; i++) {
            var pageDiv = document.createElement('div');
            pageDiv.className = 'doc-page doc-page-extra visible';
            pageDiv.style.cursor = 'pointer';
            pageDiv.dataset.page = i;

            if (state.isPdf && state.pdfDoc) {
                var canvas = document.createElement('canvas');
                canvas.style.display = 'block';
                canvas.style.maxWidth = '100%';
                pageDiv.appendChild(canvas);
                viewport.appendChild(pageDiv);
                renderExtraCanvas(canvas, i, gridWidth);
            } else if (state.isPpt && state.slideImages[i]) {
                var img = document.createElement('img');
                img.src = state.slideImages[i];
                img.style.width = gridWidth + 'px';
                img.style.height = 'auto';
                img.style.borderRadius = '4px';
                pageDiv.appendChild(img);
                viewport.appendChild(pageDiv);
            }

            // 点击网格页回到单页模式
            pageDiv.addEventListener('click', function () {
                var idx = parseInt(this.dataset.page, 10);
                // 切回单页
                document.querySelector('[data-view="single"]').click();
                goToPage(idx);
            });
        }
    }

    function renderExtraCanvas(canvas, pageIndex, targetWidth) {
        state.pdfDoc.getPage(pageIndex + 1).then(function (page) {
            var vp = page.getViewport({ scale: 1 });
            var dpr = window.devicePixelRatio || 1;
            var scale = (targetWidth / vp.width) * dpr;
            var sv = page.getViewport({ scale: scale });
            canvas.width = sv.width;
            canvas.height = sv.height;
            canvas.style.width = (sv.width / dpr) + 'px';
            canvas.style.height = (sv.height / dpr) + 'px';
            page.render({ canvasContext: canvas.getContext('2d'), viewport: sv });
        });
    }

    // ── Scroll (continuous) view mode ─────────────────────────────────────────
    var _scrollObserver = null;
    var _scrollPageObserver = null;
    var _handleScrollViewScroll = null;
    var _scrollRendered = {};     // pageIndex -> true
    var _scrollSuppressPageUpdate = false;

    function cleanupScrollView() {
        if (_scrollObserver) { _scrollObserver.disconnect(); _scrollObserver = null; }
        if (_scrollPageObserver) { _scrollPageObserver.disconnect(); _scrollPageObserver = null; }
        _scrollRendered = {};
        _scrollSuppressPageUpdate = false;
        var viewport = document.getElementById('docViewport');
        if (viewport && _handleScrollViewScroll) viewport.removeEventListener('scroll', _handleScrollViewScroll);
    }

    function renderScrollView() {
        if (!state.pdfDoc && !(state.isPpt && state.slideImages.length > 0)) return;
        var viewport = document.getElementById('docViewport');
        // Remove extra pages and hide the main doc page
        viewport.querySelectorAll('.doc-page-extra').forEach(function (el) { el.remove(); });
        $docPage.classList.remove('visible');

        _scrollRendered = {};

        var containerWidth = (viewport.clientWidth || 800) - 64;
        if (containerWidth < 200) containerWidth = 600;

        // Create page containers with placeholders
        for (var i = 0; i < state.pageCount; i++) {
            var pageDiv = document.createElement('div');
            pageDiv.className = 'doc-page doc-page-extra visible';
            pageDiv.dataset.page = i;
            pageDiv.style.minHeight = '400px';
            pageDiv.style.position = 'relative';

            // Page label
            var label = document.createElement('span');
            label.className = 'scroll-page-label';
            label.textContent = (i + 1) + ' / ' + state.pageCount;
            pageDiv.appendChild(label);

            if (state.isPdf && state.pdfDoc) {
                var wrapper = document.createElement('div');
                wrapper.className = 'pdf-page-wrapper';
                wrapper.style.position = 'relative';
                wrapper.style.display = 'inline-block';
                var canvas = document.createElement('canvas');
                canvas.className = 'scroll-canvas';
                canvas.dataset.page = i;
                canvas.style.display = 'block';
                canvas.style.maxWidth = '100%';
                // placeholder sizing: use first page aspect ratio estimate
                canvas.style.width = containerWidth + 'px';
                canvas.style.height = (containerWidth * 1.414) + 'px';
                canvas.style.background = 'var(--muted, #f5f5f5)';
                canvas.style.borderRadius = '2px';
                wrapper.appendChild(canvas);
                // Text layer
                var textLayer = document.createElement('div');
                textLayer.className = 'pdf-text-layer';
                textLayer.style.position = 'absolute';
                textLayer.style.left = '0'; textLayer.style.top = '0';
                textLayer.style.right = '0'; textLayer.style.bottom = '0';
                textLayer.style.overflow = 'hidden';
                textLayer.style.pointerEvents = 'all';
                textLayer.style.zIndex = '2';
                wrapper.appendChild(textLayer);
                pageDiv.appendChild(wrapper);
            } else if (state.isPpt && state.slideImages[i]) {
                var img = document.createElement('img');
                img.style.maxWidth = '100%';
                img.style.height = 'auto';
                img.style.borderRadius = '4px';
                img.style.background = 'var(--muted, #f5f5f5)';
                img.dataset.src = state.slideImages[i];
                img.dataset.page = i;
                pageDiv.appendChild(img);
            }

            viewport.appendChild(pageDiv);
        }

        // IntersectionObserver for lazy rendering PDF pages
        if (state.isPdf && state.pdfDoc) {
            _scrollObserver = new IntersectionObserver(function (entries) {
                entries.forEach(function (entry) {
                    if (entry.isIntersecting) {
                        var canvas = entry.target;
                        var pageIdx = parseInt(canvas.dataset.page, 10);
                        if (!_scrollRendered[pageIdx]) {
                            _scrollRendered[pageIdx] = true;
                            renderScrollCanvas(canvas, pageIdx, containerWidth);
                        }
                    }
                });
            }, { root: viewport, rootMargin: '200px 0px' });

            viewport.querySelectorAll('.scroll-canvas').forEach(function (c) {
                _scrollObserver.observe(c);
            });
        } else if (state.isPpt) {
            // Lazy load PPT images
            _scrollObserver = new IntersectionObserver(function (entries) {
                entries.forEach(function (entry) {
                    if (entry.isIntersecting && entry.target.dataset.src) {
                        entry.target.src = entry.target.dataset.src;
                        delete entry.target.dataset.src;
                    }
                });
            }, { root: viewport, rootMargin: '200px 0px' });

            viewport.querySelectorAll('img[data-src]').forEach(function (img) {
                _scrollObserver.observe(img);
            });
        }

        // Track which page is currently visible (for sidebar/page indicator sync)
        _scrollPageObserver = new IntersectionObserver(function (entries) {
            if (_scrollSuppressPageUpdate) return;
            var maxRatio = 0;
            var visibleIdx = state.currentPage;
            entries.forEach(function (entry) {
                if (entry.isIntersecting && entry.intersectionRatio > maxRatio) {
                    maxRatio = entry.intersectionRatio;
                    visibleIdx = parseInt(entry.target.dataset.page, 10);
                }
            });
            if (!isNaN(visibleIdx) && visibleIdx !== state.currentPage) {
                state.currentPage = visibleIdx;
                $currentPage.textContent = visibleIdx + 1;
                if ($pageNum) $pageNum.textContent = visibleIdx + 1;
                updateThumbActive(visibleIdx);
                $prevPage.disabled = visibleIdx <= 0;
                $nextPage.disabled = visibleIdx >= state.pageCount - 1;
                saveWorkspace();
                renderNote(visibleIdx);
            }
        }, { root: viewport, rootMargin: '-30% 0px -30% 0px', threshold: [0, 0.25, 0.5, 0.75, 1] });

        viewport.querySelectorAll('.doc-page-extra').forEach(function (el) {
            _scrollPageObserver.observe(el);
        });

        // Scroll to current page
        scrollToPageInScrollView(state.currentPage);
    }

    function renderScrollCanvas(canvas, pageIndex, targetWidth) {
        state.pdfDoc.getPage(pageIndex + 1).then(function (page) {
            var vp = page.getViewport({ scale: 1 });
            var baseScale = targetWidth / vp.width;
            var scale = baseScale * (state.zoom / 100);
            var dpr = Math.max(window.devicePixelRatio || 1, 2);
            var renderScale = scale * dpr;
            var sv = page.getViewport({ scale: renderScale });

            canvas.width = sv.width;
            canvas.height = sv.height;
            var cssWidth = sv.width / dpr;
            var cssHeight = sv.height / dpr;
            canvas.style.width = cssWidth + 'px';
            canvas.style.height = cssHeight + 'px';
            canvas.style.background = '';

            var wrapper = canvas.parentElement;
            if (wrapper) {
                wrapper.style.width = cssWidth + 'px';
                wrapper.style.height = cssHeight + 'px';
            }

            var ctx = canvas.getContext('2d');
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            page.render({ canvasContext: ctx, viewport: sv });

            // Text layer
            var textLayerDiv = wrapper ? wrapper.querySelector('.pdf-text-layer') : null;
            if (textLayerDiv) {
                textLayerDiv.innerHTML = '';
                textLayerDiv.style.width = cssWidth + 'px';
                textLayerDiv.style.height = cssHeight + 'px';
                page.getTextContent().then(function (textContent) {
                    var textViewport = page.getViewport({ scale: scale });
                    if (window.pdfjsLib && window.pdfjsLib.renderTextLayer) {
                        window.pdfjsLib.renderTextLayer({
                            textContentSource: textContent,
                            container: textLayerDiv,
                            viewport: textViewport,
                            textDivs: []
                        });
                    }
                }).catch(function () {});
            }
        }).catch(function (err) {
            console.warn('Scroll view page ' + pageIndex + ' render failed:', err);
        });
    }

    function scrollToPageInScrollView(idx) {
        var viewport = document.getElementById('docViewport');
        var pages = viewport.querySelectorAll('.doc-page-extra');
        if (pages[idx]) {
            _scrollSuppressPageUpdate = true;
            pages[idx].scrollIntoView({ behavior: 'smooth', block: 'start' });
            setTimeout(function () { _scrollSuppressPageUpdate = false; }, 600);
        }
    }

    // ── Notes rendering ───────────────────────────────────────────────────────
    function renderNote(idx) {
        var note = state.notes[idx];
        var isGenerating = state.generating[idx];

        if (isGenerating) {
            // Skeleton loading
            $notesList.innerHTML =
                '<div class="note-card">' +
                    '<div class="note-card-header">' +
                        '<span class="page-label">第 ' + (idx + 1) + ' 页</span>' +
                    '</div>' +
                    '<div class="note-card-body">' +
                        '<div class="skeleton skeleton-line" style="width:90%"></div>' +
                        '<div class="skeleton skeleton-line" style="width:75%"></div>' +
                        '<div class="skeleton skeleton-line" style="width:85%"></div>' +
                        '<div class="skeleton skeleton-line" style="width:60%"></div>' +
                    '</div>' +
                '</div>';
            return;
        }

        if (note && note.content) {
            var isExpanded = true;
            $notesList.innerHTML =
                '<div class="note-card generated active-card">' +
                    '<div class="note-card-header">' +
                        '<span class="page-label">第 ' + (idx + 1) + ' 页</span>' +
                        '<div class="card-actions">' +
                            '<button title="保存到笔记本" id="noteSaveToNbBtn"><i data-lucide="book-plus" style="width:14px;height:14px"></i></button>' +
                            '<button title="重新生成" id="noteRegenBtn"><i data-lucide="refresh-cw" style="width:14px;height:14px"></i></button>' +
                            '<button title="编辑" id="noteEditBtn"><i data-lucide="pencil" style="width:14px;height:14px"></i></button>' +
                            '<button title="删除" id="noteDeleteBtn"><i data-lucide="trash-2" style="width:14px;height:14px"></i></button>' +
                        '</div>' +
                    '</div>' +
                    '<div class="note-card-body expandable" id="noteBody">' +
                        '<div class="note-content markdown-body" id="noteContent" data-raw="' + escapeHtml(note.content) + '" data-placeholder="输入笔记...">' + renderMarkdown(note.content) + '</div>' +
                    '</div>' +
                    '<div class="note-card-footer">' +
                        '<span class="note-timestamp">' + (note.source === 'ai' ? 'AI 生成' : '手动编辑') + ' · ' + formatTime(note.updated_at) + '</span>' +
                        '<button class="expand-toggle" id="noteExpandBtn">收起</button>' +
                    '</div>' +
                '</div>';

            // Bind actions
            document.getElementById('noteSaveToNbBtn').addEventListener('click', function () { saveNoteToNotebook(idx); });
            document.getElementById('noteRegenBtn').addEventListener('click', function () { generateNote(idx); });
            document.getElementById('noteEditBtn').addEventListener('click', function () { toggleEdit(idx); });
            document.getElementById('noteDeleteBtn').addEventListener('click', function () { deleteNote(idx); });
            document.getElementById('noteExpandBtn').addEventListener('click', function () {
                var body = document.getElementById('noteBody');
                isExpanded = !isExpanded;
                body.classList.toggle('collapsed', !isExpanded);
                this.textContent = isExpanded ? '收起' : '展开';
            });
        } else {
            // Empty state with generate button
            var disabled = false;
            $notesList.innerHTML =
                '<div class="note-card">' +
                    '<div class="note-card-header">' +
                        '<span class="page-label">第 ' + (idx + 1) + ' 页</span>' +
                    '</div>' +
                    '<div class="note-empty">' +
                        '<i data-lucide="notebook-pen" style="width:32px;height:32px;opacity:0.3;"></i>' +
                        '<p>暂无笔记</p>' +
                        '<button class="generate-btn" id="noteGenBtn"' + (disabled ? ' disabled title="知识图谱尚未就绪"' : '') + '>' +
                            '<i data-lucide="sparkles" style="width:12px;height:12px"></i>' +
                            '<span>生成笔记</span>' +
                        '</button>' +
                    '</div>' +
                '</div>';

            var genBtn = document.getElementById('noteGenBtn');
            if (genBtn && !disabled) {
                genBtn.addEventListener('click', function () { generateNote(idx); });
            }
        }

        if (window.lucide) window.lucide.createIcons();
        // Post-process: KaTeX math + Heti typography
        var noteEl = document.getElementById('noteContent');
        postProcessMarkdown(noteEl);
    }

    // ── Note actions ──────────────────────────────────────────────────────────
    function getSelectedNoteType() {
        var select = document.getElementById('noteTypeSelect');
        return select ? select.value : 'note';
    }

    function generateNote(pageIndex) {
        state.generating[pageIndex] = true;
        renderNote(pageIndex);

        // 获取当前页面的文本内容，优先从 pdf.js 提取（确保与渲染页面一致）
        var textPromise;
        if (state.isPdf && state.pdfDoc) {
            textPromise = state.pdfDoc.getPage(pageIndex + 1).then(function (page) {
                return page.getTextContent();
            }).then(function (textContent) {
                return textContent.items.map(function (item) { return item.str; }).join(' ');
            }).catch(function () { return ''; });
        } else if (state.pageContents[pageIndex] !== undefined) {
            textPromise = Promise.resolve(state.pageContents[pageIndex]);
        } else {
            textPromise = Promise.resolve('');
        }

        textPromise.then(function (pageText) {
            var args = {
                sessionId: state.sessionId,
                pageIndex: pageIndex,
                noteType: getSelectedNoteType(),
            };
            if (pageText && pageText.trim()) {
                args.pageContent = pageText;
            }
            var cpEl = document.getElementById('notesCustomPrompt');
            if (cpEl && cpEl.value.trim()) {
                args.customPrompt = cpEl.value.trim();
            }
            return invoke('doc_reader_generate_note', args);
        }).catch(function (err) {
            console.error('generate_note failed:', err);
            state.generating[pageIndex] = false;
            renderNote(pageIndex);
        });
    }

    function handleGenerateAll() {
        if (!state.sessionId) return;
        $generateAllBtn.disabled = true;
        $generateAllBtn.innerHTML = '<i data-lucide="sparkles" style="width:14px;height:14px"></i><span>生成中...</span>';
        if (window.lucide) window.lucide.createIcons();
        $progressBar.classList.add('active');

        invoke('doc_reader_generate_all', {
            sessionId: state.sessionId,
            noteType: getSelectedNoteType(),
        }).catch(function (err) {
            console.error('generate_all failed:', err);
            $generateAllBtn.disabled = false;
            $generateAllBtn.innerHTML = '<i data-lucide="sparkles" style="width:14px;height:14px"></i><span>全部生成</span><div class="shimmer"></div>';
            if (window.lucide) window.lucide.createIcons();
            $progressBar.classList.remove('active');
        });
    }

    function toggleEdit(pageIndex) {
        var content = document.getElementById('noteContent');
        if (!content) return;

        if (content.contentEditable === 'true') {
            // Save
            content.contentEditable = 'false';
            var newContent = content.textContent;
            invoke('doc_reader_save_note', {
                sessionId: state.sessionId,
                pageIndex: pageIndex,
                content: newContent,
            }).then(function () {
                state.notes[pageIndex].content = newContent;
                state.notes[pageIndex].source = 'manual';
                renderNote(pageIndex);
            }).catch(function (err) {
                console.error('save_note failed:', err);
            });
        } else {
            // Enter edit mode: show raw markdown for editing
            var raw = content.getAttribute('data-raw') || content.textContent;
            content.contentEditable = 'true';
            content.textContent = raw;
            content.focus();
            // move cursor to end
            var range = document.createRange();
            range.selectNodeContents(content);
            range.collapse(false);
            var sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
        }
    }

    function deleteNote(pageIndex) {
        if (!confirm('确定删除第 ' + (pageIndex + 1) + ' 页的笔记？')) return;

        invoke('doc_reader_delete_note', {
            sessionId: state.sessionId,
            pageIndex: pageIndex,
        }).then(function () {
            delete state.notes[pageIndex];
            state.pages[pageIndex].has_note = false;
            updateThumbNote(pageIndex);
            updateNotesCount();
            renderNote(pageIndex);
        }).catch(function (err) {
            console.error('delete_note failed:', err);
        });
    }

    function saveNoteToNotebook(pageIndex) {
        // Check active notebook
        var nbState = window.NotebookManager && window.NotebookManager.getState ? window.NotebookManager.getState() : null;
        if (!nbState || !nbState.activeNotebookId) {
            alert('请先在「笔记本」标签页中选择或创建一个笔记本');
            return;
        }
        var note = state.notes[pageIndex];
        if (!note || !note.content) {
            alert('当前页面没有笔记可保存');
            return;
        }

        var title = '第 ' + (pageIndex + 1) + ' 页笔记 — ' + (state.title || '文档');
        var btn = document.getElementById('noteSaveToNbBtn');

        invoke('notebook_add_entry', {
            notebookId: nbState.activeNotebookId,
            title: title,
            content: note.content,
            entryType: 'ai_note',
            sourceInfo: state.title + ' · 第 ' + (pageIndex + 1) + ' 页',
        }).then(function () {
            if (btn) {
                btn.innerHTML = '<i data-lucide="check" style="width:14px;height:14px;color:var(--secondary)"></i>';
                if (window.lucide) window.lucide.createIcons();
                setTimeout(function () {
                    btn.innerHTML = '<i data-lucide="book-plus" style="width:14px;height:14px"></i>';
                    if (window.lucide) window.lucide.createIcons();
                }, 1500);
            }
            // Refresh notebook entries
            if (window.NotebookManager && window.NotebookManager.loadNotebooks) {
                window.NotebookManager.loadNotebooks();
            }
        }).catch(function (err) {
            console.error('保存到笔记本失败:', err);
            alert('保存到笔记本失败: ' + String(err));
        });
    }

    function loadAllNotes() {
        invoke('doc_reader_get_session', { sessionId: state.sessionId })
            .then(function (res) {
                state.notes = {};
                (res.notes || []).forEach(function (n) {
                    state.notes[n.page_index] = n;
                    if (state.pages[n.page_index]) state.pages[n.page_index].has_note = true;
                });
                renderThumbnails();
                updateThumbActive(state.currentPage);
                updateNotesCount();
                renderNote(state.currentPage);
            });
    }

    // ── Resizer ───────────────────────────────────────────────────────────────
    function setupResizer() {
        var resizer = document.getElementById('panelResizer');
        var panelDoc = document.getElementById('panelDoc');
        var panelNotes = document.getElementById('panelNotes');
        if (!resizer || !panelDoc || !panelNotes) return;

        resizer.addEventListener('mousedown', function (e) {
            e.preventDefault();
            var startX = e.clientX;
            var container = panelDoc.parentElement;
            var totalWidth = container.clientWidth - resizer.offsetWidth;
            var startDocW = panelDoc.offsetWidth;
            var snapThreshold = 50; // px from edge to trigger snap
            var snappedSide = null; // 'doc' or 'notes' or null
            resizer.classList.add('dragging');
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
            document.addEventListener('mousemove', onDrag);
            document.addEventListener('mouseup', onStop);

            function onDrag(ev) {
                var diff = ev.clientX - startX;
                var newDocW = startDocW + diff;
                var notesW = totalWidth - newDocW;

                // Snap detection: near left edge → notes fullscreen
                if (newDocW < snapThreshold) {
                    snappedSide = 'notes';
                    panelDoc.style.flex = '0 0 0%';
                    panelNotes.style.flex = '0 0 100%';
                    resizer.style.opacity = '0.3';
                    return;
                }
                // Snap detection: near right edge → doc fullscreen
                if (notesW < snapThreshold) {
                    snappedSide = 'doc';
                    panelDoc.style.flex = '0 0 100%';
                    panelNotes.style.flex = '0 0 0%';
                    resizer.style.opacity = '0.3';
                    return;
                }

                snappedSide = null;
                resizer.style.opacity = '';
                // Minimum 10% for each panel during normal drag
                var minW = totalWidth * 0.1;
                newDocW = Math.max(minW, Math.min(totalWidth - minW, newDocW));
                var docPct = (newDocW / totalWidth) * 100;
                panelDoc.style.flex = '0 0 ' + docPct + '%';
                panelNotes.style.flex = '0 0 ' + (100 - docPct) + '%';
            }
            function onStop() {
                resizer.classList.remove('dragging');
                resizer.style.opacity = '';
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
                document.removeEventListener('mousemove', onDrag);
                document.removeEventListener('mouseup', onStop);

                if (snappedSide === 'notes') {
                    panelDoc.style.flex = '';
                    panelNotes.style.flex = '';
                    container.classList.add('notes-fullscreen');
                    container.classList.remove('doc-fullscreen');
                } else if (snappedSide === 'doc') {
                    panelDoc.style.flex = '';
                    panelNotes.style.flex = '';
                    container.classList.add('doc-fullscreen');
                    container.classList.remove('notes-fullscreen');
                }

                // Re-render PDF to fit new width
                if (state.isPdf && state.pdfDoc) {
                    state._lastPdfRender = null;
                    deferRenderPdfPage(state.currentPage, 50);
                }
            }
        });
    }

    // ── UI helpers ────────────────────────────────────────────────────────────
    function updateKgBadge() {
        // KG 已移除，badge 始终显示就绪
        if ($kgBadge) $kgBadge.style.display = 'none';
    }

    function updateNotesCount() {
        var count = 0;
        for (var i = 0; i < state.pageCount; i++) {
            if (state.notes[i]) count++;
        }
        $notesCount.textContent = count + ' / ' + state.pageCount;
    }

    function formatTime(str) {
        if (!str) return '';
        try {
            var d = new Date(str);
            return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
        } catch (e) { return str; }
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

    function escapeHtml(str) {
        var div = document.createElement('div');
        div.textContent = str || '';
        return div.innerHTML;
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Settings Modal — LLM 模型配置管理
    // ══════════════════════════════════════════════════════════════════════════
    var settingsState = {
        models: [],       // 当前完整配置 (raw, 含 api_key)
        editIndex: -1,    // -1 = 新增模式, >=0 = 编辑索引
        formVisible: true,
    };

    function setupSettings() {
        var btn = document.getElementById('settingsBtn');
        var modal = document.getElementById('settingsModal');
        var closeBtn = document.getElementById('settingsModalClose');
        if (!btn || !modal) return;

        btn.addEventListener('click', function () {
            openSettingsModal();
        });
        closeBtn.addEventListener('click', function () {
            modal.style.display = 'none';
        });
        modal.addEventListener('click', function (e) {
            if (e.target === modal) modal.style.display = 'none';
        });

        // Form toggle
        var formToggle = document.getElementById('settingsFormToggle');
        var formBody = document.getElementById('settingsFormBody');
        if (formToggle && formBody) {
            formToggle.addEventListener('click', function () {
                settingsState.formVisible = !settingsState.formVisible;
                formBody.style.display = settingsState.formVisible ? '' : 'none';
                formToggle.textContent = settingsState.formVisible ? '收起' : '展开';
            });
        }

        // Provider change → auto-fill api_base
        var providerSel = document.getElementById('sfProvider');
        if (providerSel) {
            providerSel.addEventListener('change', function () {
                var base = document.getElementById('sfApiBase');
                if (!base) return;
                if (providerSel.value === 'openai') base.placeholder = 'https://api.openai.com/v1';
                else if (providerSel.value === 'anthropic') base.placeholder = 'https://api.anthropic.com';
                else base.placeholder = 'https://your-api.example.com/v1';
            });
        }

        // Save button
        var saveBtn = document.getElementById('sfSaveBtn');
        if (saveBtn) saveBtn.addEventListener('click', saveModelFromForm);

        // Test button
        var testBtn = document.getElementById('sfTestBtn');
        if (testBtn) testBtn.addEventListener('click', testModelFromForm);

        // Cancel edit
        var cancelEdit = document.getElementById('sfCancelEdit');
        if (cancelEdit) cancelEdit.addEventListener('click', resetSettingsForm);
    }

    function openSettingsModal() {
        var modal = document.getElementById('settingsModal');
        if (!modal) return;
        modal.style.display = '';
        loadSettingsModels();
    }

    function loadSettingsModels() {
        invoke('get_llm_models_raw').then(function (models) {
            settingsState.models = models || [];
            renderSettingsModelList();
        }).catch(function (err) {
            console.error('加载模型配置失败:', err);
            settingsState.models = [];
            renderSettingsModelList();
        });
    }

    function renderSettingsModelList() {
        var list = document.getElementById('settingsModelList');
        var empty = document.getElementById('settingsEmpty');
        if (!list) return;

        // Remove all children except the empty state
        var children = list.querySelectorAll('.settings-model-card');
        children.forEach(function (c) { c.remove(); });

        if (settingsState.models.length === 0) {
            if (empty) empty.style.display = '';
            return;
        }
        if (empty) empty.style.display = 'none';

        settingsState.models.forEach(function (m, i) {
            var card = document.createElement('div');
            card.className = 'settings-model-card' + (m.enabled ? '' : ' disabled');
            var proxyTag = m.use_proxy === false
                ? '<code style="color:var(--destructive);">无代理</code>'
                : '<code style="color:#059669;">代理</code>';
            card.innerHTML =
                '<div class="smc-row">' +
                    '<div>' +
                        '<div class="smc-name">' + escapeHtml(m.name || '未命名') + '</div>' +
                        '<div class="smc-detail">' +
                            '<code>' + escapeHtml(m.provider) + '</code>' +
                            '<code>' + escapeHtml(m.model) + '</code>' +
                            proxyTag +
                            '<span>' + escapeHtml(maskKey(m.api_key)) + '</span>' +
                        '</div>' +
                    '</div>' +
                    '<div class="smc-actions">' +
                        '<span class="smc-test-badge" data-idx="' + i + '" style="display:none;"></span>' +
                        '<button class="btn-sm" data-action="test" data-idx="' + i + '" title="测试">测试</button>' +
                        '<button class="btn-sm" data-action="edit" data-idx="' + i + '" title="编辑">编辑</button>' +
                        '<button class="btn-sm danger" data-action="delete" data-idx="' + i + '" title="删除">删除</button>' +
                        '<button class="smc-toggle' + (m.enabled ? ' on' : '') + '" data-action="toggle" data-idx="' + i + '"></button>' +
                    '</div>' +
                '</div>';
            card.addEventListener('click', handleModelCardAction);
            list.appendChild(card);
        });

        if (window.lucide) window.lucide.createIcons();
    }

    function maskKey(key) {
        if (!key) return '***';
        if (key.length <= 8) return '****';
        return key.substring(0, 4) + '****' + key.substring(key.length - 4);
    }

    function handleModelCardAction(e) {
        var target = e.target.closest('[data-action]');
        if (!target) return;
        var action = target.getAttribute('data-action');
        var idx = parseInt(target.getAttribute('data-idx'), 10);

        if (action === 'toggle') toggleModel(idx);
        else if (action === 'edit') editModel(idx);
        else if (action === 'delete') deleteModel(idx);
        else if (action === 'test') testModel(idx);
    }

    function toggleModel(idx) {
        var m = settingsState.models[idx];
        if (!m) return;
        m.enabled = !m.enabled;
        saveAllModels();
    }

    function editModel(idx) {
        var m = settingsState.models[idx];
        if (!m) return;
        settingsState.editIndex = idx;

        var sfName = document.getElementById('sfName');
        var sfProvider = document.getElementById('sfProvider');
        var sfApiBase = document.getElementById('sfApiBase');
        var sfApiKey = document.getElementById('sfApiKey');
        var sfModel = document.getElementById('sfModel');
        var cancelBtn = document.getElementById('sfCancelEdit');
        var formTitle = document.getElementById('settingsFormTitle');

        if (sfName) sfName.value = m.name || '';
        if (sfProvider) sfProvider.value = m.provider || 'openai';
        if (sfApiBase) sfApiBase.value = m.api_base || '';
        if (sfApiKey) sfApiKey.value = m.api_key || '';
        if (sfModel) sfModel.value = m.model || '';
        var sfProxy = document.getElementById('sfUseProxy');
        if (sfProxy) sfProxy.checked = m.use_proxy !== false;
        if (cancelBtn) cancelBtn.style.display = '';
        if (formTitle) formTitle.textContent = '编辑模型 #' + (idx + 1);

        // Ensure form visible
        var formBody = document.getElementById('settingsFormBody');
        var formToggle = document.getElementById('settingsFormToggle');
        if (formBody) formBody.style.display = '';
        if (formToggle) formToggle.textContent = '收起';
        settingsState.formVisible = true;
    }

    function deleteModel(idx) {
        if (!settingsState.models[idx]) return;
        settingsState.models.splice(idx, 1);
        if (settingsState.editIndex === idx) resetSettingsForm();
        saveAllModels();
    }

    function testModel(idx) {
        var m = settingsState.models[idx];
        if (!m) return;
        var badge = document.querySelector('.smc-test-badge[data-idx="' + idx + '"]');
        if (badge) {
            badge.style.display = '';
            badge.className = 'smc-test-badge testing';
            badge.textContent = '测试中…';
        }
        console.log('[Settings] Testing model:', m.name, m.provider, m.model);
        invoke('test_llm_model', { model: m }).then(function (res) {
            console.log('[Settings] Test result:', res);
            if (badge) {
                badge.className = 'smc-test-badge ' + (res.success ? 'ok' : 'fail');
                badge.textContent = res.success ? '连接成功' : ('失败: ' + (res.error || '').substring(0, 40));
                badge.title = res.success ? (res.reply || '') : (res.error || '');
            }
        }).catch(function (err) {
            console.error('[Settings] Test error:', err);
            if (badge) {
                badge.className = 'smc-test-badge fail';
                badge.textContent = '调用失败';
                badge.title = String(err);
            }
        });
    }

    function testModelFromForm() {
        var m = readFormModel();
        if (!m.model || !m.api_key) return;
        var testBtn = document.getElementById('sfTestBtn');
        if (testBtn) { testBtn.disabled = true; testBtn.textContent = '测试中…'; }
        invoke('test_llm_model', { model: m }).then(function (res) {
            console.log('[Settings] Form test result:', res);
            if (testBtn) {
                testBtn.disabled = false;
                testBtn.textContent = res.success ? '✓ 成功' : '✗ 失败';
                testBtn.title = res.success ? (res.reply || '') : (res.error || '');
                setTimeout(function () { testBtn.textContent = '测试连接'; testBtn.title = ''; }, 4000);
            }
        }).catch(function (err) {
            console.error('[Settings] Form test error:', err);
            if (testBtn) { testBtn.disabled = false; testBtn.textContent = '✗ 调用失败'; }
        });
    }

    function saveModelFromForm() {
        var m = readFormModel();
        if (!m.name || !m.model) return;

        if (settingsState.editIndex >= 0) {
            // Update existing
            settingsState.models[settingsState.editIndex] = m;
        } else {
            // Add new
            settingsState.models.push(m);
        }
        saveAllModels();
        resetSettingsForm();
    }

    function readFormModel() {
        var proxyEl = document.getElementById('sfUseProxy');
        return {
            name: (document.getElementById('sfName') || {}).value || '',
            provider: (document.getElementById('sfProvider') || {}).value || 'openai',
            api_base: (document.getElementById('sfApiBase') || {}).value || '',
            api_key: (document.getElementById('sfApiKey') || {}).value || '',
            model: (document.getElementById('sfModel') || {}).value || '',
            enabled: settingsState.editIndex >= 0
                ? settingsState.models[settingsState.editIndex].enabled
                : true,
            use_proxy: proxyEl ? proxyEl.checked : true,
        };
    }

    function resetSettingsForm() {
        settingsState.editIndex = -1;
        ['sfName', 'sfApiBase', 'sfApiKey', 'sfModel'].forEach(function (id) {
            var el = document.getElementById(id);
            if (el) el.value = '';
        });
        var provider = document.getElementById('sfProvider');
        if (provider) provider.value = 'openai';
        var proxyEl = document.getElementById('sfUseProxy');
        if (proxyEl) proxyEl.checked = true;
        var cancelBtn = document.getElementById('sfCancelEdit');
        if (cancelBtn) cancelBtn.style.display = 'none';
        var formTitle = document.getElementById('settingsFormTitle');
        if (formTitle) formTitle.textContent = '添加新模型';
    }

    function saveAllModels() {
        invoke('save_llm_models', { models: settingsState.models }).then(function () {
            renderSettingsModelList();
        }).catch(function (err) {
            console.error('保存模型配置失败:', err);
        });
    }

    // ── Expose ───────────────────────────────────────────────────────────────
    window.DocReader = {
        init: init,
        getState: function () { return state; },
        saveWorkspace: saveWorkspace,
    };

    // ── Workspace persistence ────────────────────────────────────────────────
    var WORKSPACE_KEY = 'dr_workspace';

    function saveWorkspace() {
        if (!state.sessionId) return;
        var data = {
            sessionId: state.sessionId,
            currentPage: state.currentPage,
            zoom: state.zoom,
            title: state.title,
            isPdf: state.isPdf,
            isPpt: state.isPpt,
            timestamp: Date.now(),
        };
        try {
            localStorage.setItem(WORKSPACE_KEY, JSON.stringify(data));
        } catch (e) { /* ignore quota errors */ }
    }

    function restoreWorkspace() {
        try {
            var raw = localStorage.getItem(WORKSPACE_KEY);
            if (raw) {
                var data = JSON.parse(raw);
                if (data && data.sessionId) {
                    // Verify session still exists in DB
                    invoke('doc_reader_get_session', { sessionId: data.sessionId })
                        .then(function (res) {
                            if (!res || !res.session) {
                                localStorage.removeItem(WORKSPACE_KEY);
                                loadRecentSessions();
                                return;
                            }
                            // Restore session
                            loadSession(data.sessionId);
                            // Restore zoom
                            if (data.zoom && data.zoom !== 100) {
                                state.zoom = data.zoom;
                                var zoomEl = document.getElementById('zoomLevel');
                                if (zoomEl) zoomEl.textContent = state.zoom + '%';
                            }
                            // Restore page after a short delay to let session load complete
                            if (data.currentPage > 0) {
                                setTimeout(function () {
                                    goToPage(data.currentPage);
                                }, 300);
                            }
                        })
                        .catch(function () {
                            localStorage.removeItem(WORKSPACE_KEY);
                            loadRecentSessions();
                        });
                    return;
                }
            }
        } catch (e) {
            localStorage.removeItem(WORKSPACE_KEY);
        }
        // No saved workspace, show recent sessions
        loadRecentSessions();
    }

    function loadRecentSessions() {
        invoke('doc_reader_list_sessions', { limit: 5 })
            .then(function (res) {
                var sessions = res.sessions || [];
                if (sessions.length === 0) return;
                var container = document.getElementById('recentSessions');
                var list = document.getElementById('recentSessionsList');
                if (!container || !list) return;
                container.style.display = '';
                list.innerHTML = '';
                sessions.forEach(function (s) {
                    var card = document.createElement('div');
                    card.className = 'recent-session-card';
                    var ext = (s.filename || '').split('.').pop().toLowerCase();
                    var iconName, iconClass;
                    if (ext === 'pdf') { iconName = 'file-text'; iconClass = 'pdf'; }
                    else if (ext === 'pptx' || ext === 'ppt') { iconName = 'presentation'; iconClass = 'ppt'; }
                    else { iconName = 'file'; iconClass = 'doc'; }
                    var timeStr = '';
                    try { timeStr = new Date(s.created_at).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch (e) {}
                    card.innerHTML =
                        '<div class="rs-icon ' + iconClass + '"><i data-lucide="' + iconName + '" style="width:18px;height:18px;"></i></div>' +
                        '<div class="rs-info">' +
                            '<div class="rs-name">' + escapeHtml(s.filename) + '</div>' +
                            '<div class="rs-meta"><span>' + s.page_count + ' 页</span><span>' + timeStr + '</span></div>' +
                        '</div>' +
                        (s.note_count > 0 ? '<span class="rs-badge">' + s.note_count + ' 笔记</span>' : '');
                    card.addEventListener('click', function () {
                        loadSession(s.session_id);
                    });
                    list.appendChild(card);
                });
                if (window.lucide) window.lucide.createIcons();
            })
            .catch(function () { /* ignore */ });
    }

    // Auto-save workspace on page navigation, note generation, and before unload
    window.addEventListener('beforeunload', saveWorkspace);

})();
