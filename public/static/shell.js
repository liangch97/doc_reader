/**
 * Notebook Helper - Shell Extensions
 * Window controls, Stepper, Tabs, Split View, Bottom Sheet
 */
(function () {
    'use strict';

    /* ==================== WINDOW CONTROLS ==================== */

    function windowInvoke(cmd) {
        if (window.__TAURI_INTERNALS__) {
            return window.__TAURI_INTERNALS__.invoke('plugin:window|' + cmd, { label: 'main' });
        }
        if (window.__TAURI__ && window.__TAURI__.core) {
            return window.__TAURI__.core.invoke('plugin:window|' + cmd, { label: 'main' });
        }
        return Promise.reject(new Error('Tauri not available'));
    }

    function initWindowControls() {
        const controls = document.querySelector('.window-controls');

        if (!window.__TAURI_INTERNALS__ && !(window.__TAURI__ && window.__TAURI__.core)) {
            if (controls) controls.style.display = 'none';
            console.log('[Shell] Not in Tauri environment, hiding window controls');
            return;
        }

        const minimizeBtn = document.getElementById('windowMinimize');
        const maximizeBtn = document.getElementById('windowMaximize');
        const closeBtn = document.getElementById('windowClose');

        if (!minimizeBtn || !maximizeBtn || !closeBtn) {
            console.log('[Shell] Window control buttons not found');
            return;
        }

        minimizeBtn.addEventListener('click', () => {
            windowInvoke('minimize').catch(e => console.error('[Shell] Minimize error:', e));
        });

        maximizeBtn.addEventListener('click', async () => {
            try {
                const isMaximized = await windowInvoke('is_maximized');
                if (isMaximized) {
                    await windowInvoke('unmaximize');
                    maximizeBtn.innerHTML = '<i data-lucide="square"></i>';
                    maximizeBtn.setAttribute('title', '最大化');
                } else {
                    await windowInvoke('maximize');
                    maximizeBtn.innerHTML = '<i data-lucide="copy"></i>';
                    maximizeBtn.setAttribute('title', '还原');
                }
                if (window.lucide) lucide.createIcons({ nodes: [maximizeBtn] });
            } catch (e) {
                console.error('[Shell] Maximize error:', e);
            }
        });

        closeBtn.addEventListener('click', () => {
            windowInvoke('close').catch(e => console.error('[Shell] Close error:', e));
        });

        console.log('[Shell] Window controls initialized');
    }

    /* ==================== STEPPER ==================== */
    const STEPPER = {
        currentStep: 1,
        steps: ['stepUpload', 'stepTypes', 'stepDetail']
    };

    function initStepper() {
        document.querySelectorAll('.stepper-header').forEach(header => {
            header.addEventListener('click', () => {
                const step = header.closest('.stepper-step');
                if (!step) return;
                const stepNum = parseInt(step.getAttribute('data-step'));
                
                // Allow clicking on any step to toggle its body
                toggleStepBody(step);
            });
        });

        // Watch for form changes
        document.addEventListener('change', (e) => {
            if (e.target.name === 'note_types') {
                updateTypesSummary();
            } else if (e.target.name === 'length_preset') {
                updateDetailSummary();
            }
        });

        console.log('[Shell] Stepper initialized');
    }

    function toggleStepBody(step) {
        const body = step.querySelector('.stepper-body');
        if (body) body.classList.toggle('collapsed');
    }

    function completeStep(stepNum, summary) {
        const stepId = STEPPER.steps[stepNum - 1];
        const step = document.getElementById(stepId);
        if (!step) return;

        step.classList.remove('active', 'pending');
        step.classList.add('completed');

        const body = step.querySelector('.stepper-body');
        if (body) body.classList.add('collapsed');

        if (summary) {
            const summaryEl = step.querySelector('.stepper-summary');
            if (summaryEl) summaryEl.textContent = summary;
        }

        // Auto-advance to next step
        const nextStepNum = stepNum + 1;
        const nextStepId = STEPPER.steps[nextStepNum - 1];
        const nextStep = document.getElementById(nextStepId);
        if (nextStep && nextStep.classList.contains('pending')) {
            setActiveStep(nextStepNum);
        }

        if (window.lucide) lucide.createIcons();
    }

    function setActiveStep(stepNum) {
        STEPPER.currentStep = stepNum;
        STEPPER.steps.forEach((stepId, idx) => {
            const step = document.getElementById(stepId);
            if (!step) return;
            const num = idx + 1;
            const body = step.querySelector('.stepper-body');

            step.classList.remove('active', 'pending', 'completed');

            if (num < stepNum) {
                step.classList.add('completed');
                if (body) body.classList.add('collapsed');
            } else if (num === stepNum) {
                step.classList.add('active');
                if (body) body.classList.remove('collapsed');
            } else {
                step.classList.add('pending');
                if (body) body.classList.add('collapsed');
            }
        });

        if (window.lucide) lucide.createIcons();
    }

    function updateTypesSummary() {
        const checkboxes = document.querySelectorAll('input[name="note_types"]:checked');
        const count = checkboxes.length;
        const summaryEl = document.getElementById('stepTypesSummary');
        if (summaryEl) {
            summaryEl.textContent = count === 0 ? '至少选择一种' : `已选 ${count} 种`;
        }
    }

    function updateDetailSummary() {
        const radio = document.querySelector('input[name="length_preset"]:checked');
        if (radio) {
            const labels = { brief: '简略', standard: '标准', detailed: '详细' };
            const summaryEl = document.getElementById('stepDetailSummary');
            if (summaryEl) summaryEl.textContent = labels[radio.value] || radio.value;
        }
    }

    // Hook into file upload completion
    function hookFileUpload() {
        const originalShowFileChip = window.showFileChip;
        // We'll observe the fileChipContainer for changes instead
        const container = document.getElementById('fileChipContainer');
        if (container) {
            const observer = new MutationObserver((mutations) => {
                if (container.children.length > 0) {
                    const fileName = container.querySelector('.file-chip-name');
                    const shortName = fileName && fileName.textContent.length > 15
                        ? fileName.textContent.substring(0, 12) + '...'
                        : (fileName ? fileName.textContent : '已上传');
                    completeStep(1, shortName);
                }
            });
            observer.observe(container, { childList: true });
        }
    }

    /* ==================== TABS & SPLIT VIEW ==================== */
    const TAB_VIEW = {
        activeTab: 'all',
        splitMode: false,
        cellTypes: []
    };

    function initTabsAndView() {
        const splitToggle = document.getElementById('splitViewToggle');
        if (splitToggle) {
            splitToggle.addEventListener('click', toggleSplitView);
        }

        const selectLeft = document.getElementById('splitSelectLeft');
        const selectRight = document.getElementById('splitSelectRight');

        if (selectLeft) {
            selectLeft.addEventListener('change', () => updateSplitPanel('left'));
        }
        if (selectRight) {
            selectRight.addEventListener('change', () => updateSplitPanel('right'));
        }

        initSplitDivider();

        // Observe cells container for changes
        const cellsContainer = document.getElementById('cellsContainer');
        if (cellsContainer) {
            const observer = new MutationObserver(() => updateTabs());
            observer.observe(cellsContainer, { childList: true });
        }

        console.log('[Shell] Tabs and Split View initialized');
    }

    function updateTabs() {
        const cellsContainer = document.getElementById('cellsContainer');
        if (!cellsContainer) return;

        const cells = cellsContainer.querySelectorAll('.cell[id^="cell_"]');
        const tabsContainer = document.getElementById('notebookTabs');
        const tabsList = document.getElementById('tabsList');

        if (!tabsContainer || !tabsList) return;

        TAB_VIEW.cellTypes = [];
        cells.forEach(cell => {
            const id = cell.id.replace('cell_', '');
            const headerText = cell.querySelector('.cell-tag')?.textContent?.trim() || id;
            TAB_VIEW.cellTypes.push({ id, name: headerText });
        });

        // Show/hide tabs based on cell count
        if (TAB_VIEW.cellTypes.length <= 1) {
            tabsContainer.style.display = 'none';
            return;
        }

        tabsContainer.style.display = 'flex';

        // Build tabs HTML
        let html = `<button class="notebook-tab ${TAB_VIEW.activeTab === 'all' ? 'active' : ''}" data-tab="all">
            <i data-lucide="layout-grid"></i>全部
        </button>`;

        TAB_VIEW.cellTypes.forEach(type => {
            const isActive = TAB_VIEW.activeTab === type.id;
            html += `<button class="notebook-tab ${isActive ? 'active' : ''}" data-tab="${type.id}">${escapeHtml(type.name)}</button>`;
        });

        tabsList.innerHTML = html;

        // Bind click events
        tabsList.querySelectorAll('.notebook-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                const tabId = tab.getAttribute('data-tab');
                setActiveTab(tabId);
            });
        });

        // Update split selects
        updateSplitSelects();

        if (window.lucide) lucide.createIcons({ nodes: [tabsList] });
    }

    function setActiveTab(tabId) {
        TAB_VIEW.activeTab = tabId;

        // Update tab buttons
        document.querySelectorAll('.notebook-tab').forEach(tab => {
            tab.classList.toggle('active', tab.getAttribute('data-tab') === tabId);
        });

        // Show/hide cells
        const cellsContainer = document.getElementById('cellsContainer');
        if (!cellsContainer) return;

        const cells = cellsContainer.querySelectorAll('.cell[id^="cell_"]');
        cells.forEach(cell => {
            if (tabId === 'all') {
                cell.style.display = '';
            } else {
                const cellId = cell.id.replace('cell_', '');
                cell.style.display = cellId === tabId ? '' : 'none';
            }
        });
    }

    function toggleSplitView() {
        TAB_VIEW.splitMode = !TAB_VIEW.splitMode;

        const content = document.getElementById('notebookContent');
        const split = document.getElementById('notebookSplit');
        const toggleBtn = document.getElementById('splitViewToggle');

        if (TAB_VIEW.splitMode) {
            if (content) content.classList.add('hidden');
            if (split) split.style.display = 'grid';
            if (toggleBtn) toggleBtn.classList.add('active');
            updateSplitSelects();
            updateSplitPanel('left');
            updateSplitPanel('right');
        } else {
            if (content) content.classList.remove('hidden');
            if (split) split.style.display = 'none';
            if (toggleBtn) toggleBtn.classList.remove('active');
        }
    }

    function updateSplitSelects() {
        const selectLeft = document.getElementById('splitSelectLeft');
        const selectRight = document.getElementById('splitSelectRight');

        if (!selectLeft || !selectRight) return;

        let options = '';
        TAB_VIEW.cellTypes.forEach(type => {
            options += `<option value="${type.id}">${escapeHtml(type.name)}</option>`;
        });

        selectLeft.innerHTML = options;
        selectRight.innerHTML = options;

        // Set default values
        if (TAB_VIEW.cellTypes.length >= 1) {
            selectLeft.value = TAB_VIEW.cellTypes[0].id;
            TAB_VIEW.splitLeftType = TAB_VIEW.cellTypes[0].id;
        }
        if (TAB_VIEW.cellTypes.length >= 2) {
            selectRight.value = TAB_VIEW.cellTypes[1].id;
            TAB_VIEW.splitRightType = TAB_VIEW.cellTypes[1].id;
        }
    }

    function updateSplitPanel(side) {
        const select = document.getElementById(side === 'left' ? 'splitSelectLeft' : 'splitSelectRight');
        const content = document.getElementById(side === 'left' ? 'splitContentLeft' : 'splitContentRight');

        if (!select || !content) return;

        const type = select.value;
        if (side === 'left') TAB_VIEW.splitLeftType = type;
        else TAB_VIEW.splitRightType = type;

        // Clone the cell content
        const sourceCell = document.getElementById('cell_' + type);
        if (sourceCell) {
            content.innerHTML = sourceCell.querySelector('.cell-body')?.innerHTML || '';
            // Re-initialize any dynamic content
            if (window.lucide) lucide.createIcons({ nodes: [content] });
        } else {
            content.innerHTML = '<div class="split-empty">选择笔记类型</div>';
        }
    }

    function initSplitDivider() {
        const divider = document.getElementById('splitDivider');
        const splitContainer = document.getElementById('notebookSplit');

        if (!divider || !splitContainer) return;

        let isDragging = false;

        divider.addEventListener('mousedown', (e) => {
            isDragging = true;
            divider.classList.add('dragging');
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;

            const rect = splitContainer.getBoundingClientRect();
            const offsetX = e.clientX - rect.left;
            const percent = (offsetX / rect.width) * 100;

            // Clamp between 30% and 70%
            const clampedPercent = Math.max(30, Math.min(70, percent));

            splitContainer.style.gridTemplateColumns = `${clampedPercent}% 4px ${100 - clampedPercent}%`;
        });

        document.addEventListener('mouseup', () => {
            if (isDragging) {
                isDragging = false;
                divider.classList.remove('dragging');
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
            }
        });
    }

    /* ==================== BOTTOM SHEET (Mobile) ==================== */
    function initBottomSheet() {
        const sidebar = document.getElementById('sidebar');
        const overlay = document.getElementById('sidebarOverlay');

        if (!sidebar || !overlay) return;

        let startY = 0;
        let currentY = 0;
        let sheetState = 'peek'; // peek, half, full

        // Touch handlers for mobile
        sidebar.addEventListener('touchstart', (e) => {
            if (e.touches.length === 1) {
                startY = e.touches[0].clientY;
            }
        }, { passive: true });

        sidebar.addEventListener('touchmove', (e) => {
            if (e.touches.length === 1) {
                currentY = e.touches[0].clientY;
            }
        }, { passive: true });

        sidebar.addEventListener('touchend', () => {
            const diff = startY - currentY;
            if (diff > 50) {
                // Swipe up
                if (sheetState === 'peek') {
                    setSheetState('half');
                } else if (sheetState === 'half') {
                    setSheetState('full');
                }
            } else if (diff < -50) {
                // Swipe down
                if (sheetState === 'full') {
                    setSheetState('half');
                } else if (sheetState === 'half') {
                    setSheetState('peek');
                }
            }
        });

        function setSheetState(state) {
            sheetState = state;
            sidebar.setAttribute('data-sheet-state', state);
            if (state === 'peek') {
                overlay.classList.remove('active');
            } else {
                overlay.classList.add('active');
            }
        }

        // Overlay click to close
        overlay.addEventListener('click', () => {
            setSheetState('peek');
        });

        console.log('[Shell] Bottom Sheet initialized');
    }

    /* ==================== UTILITIES ==================== */
    function escapeHtml(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    /* ==================== INIT ==================== */
    document.addEventListener('DOMContentLoaded', async () => {
        await initWindowControls();
        initStepper();
        initTabsAndView();
        initBottomSheet();
        hookFileUpload();

        // Re-initialize icons
        if (window.lucide) {
            setTimeout(() => lucide.createIcons(), 100);
        }

        console.log('[Shell] All extensions initialized');
    });

    // Expose functions globally for integration
    window.ShellExtensions = {
        completeStep,
        setActiveStep,
        updateTabs,
        setActiveTab,
        toggleSplitView
    };

})();
