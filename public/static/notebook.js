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

    // ── State ────────────────────────────────────────────────────────────────
    var nbState = {
        notebooks: [],           // [ { notebook_id, name, description, color, entry_count, ... } ]
        activeNotebookId: null,  // 当前选中的笔记本ID
        entries: [],             // 当前笔记本的条目列表
        previewEntryId: null,    // 当前预览的条目ID
        editingNotebookId: null, // 正在编辑的笔记本ID (null = 新建)
        pptFiles: [],            // PPT导入时选择的文件列表
        annotating: false,       // 是否正在进行文本标注
    };

    // ── DOM refs ─────────────────────────────────────────────────────────────
    var $notebookSelect, $nbEntriesList, $nbPreviewPanel, $nbPreviewTitle, $nbPreviewBody;
    var $nbActionBar;

    // ── Init ─────────────────────────────────────────────────────────────────
    function init() {
        cacheDom();
        bindTabEvents();
        bindNotebookEvents();
        bindModalEvents();
        bindPptEvents();
        bindAnnotateEvents();
        bindNbPdfPageNoteBtn();
        bindPageRangeEvents();
        bindTextSelectEvents();
        setupListeners();
        loadNotebooks();
        if (window.lucide) window.lucide.createIcons();
    }

    function cacheDom() {
        $notebookSelect = document.getElementById('notebookSelect');
        $nbEntriesList = document.getElementById('nbEntriesList');
        $nbPreviewPanel = document.getElementById('nbPreviewPanel');
        $nbPreviewTitle = document.getElementById('nbPreviewTitle');
        $nbPreviewBody = document.getElementById('nbPreviewBody');
        $nbActionBar = document.getElementById('nbActionBar');
    }

    // ── Tab switching ────────────────────────────────────────────────────────
    function bindTabEvents() {
        var tabs = document.querySelectorAll('.sidebar-tab');
        tabs.forEach(function (tab) {
            tab.addEventListener('click', function () {
                var target = tab.dataset.tab;
                tabs.forEach(function (t) { t.classList.remove('active'); });
                tab.classList.add('active');

                document.querySelectorAll('.sidebar-tab-content').forEach(function (c) {
                    c.classList.remove('active');
                });
                if (target === 'ai-notes') {
                    document.getElementById('tabAiNotes').classList.add('active');
                } else {
                    document.getElementById('tabNotebooks').classList.add('active');
                }
                if (window.lucide) window.lucide.createIcons();
            });
        });
    }

    // ── Notebook CRUD events ─────────────────────────────────────────────────
    function bindNotebookEvents() {
        // Notebook select change
        $notebookSelect.addEventListener('change', function () {
            var id = $notebookSelect.value;
            if (id) {
                nbState.activeNotebookId = id;
                loadNotebookEntries(id);
                enableNotebookActions(true);
            } else {
                nbState.activeNotebookId = null;
                nbState.entries = [];
                renderEntries();
                enableNotebookActions(false);
                hidePreview();
            }
        });

        // Create notebook
        document.getElementById('nbCreateBtn').addEventListener('click', function () {
            nbState.editingNotebookId = null;
            openNotebookModal('新建笔记本', '', '', '#7C5CFC');
        });

        // Edit notebook
        document.getElementById('nbEditBtn').addEventListener('click', function () {
            if (!nbState.activeNotebookId) return;
            var nb = nbState.notebooks.find(function (n) { return n.notebook_id === nbState.activeNotebookId; });
            if (!nb) return;
            nbState.editingNotebookId = nbState.activeNotebookId;
            openNotebookModal('编辑笔记本', nb.name, nb.description || '', nb.color || '#7C5CFC');
        });

        // Delete notebook
        document.getElementById('nbDeleteBtn').addEventListener('click', function () {
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
        document.getElementById('nbAddNoteBtn').addEventListener('click', function () {
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
        document.getElementById('nbPreviewCloseBtn').addEventListener('click', hidePreview);

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

        // Preview edit
        document.getElementById('nbPreviewEditBtn').addEventListener('click', function () {
            if (!nbState.previewEntryId) return;
            var entry = nbState.entries.find(function (e) { return e.entry_id === nbState.previewEntryId; });
            if (!entry) return;
            var newContent = prompt('编辑笔记内容:', entry.content);
            if (newContent === null) return;
            var newTitle = newContent.substring(0, 30).trim() || entry.title;
            invoke('notebook_update_entry', {
                entryId: entry.entry_id,
                title: newTitle,
                content: newContent,
            }).then(function () {
                // Update local entry data immediately so preview reflects the edit
                entry.title = newTitle;
                entry.content = newContent;
                loadNotebookEntries(nbState.activeNotebookId);
                showPreview(entry.entry_id, newTitle, newContent);
            }).catch(function (err) { console.error('更新笔记条目失败:', err); });
        });
    }

    function enableNotebookActions(enabled) {
        document.getElementById('nbEditBtn').disabled = !enabled;
        document.getElementById('nbDeleteBtn').disabled = !enabled;
        $nbActionBar.style.display = enabled ? 'flex' : 'none';

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

        document.getElementById('nbImportPptBtn').addEventListener('click', function () {
            if (!nbState.activeNotebookId) return;
            nbState.pptFiles = [];
            renderPptFileList();
            modal.style.display = 'flex';
            if (window.lucide) window.lucide.createIcons();
        });

        document.getElementById('pptModalClose').addEventListener('click', function () { modal.style.display = 'none'; });
        document.getElementById('pptModalCancel').addEventListener('click', function () { modal.style.display = 'none'; });
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

    // ── Text Annotation ──────────────────────────────────────────────────────
    function bindAnnotateEvents() {
        var modal = document.getElementById('annotateModal');
        var textArea = document.getElementById('annotateText');
        var submitBtn = document.getElementById('annotateModalSubmit');

        document.getElementById('nbAnnotateBtn').addEventListener('click', function () {
            if (!nbState.activeNotebookId) return;
            textArea.value = '';
            document.getElementById('annotateContext').value = '';
            submitBtn.disabled = true;
            modal.style.display = 'flex';
            if (window.lucide) window.lucide.createIcons();
            setTimeout(function () { textArea.focus(); }, 100);
        });

        document.getElementById('annotateModalClose').addEventListener('click', function () { modal.style.display = 'none'; });
        document.getElementById('annotateModalCancel').addEventListener('click', function () { modal.style.display = 'none'; });
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

    function showGeneratingIndicator() {
        // Insert a temporary generating card at top of entries
        var indicator = document.createElement('div');
        indicator.className = 'nb-generating';
        indicator.id = 'nbGeneratingIndicator';
        indicator.innerHTML = '<div class="spinner"></div><span>AI 正在分析文本...</span>';
        $nbEntriesList.insertBefore(indicator, $nbEntriesList.firstChild);
    }

    function showGeneratingIndicatorCustom(id, message) {
        var indicator = document.createElement('div');
        indicator.className = 'nb-generating';
        indicator.id = id;
        indicator.innerHTML = '<div class="spinner"></div><span>' + escapeHtml(message) + '</span>';
        $nbEntriesList.insertBefore(indicator, $nbEntriesList.firstChild);
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
                showGeneratingIndicatorCustom('nbPageRangeIndicator', 'AI 正在生成第 ' + ranges + ' 页笔记...');
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
                showGeneratingIndicatorCustom('nbTextNoteIndicator', 'AI 正在分析选中文本...');
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
    function setupListeners() {
        listen('notebook-annotate-done', function (data) {
            nbState.annotating = false;
            var indicator = document.getElementById('nbGeneratingIndicator');
            if (indicator) indicator.remove();
            // Refresh entries if the annotation was for the active notebook
            if (data.notebook_id === nbState.activeNotebookId) {
                loadNotebookEntries(nbState.activeNotebookId);
            }
        });

        listen('notebook-annotate-error', function (data) {
            nbState.annotating = false;
            var indicator = document.getElementById('nbGeneratingIndicator');
            if (indicator) indicator.remove();
            console.error('文本标注失败:', data.error);
        });

        listen('notebook-page-range-done', function (data) {
            var indicator = document.getElementById('nbPageRangeIndicator');
            if (indicator) indicator.remove();
            if (data.notebook_id === nbState.activeNotebookId) {
                loadNotebookEntries(nbState.activeNotebookId);
            }
        });

        listen('notebook-page-range-error', function (data) {
            var indicator = document.getElementById('nbPageRangeIndicator');
            if (indicator) indicator.remove();
            console.error('选页笔记生成失败:', data.error);
            alert('选页笔记生成失败: ' + (data.error || '未知错误'));
        });

        listen('notebook-text-note-done', function (data) {
            var indicator = document.getElementById('nbTextNoteIndicator');
            if (indicator) indicator.remove();
            if (data.notebook_id === nbState.activeNotebookId) {
                loadNotebookEntries(nbState.activeNotebookId);
            }
        });

        listen('notebook-text-note-error', function (data) {
            var indicator = document.getElementById('nbTextNoteIndicator');
            if (indicator) indicator.remove();
            console.error('选文笔记生成失败:', data.error);
            alert('选文笔记生成失败: ' + (data.error || '未知错误'));
        });
    }

    // ── Data loading ─────────────────────────────────────────────────────────
    function loadNotebooks() {
        invoke('notebook_list')
            .then(function (res) {
                nbState.notebooks = res.notebooks || [];
                renderNotebookSelect();
                // Auto-select active notebook if it still exists
                if (nbState.activeNotebookId) {
                    var exists = nbState.notebooks.some(function (n) { return n.notebook_id === nbState.activeNotebookId; });
                    if (exists) {
                        $notebookSelect.value = nbState.activeNotebookId;
                        enableNotebookActions(true);
                        loadNotebookEntries(nbState.activeNotebookId);
                    } else {
                        nbState.activeNotebookId = null;
                        enableNotebookActions(false);
                        renderEntries();
                    }
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
                renderEntries();
            })
            .catch(function (err) {
                console.error('加载笔记条目失败:', err);
            });
    }

    // ── Rendering ────────────────────────────────────────────────────────────
    function renderNotebookSelect() {
        var val = $notebookSelect.value;
        $notebookSelect.innerHTML = '<option value="">-- 选择笔记本 --</option>';
        nbState.notebooks.forEach(function (nb) {
            var opt = document.createElement('option');
            opt.value = nb.notebook_id;
            opt.textContent = nb.name + ' (' + (nb.entry_count || 0) + ')';
            opt.style.borderLeft = '3px solid ' + (nb.color || '#7C5CFC');
            $notebookSelect.appendChild(opt);
        });
        // Restore selection
        if (nbState.activeNotebookId) {
            $notebookSelect.value = nbState.activeNotebookId;
        } else if (val) {
            $notebookSelect.value = val;
        }
    }

    function renderEntries() {
        if (nbState.entries.length === 0) {
            if (nbState.activeNotebookId) {
                $nbEntriesList.innerHTML =
                    '<div class="nb-empty-state">' +
                        '<i data-lucide="file-text" style="width:32px;height:32px;opacity:0.25;"></i>' +
                        '<p>笔记本为空，点击上方按钮添加笔记</p>' +
                    '</div>';
            } else {
                $nbEntriesList.innerHTML =
                    '<div class="nb-empty-state">' +
                        '<i data-lucide="notebook" style="width:36px;height:36px;opacity:0.25;"></i>' +
                        '<p>选择或创建笔记本开始记录</p>' +
                    '</div>';
            }
            if (window.lucide) window.lucide.createIcons();
            return;
        }

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
    function showPreview(entryId, title, content) {
        nbState.previewEntryId = entryId;
        $nbPreviewTitle.textContent = '全部笔记预览';
        $nbPreviewPanel.style.display = 'flex';

        // Render ALL entries into preview body with dividers
        var html = '';
        nbState.entries.forEach(function (entry) {
            var isActive = entry.entry_id === entryId;
            html += '<section class="nb-preview-section" data-entry-id="' + entry.entry_id + '"' +
                (isActive ? ' id="nb-preview-active"' : '') + '>' +
                '<h2 class="nb-preview-section-title" style="font-size:15px;font-weight:600;padding:10px 0 6px;margin:0;border-bottom:2px solid ' +
                (isActive ? 'var(--primary)' : 'var(--border)') + ';">' +
                escapeHtml(entry.title || '无标题') + '</h2>' +
                '<div class="markdown-body" style="padding:12px 0 24px;">' +
                renderMarkdown(entry.content || '') + '</div>' +
                '</section>';
        });
        $nbPreviewBody.innerHTML = html;
        $nbPreviewBody.classList.add('markdown-body');

        // Post-process each section
        $nbPreviewBody.querySelectorAll('.nb-preview-section .markdown-body').forEach(function (el) {
            postProcessMarkdown(el);
        });
        if (window.lucide) window.lucide.createIcons();

        // Scroll to the clicked entry
        var activeSection = document.getElementById('nb-preview-active');
        if (activeSection) {
            setTimeout(function () {
                activeSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }, 50);
        }
    }

    function showAllPreview() {
        if (!nbState.entries || nbState.entries.length === 0) return;
        showPreview(nbState.entries[0].entry_id, '', '');
    }

    function hidePreview() {
        nbState.previewEntryId = null;
        $nbPreviewPanel.style.display = 'none';
        $nbEntriesList.querySelectorAll('.nb-entry-card').forEach(function (c) { c.classList.remove('active'); });
        // 清理展开/全屏状态，避免关闭后所有内容消失
        var tabContent = $nbPreviewPanel.closest('.sidebar-tab-content');
        var panelNotes = $nbPreviewPanel.closest('.panel-notes');
        if (tabContent) tabContent.classList.remove('preview-expanded');
        if (panelNotes) panelNotes.classList.remove('preview-fullscreen');
        var expandBtn = document.getElementById('nbPreviewExpandBtn');
        if (expandBtn) {
            var icon = expandBtn.querySelector('[data-lucide]');
            if (icon) icon.setAttribute('data-lucide', 'maximize-2');
            if (window.lucide) window.lucide.createIcons();
        }
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
        getState: function () { return nbState; },
    };

})();
