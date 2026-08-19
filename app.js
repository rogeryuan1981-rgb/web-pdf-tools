pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

        let currentPdfDoc = null; 
        let currentPdfBytes = null; 
        let sourceFileSize = 0;
        let pageRotations = {};   
        let selectedPages = new Set(); 
        let isLoadingPdf = false;
        let activeTool = 'organize';
        
        let pageEdits = {}; 
        const MIN_COMPRESSION_RATIO = 0.10;
        
        const html = document.documentElement;
        const introSection = document.getElementById('introSection');
        const uploadSection = document.getElementById('uploadSection');
        const workspaceSection = document.getElementById('workspaceSection');
        const pdfInput = document.getElementById('pdfInput');
        const thumbnailsContainer = document.getElementById('thumbnailsContainer');
        const downloadAllBtn = document.getElementById('downloadAllBtn');
        const downloadSelectedBtn = document.getElementById('downloadSelectedBtn');
        const pdfToExcelBtn = document.getElementById('pdfToExcelBtn'); 
        const downloadAllOriginalHTML = downloadAllBtn.innerHTML;

        function getPrimaryActionHTML(tool) {
            const labels = {
                organize: '匯出整理後 PDF',
                compress: '開始瘦身並下載',
                edit: '套用編輯並下載',
                encrypt: '加密並下載'
            };
            return downloadAllOriginalHTML.replace('套用並匯出', labels[tool] || '套用並匯出');
        }

        const TOOL_META = {
            organize: { title: '整理頁面', description: '拖曳頁面調整順序，或勾選需要分割的頁面。', upload: '載入要整理的 PDF' },
            compress: { title: 'PDF 瘦身', description: '先評估無損空間，或指定希望壓到的目標大小。', upload: '載入要瘦身的 PDF' },
            edit: { title: '編輯 PDF', description: '加入浮水印、簽名，或選擇頁面進行內容覆蓋。', upload: '載入要編輯的 PDF' },
            encrypt: { title: '密碼加密', description: '設定開啟密碼；加密失敗時不會輸出檔案。', upload: '載入要加密的 PDF' },
            excel: { title: '轉為 Excel', description: '抽取文字型 PDF 的內容與簡單表格結構。', upload: '載入要轉換的 PDF' }
        };

        function setWorkspaceTool(tool) {
            if (!TOOL_META[tool]) tool = 'organize';
            activeTool = tool;
            const meta = TOOL_META[tool];
            document.getElementById('workspaceToolTitle').textContent = meta.title;
            document.getElementById('workspaceToolDescription').textContent = meta.description;

            document.querySelectorAll('[data-tool-panel]').forEach(panel => {
                panel.classList.toggle('hidden', panel.dataset.toolPanel !== tool);
            });
            document.getElementById('settingsGrid').classList.toggle('hidden', !['edit', 'encrypt', 'compress'].includes(tool));
            document.getElementById('pageWorkspace').classList.toggle('hidden', !['organize', 'edit'].includes(tool));
            pdfToExcelBtn.classList.toggle('hidden', tool !== 'excel');
            downloadAllBtn.classList.toggle('hidden', tool === 'excel');
            downloadAllBtn.innerHTML = getPrimaryActionHTML(tool);
            downloadSelectedBtn.classList.toggle('hidden', tool !== 'organize' || selectedPages.size === 0);

            document.querySelectorAll('[data-workspace-tool]').forEach(button => {
                const isActive = button.dataset.workspaceTool === tool;
                button.className = `workspace-tool-btn whitespace-nowrap px-4 py-2 rounded-full text-sm font-medium border transition-colors ${isActive
                    ? 'bg-blue-600 border-blue-600 text-white shadow-sm'
                    : 'bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:border-blue-400'}`;
                button.setAttribute('aria-current', isActive ? 'page' : 'false');
            });

            if (tool === 'encrypt' && !document.getElementById('enableEncryptCb').checked) {
                document.getElementById('enableEncryptCb').checked = true;
                document.getElementById('enableEncryptCb').dispatchEvent(new Event('change'));
            }
        }

        document.querySelectorAll('[data-select-tool]').forEach(button => {
            button.addEventListener('click', () => {
                const requestedTool = button.dataset.selectTool;
                activeTool = requestedTool === 'all' ? 'organize' : requestedTool;
                document.getElementById('uploadToolTitle').textContent = TOOL_META[activeTool].upload;
                introSection.classList.add('hidden');
                uploadSection.classList.remove('hidden');
                uploadSection.classList.add('flex');
                uploadSection.focus();
            });
        });

        document.getElementById('backToToolsBtn').addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            uploadSection.classList.add('hidden');
            uploadSection.classList.remove('flex');
            introSection.classList.remove('hidden');
            document.querySelector('[data-select-tool="' + activeTool + '"]')?.focus();
        });

        document.querySelectorAll('[data-workspace-tool]').forEach(button => {
            button.addEventListener('click', () => setWorkspaceTool(button.dataset.workspaceTool));
        });

        function formatBytes(bytes) {
            if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
            const units = ['B', 'KB', 'MB', 'GB'];
            const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
            const value = bytes / Math.pow(1024, unitIndex);
            return `${value.toFixed(unitIndex === 0 ? 0 : 2)} ${units[unitIndex]}`;
        }

        function showToast(message, type = 'error') {
            const toast = document.createElement('div');
            const palette = type === 'success'
                ? 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200'
                : type === 'info'
                    ? 'border-blue-300 bg-blue-50 text-blue-900 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-200'
                    : 'border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-200';
            toast.className = `pointer-events-auto flex items-start gap-3 rounded-xl border p-4 shadow-lg ${palette}`;
            const text = document.createElement('p');
            text.className = 'flex-grow text-sm leading-relaxed';
            text.textContent = message;
            const close = document.createElement('button');
            close.type = 'button';
            close.className = 'shrink-0 text-lg leading-none opacity-60 hover:opacity-100';
            close.setAttribute('aria-label', '關閉通知');
            close.textContent = '×';
            close.onclick = () => toast.remove();
            toast.append(text, close);
            document.getElementById('toastContainer').appendChild(toast);
            setTimeout(() => toast.remove(), 7000);
        }

        function formatCompressionPercent(ratio) {
            const percent = Math.max(0, ratio * 100);
            return (Math.floor(percent * 100) / 100).toFixed(2);
        }

        async function checkCompressionEligibility(pdfDoc) {
            const compressCheckbox = document.getElementById('enableCompressCb');
            const compressResult = document.getElementById('compressResult');
            document.getElementById('loadingStatusText').textContent = '正在評估無損瘦身效果...';

            compressCheckbox.disabled = true;
            compressResult.textContent = '正在預先檢查可瘦身比例...';

            const uncompressedBytes = await pdfDoc.save({
                useObjectStreams: false,
                addDefaultPage: false,
                objectsPerTick: 50
            });
            const optimizedBytes = await pdfDoc.save({
                useObjectStreams: true,
                addDefaultPage: false,
                objectsPerTick: 50
            });
            const savedRatio = uncompressedBytes.length > 0
                ? (uncompressedBytes.length - optimizedBytes.length) / uncompressedBytes.length
                : 0;
            const savedPercent = formatCompressionPercent(savedRatio);

            if (savedRatio >= MIN_COMPRESSION_RATIO) {
                compressCheckbox.disabled = false;
                compressCheckbox.checked = true;
                compressCheckbox.parentElement.title = `預估可無損瘦身 ${savedPercent}%`;
                compressResult.innerHTML = `✅ 預估可無損瘦身 <strong>${savedPercent}%</strong>，匯出時將再次確認。`;
            } else {
                compressCheckbox.checked = false;
                compressCheckbox.disabled = true;
                compressCheckbox.parentElement.title = `僅能瘦身 ${savedPercent}%，未達 10%`;
                compressResult.innerHTML = `⛔ 預估僅能瘦身 <strong>${savedPercent}%</strong>，未達 10%，功能已自動關閉。`;
            }
        }

        async function rasterizePdf(pdfBytes, dpi, jpegQuality) {
            const sourcePdf = await pdfjsLib.getDocument({ data: pdfBytes.slice(0) }).promise;
            const rasterPdf = await PDFLib.PDFDocument.create();
            const MAX_CANVAS_PIXELS = 24000000;

            for (let pageNumber = 1; pageNumber <= sourcePdf.numPages; pageNumber++) {
                const sourcePage = await sourcePdf.getPage(pageNumber);
                const pageViewport = sourcePage.getViewport({ scale: 1 });
                let renderScale = dpi / 72;
                const estimatedPixels = pageViewport.width * renderScale * pageViewport.height * renderScale;
                if (estimatedPixels > MAX_CANVAS_PIXELS) {
                    renderScale *= Math.sqrt(MAX_CANVAS_PIXELS / estimatedPixels);
                }

                const renderViewport = sourcePage.getViewport({ scale: renderScale });
                const canvas = document.createElement('canvas');
                canvas.width = Math.max(1, Math.round(renderViewport.width));
                canvas.height = Math.max(1, Math.round(renderViewport.height));
                const context = canvas.getContext('2d', { alpha: false });
                context.fillStyle = '#ffffff';
                context.fillRect(0, 0, canvas.width, canvas.height);
                await sourcePage.render({ canvasContext: context, viewport: renderViewport }).promise;

                const jpgImage = await rasterPdf.embedJpg(canvas.toDataURL('image/jpeg', jpegQuality));
                const outputPage = rasterPdf.addPage([pageViewport.width, pageViewport.height]);
                outputPage.drawImage(jpgImage, {
                    x: 0,
                    y: 0,
                    width: pageViewport.width,
                    height: pageViewport.height
                });

                canvas.width = 1;
                canvas.height = 1;
                sourcePage.cleanup();
            }

            await sourcePdf.destroy();
            return rasterPdf.save({ useObjectStreams: true, addDefaultPage: false, objectsPerTick: 50 });
        }

        async function compressPdfToTarget(pdfBytes, targetBytes, maxDpi, startingQuality) {
            const rawProfiles = [
                [maxDpi, startingQuality],
                [Math.min(maxDpi, 150), Math.min(startingQuality, 0.80)],
                [Math.min(maxDpi, 120), Math.min(startingQuality, 0.72)],
                [Math.min(maxDpi, 96), Math.min(startingQuality, 0.62)],
                [Math.min(maxDpi, 72), Math.min(startingQuality, 0.50)],
                [60, 0.35]
            ];
            const seenProfiles = new Set();
            const profiles = rawProfiles.filter(([dpi, quality]) => {
                const key = `${dpi}-${quality}`;
                if (seenProfiles.has(key)) return false;
                seenProfiles.add(key);
                return true;
            });

            let smallestResult = null;
            for (let index = 0; index < profiles.length; index++) {
                const [dpi, quality] = profiles[index];
                document.getElementById('compressResult').textContent = `正在嘗試達到 ${formatBytes(targetBytes)}（第 ${index + 1}/${profiles.length} 階段）...`;
                const bytes = await rasterizePdf(pdfBytes, dpi, quality);
                const result = { bytes, dpi, quality, reached: bytes.length <= targetBytes };
                if (!smallestResult || bytes.length < smallestResult.bytes.length) smallestResult = result;
                if (result.reached) return result;
            }
            return smallestResult;
        }
        
        const editModal = document.getElementById('editModal');
        const baseCanvas = document.getElementById('baseCanvas');
        const overlayCanvas = document.getElementById('overlayCanvas');
        const overlayCtx = overlayCanvas.getContext('2d');
        const toolWhiteoutBtn = document.getElementById('toolWhiteout');
        const toolTextBtn = document.getElementById('toolText');
        const textSettings = document.getElementById('textSettings');
        
        let activeEditPageIdx = null;
        let currentTool = 'whiteout';
        let isDrawing = false;
        let startX = 0, startY = 0;
        let viewportScale = 1.5; 

        function setTool(tool) {
            currentTool = tool;
            if (tool === 'whiteout') {
                toolWhiteoutBtn.className = "px-3 py-1.5 text-sm font-medium rounded-md bg-white dark:bg-gray-700 shadow shadow-sm text-blue-600 dark:text-blue-400 transition-colors";
                toolTextBtn.className = "px-3 py-1.5 text-sm font-medium rounded-md text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors";
                textSettings.classList.add('hidden');
                textSettings.classList.remove('flex');
                overlayCanvas.style.cursor = 'crosshair';
            } else {
                toolTextBtn.className = "px-3 py-1.5 text-sm font-medium rounded-md bg-white dark:bg-gray-700 shadow text-blue-600 dark:text-blue-400";
                toolWhiteoutBtn.className = "px-3 py-1.5 text-sm font-medium rounded-md text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors";
                textSettings.classList.remove('hidden');
                textSettings.classList.add('flex');
                overlayCanvas.style.cursor = 'text';
            }
        }

        toolWhiteoutBtn.onclick = () => setTool('whiteout');
        toolTextBtn.onclick = () => setTool('text');

        async function openEditModal(pageIndex) {
            if (pageRotations[pageIndex]) {
                showToast("為了確保座標正確，請先將頁面旋轉角度重置為 0 度，才能進入編輯模式。");
                return;
            }
            
            activeEditPageIdx = pageIndex;
            if (!pageEdits[pageIndex]) pageEdits[pageIndex] = [];

            const pdf = await pdfjsLib.getDocument({data: currentPdfBytes.slice(0)}).promise;
            const page = await pdf.getPage(pageIndex + 1);
            
            const viewportObj = page.getViewport({scale: 1.0});
            viewportScale = Math.min(2.0, (window.innerHeight * 0.8) / viewportObj.height);
            const viewport = page.getViewport({scale: viewportScale});

            baseCanvas.width = overlayCanvas.width = viewport.width;
            baseCanvas.height = overlayCanvas.height = viewport.height;

            const baseCtx = baseCanvas.getContext('2d');
            await page.render({ canvasContext: baseCtx, viewport: viewport }).promise;

            redrawOverlay();
            editModal.classList.remove('hidden');
            editModal.classList.add('flex');
            document.getElementById('closeEditModalBtn').focus();
        }

        document.getElementById('closeEditModalBtn').onclick = () => {
            editModal.classList.add('hidden');
            editModal.classList.remove('flex');
            
            if (activeEditPageIdx !== null) {
                const checkbox = thumbnailsContainer.querySelector(`.page-checkbox[value="${activeEditPageIdx}"]`);
                if (checkbox) {
                    const pageLabel = checkbox.nextElementSibling.querySelector('.page-label-text');
                    const hasEdits = pageEdits[activeEditPageIdx] && pageEdits[activeEditPageIdx].length > 0;
                    
                    let badgeHTML = '';
                    if (hasEdits) {
                        badgeHTML = '<span class="absolute top-9 left-2 bg-yellow-400 text-yellow-900 text-[10px] font-bold px-1.5 py-0.5 rounded shadow z-10">已編輯</span> ';
                    }
                    
                    const currentText = pageLabel.textContent.replace('已編輯', '').trim();
                    pageLabel.innerHTML = badgeHTML + currentText;
                }
            }
            activeEditPageIdx = null;
        };

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !editModal.classList.contains('hidden')) {
                document.getElementById('closeEditModalBtn').click();
            }
        });

        document.getElementById('clearEditsBtn').onclick = () => {
            if(confirm("確定要清除這頁的所有手動修改嗎？")) {
                pageEdits[activeEditPageIdx] = [];
                redrawOverlay();
            }
        };

        document.getElementById('undoEditBtn').onclick = () => {
            if (pageEdits[activeEditPageIdx] && pageEdits[activeEditPageIdx].length > 0) {
                pageEdits[activeEditPageIdx].pop(); 
                redrawOverlay(); 
            }
        };

        overlayCanvas.addEventListener('mousedown', (e) => {
            if (currentTool !== 'whiteout') return;
            isDrawing = true;
            const rect = overlayCanvas.getBoundingClientRect();
            startX = e.clientX - rect.left;
            startY = e.clientY - rect.top;
        });

        overlayCanvas.addEventListener('mousemove', (e) => {
            if (!isDrawing || currentTool !== 'whiteout') return;
            const rect = overlayCanvas.getBoundingClientRect();
            const currentX = e.clientX - rect.left;
            const currentY = e.clientY - rect.top;
            
            redrawOverlay(); 
            
            overlayCtx.fillStyle = 'white';
            overlayCtx.fillRect(startX, startY, currentX - startX, currentY - startY);
            overlayCtx.strokeStyle = 'rgba(59, 130, 246, 0.5)';
            overlayCtx.lineWidth = 2;
            overlayCtx.strokeRect(startX, startY, currentX - startX, currentY - startY);
        });

        overlayCanvas.addEventListener('mouseup', (e) => {
            const rect = overlayCanvas.getBoundingClientRect();
            const endX = e.clientX - rect.left;
            const endY = e.clientY - rect.top;

            if (currentTool === 'whiteout' && isDrawing) {
                isDrawing = false;
                const width = endX - startX;
                const height = endY - startY;
                
                if (Math.abs(width) > 5 && Math.abs(height) > 5) {
                    const pdfX = Math.min(startX, endX) / viewportScale;
                    const pdfW = Math.abs(width) / viewportScale;
                    const pdfH = Math.abs(height) / viewportScale;
                    const pdfY_TopFromBottom = (overlayCanvas.height - Math.min(startY, endY)) / viewportScale; 

                    pageEdits[activeEditPageIdx].push({
                        type: 'whiteout',
                        data: {
                            x: pdfX,
                            y: pdfY_TopFromBottom - pdfH, 
                            w: pdfW,
                            h: pdfH
                        }
                    });
                }
                redrawOverlay();
            } 
            else if (currentTool === 'text') {
                const text = prompt("請輸入要新增的文字：");
                if (text && text.trim() !== "") {
                    const color = document.getElementById('editTextColor').value;
                    const size = parseInt(document.getElementById('editFontSize').value);
                    
                    const pdfX = endX / viewportScale;
                    const pdfY_TopFromBottom = (overlayCanvas.height - endY) / viewportScale;

                    pageEdits[activeEditPageIdx].push({
                        type: 'text',
                        data: {
                            text: text,
                            x: pdfX,
                            y: pdfY_TopFromBottom, 
                            size: size,
                            color: color
                        }
                    });
                    redrawOverlay();
                }
            }
        });

        function redrawOverlay() {
            overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
            const edits = pageEdits[activeEditPageIdx];
            if(!edits || edits.length === 0) return;

            edits.forEach(edit => {
                if (edit.type === 'whiteout') {
                    const rect = edit.data;
                    const cvsX = rect.x * viewportScale;
                    const cvsW = rect.w * viewportScale;
                    const cvsH = rect.h * viewportScale;
                    const cvsY = overlayCanvas.height - ((rect.y + rect.h) * viewportScale);

                    overlayCtx.fillStyle = 'white';
                    overlayCtx.fillRect(cvsX, cvsY, cvsW, cvsH);
                    overlayCtx.strokeStyle = 'rgba(200,200,200,0.5)';
                    overlayCtx.lineWidth = 1;
                    overlayCtx.strokeRect(cvsX, cvsY, cvsW, cvsH);
                } else if (edit.type === 'text') {
                    const txt = edit.data;
                    const cvsX = txt.x * viewportScale;
                    const cvsY = overlayCanvas.height - (txt.y * viewportScale);
                    const cvsSize = txt.size * viewportScale;

                    overlayCtx.font = `${cvsSize}px sans-serif`;
                    overlayCtx.fillStyle = txt.color;
                    overlayCtx.textBaseline = 'top';
                    overlayCtx.fillText(txt.text, cvsX, cvsY);
                }
            });
        }

        function updatePageLabels() {
            const labels = thumbnailsContainer.querySelectorAll('.page-label-text');
            labels.forEach((label, index) => {
                const badge = label.querySelector('span.bg-yellow-400'); 
                label.innerHTML = (badge ? badge.outerHTML + ' ' : '') + `第 ${index + 1} 頁`;
            });
        }

        if (localStorage.theme === 'dark' || (!('theme' in localStorage) && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
            html.classList.add('dark');
        }

        function updateThemeControl() {
            const isDark = html.classList.contains('dark');
            document.getElementById('themeIcon').textContent = isDark ? '☀️' : '🌙';
            document.getElementById('darkModeToggle').setAttribute('aria-label', isDark ? '切換為淺色模式' : '切換為深色模式');
        }
        updateThemeControl();

        document.getElementById('darkModeToggle').addEventListener('click', () => {
            html.classList.toggle('dark');
            localStorage.theme = html.classList.contains('dark') ? 'dark' : 'light';
            updateThemeControl();
        });

        uploadSection.addEventListener('click', () => { if (!isLoadingPdf) pdfInput.click(); });
        uploadSection.addEventListener('keydown', (e) => {
            if (!isLoadingPdf && (e.key === 'Enter' || e.key === ' ')) {
                e.preventDefault();
                pdfInput.click();
            }
        });
        uploadSection.addEventListener('dragover', (e) => {
            e.preventDefault();
            uploadSection.classList.add('border-blue-500', 'bg-blue-50', 'dark:bg-blue-900/20');
        });
        uploadSection.addEventListener('dragleave', () => {
            uploadSection.classList.remove('border-blue-500', 'bg-blue-50', 'dark:bg-blue-900/20');
        });
        uploadSection.addEventListener('drop', (e) => {
            e.preventDefault();
            uploadSection.classList.remove('border-blue-500', 'bg-blue-50', 'dark:bg-blue-900/20');
            if (e.dataTransfer.files.length > 0) {
                const droppedFiles = Array.from(e.dataTransfer.files);
                if (!droppedFiles.every(file => file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf'))) {
                    showToast('請只拖曳 PDF 檔案。');
                    return;
                }
                pdfInput.files = e.dataTransfer.files;
                handleFilesSelected();
            }
        });
        pdfInput.addEventListener('change', () => { if (pdfInput.files.length > 0) handleFilesSelected(); });

        async function handleFilesSelected() {
            if (isLoadingPdf) return;
            const selectedFiles = Array.from(pdfInput.files);
            if (!selectedFiles.length) return;
            if (!selectedFiles.every(file => file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf'))) {
                showToast('請只選取 PDF 檔案。');
                pdfInput.value = '';
                return;
            }
            const selectedTotalBytes = selectedFiles.reduce((total, file) => total + file.size, 0);
            if (selectedTotalBytes > 250 * 1024 * 1024 && !confirm('選取的 PDF 總大小超過 250 MB，瀏覽器可能因記憶體不足而失敗。仍要繼續嗎？')) {
                pdfInput.value = '';
                return;
            }
            document.getElementById('loadingOverlay').classList.remove('hidden');
            document.getElementById('loadingOverlay').classList.add('flex');
            document.getElementById('loadingStatusText').textContent = '正在讀取與整理 PDF...';
            isLoadingPdf = true;
            uploadSection.setAttribute('aria-disabled', 'true');

            try {
                const mergedPdf = await PDFLib.PDFDocument.create();
                let outputFileName = pdfInput.files.length > 1 ? "Merged_" + pdfInput.files[0].name : pdfInput.files[0].name;
                sourceFileSize = selectedTotalBytes;
                const suggestedTargetMb = Math.max(0.1, (sourceFileSize * 0.7) / (1024 * 1024));
                document.getElementById('targetSizeMb').value = suggestedTargetMb.toFixed(suggestedTargetMb < 1 ? 2 : 1);
                document.getElementById('strongSourceSize').textContent = `目前檔案 ${formatBytes(sourceFileSize)}；已先帶入約縮小 30% 的建議目標。`;

                for (let i = 0; i < pdfInput.files.length; i++) {
                    const arrayBuffer = await pdfInput.files[i].arrayBuffer();
                    const pdf = await PDFLib.PDFDocument.load(arrayBuffer);
                    const copiedPages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
                    copiedPages.forEach(page => mergedPdf.addPage(page));
                }

                currentPdfDoc = mergedPdf;
                currentPdfBytes = await mergedPdf.save();
                await checkCompressionEligibility(currentPdfDoc);
                
                pageRotations = {};
                selectedPages.clear();
                pageEdits = {}; 

                document.getElementById('fileNameDisplay').textContent = outputFileName;
                document.getElementById('pageCountDisplay').textContent = `共 ${currentPdfDoc.getPageCount()} 頁 · 原始 ${formatBytes(sourceFileSize)}`;
                 
                document.getElementById('loadingStatusText').textContent = '正在建立頁面預覽...';
                await renderThumbnails(currentPdfBytes);

                introSection.classList.add('hidden');
                uploadSection.classList.add('hidden');
                workspaceSection.classList.remove('hidden');
                workspaceSection.classList.add('flex');
                setWorkspaceTool(activeTool);
            } catch (error) {
                console.error(error);
                showToast("處理檔案發生錯誤。檔案可能已加密、損毀，或超出瀏覽器可用記憶體。");
            } finally {
                isLoadingPdf = false;
                uploadSection.removeAttribute('aria-disabled');
                document.getElementById('loadingOverlay').classList.add('hidden');
                document.getElementById('loadingOverlay').classList.remove('flex');
            }
        }

        async function renderThumbnails(pdfBytes) {
            thumbnailsContainer.innerHTML = ''; 
            const pdf = await pdfjsLib.getDocument({data: pdfBytes.slice(0)}).promise;
            
            for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
                const pageIndex = pageNum - 1;
                const page = await pdf.getPage(pageNum);
                const viewport = page.getViewport({scale: 0.4}); 
                
                const card = document.createElement('label');
                card.className = "relative cursor-move group flex flex-col"; 
                
                const checkbox = document.createElement('input');
                checkbox.type = "checkbox";
                checkbox.className = "page-checkbox absolute top-2 left-2 z-20 w-5 h-5 accent-blue-600 cursor-pointer";
                checkbox.value = pageIndex;
                checkbox.setAttribute('aria-label', `選取第 ${pageNum} 頁`);
                checkbox.onchange = (e) => {
                    e.target.checked ? selectedPages.add(pageIndex) : selectedPages.delete(pageIndex);
                    downloadSelectedBtn.classList.toggle('hidden', activeTool !== 'organize' || selectedPages.size === 0);
                    downloadSelectedBtn.textContent = `匯出選取的 ${selectedPages.size} 頁`;
                };

                const cardInner = document.createElement('div');
                cardInner.className = "border-2 border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 rounded-lg overflow-hidden relative shadow hover:shadow-md";
                
                const canvasWrapper = document.createElement('div');
                canvasWrapper.className = "flex items-center justify-center p-2 bg-gray-100 dark:bg-gray-900 h-40 overflow-hidden relative";
                
                const canvas = document.createElement('canvas');
                canvas.className = "max-w-full max-h-full transition-transform duration-300";
                
                const editBtn = document.createElement('button');
                editBtn.type = 'button';
                editBtn.className = "absolute top-2 right-10 p-1.5 bg-blue-50 text-blue-600 rounded shadow opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus:opacity-100 transition-opacity z-10 hover:bg-blue-100 border border-blue-200 flex items-center justify-center";
                editBtn.innerHTML = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"></path></svg>';
                editBtn.title = "進入單頁進階編輯 (立可白/新增文字)";
                editBtn.onclick = async (e) => { 
                    e.preventDefault(); 
                    e.stopPropagation(); 
                    const oldHTML = editBtn.innerHTML;
                    editBtn.innerHTML = '<div class="w-4 h-4 border-2 border-blue-600 border-t-transparent rounded-full animate-spin"></div>'; 
                    try {
                        await openEditModal(pageIndex);
                    } catch (err) {
                        console.error(err);
                        showToast("開啟編輯模式失敗");
                    } finally {
                        editBtn.innerHTML = oldHTML; 
                    }
                };

                const rotateBtn = document.createElement('button');
                rotateBtn.type = 'button';
                rotateBtn.title = '順時針旋轉 90 度';
                rotateBtn.setAttribute('aria-label', `旋轉第 ${pageNum} 頁`);
                rotateBtn.className = "absolute top-2 right-2 p-1.5 bg-white/90 text-gray-700 rounded shadow opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus:opacity-100 transition-opacity z-10 hover:bg-gray-100 border border-gray-200 flex items-center justify-center";
                rotateBtn.innerHTML = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>';
                rotateBtn.onclick = (e) => { 
                    e.preventDefault(); 
                    e.stopPropagation(); 
                    rotatePage(pageIndex, canvas); 
                };

                let editBadge = '';
                if (pageEdits[pageIndex] && pageEdits[pageIndex].length > 0) {
                    editBadge = '<span class="absolute top-9 left-2 bg-yellow-400 text-yellow-900 text-[10px] font-bold px-1.5 py-0.5 rounded shadow z-10">已編輯</span> ';
                }

                const pageLabel = document.createElement('div');
                pageLabel.className = "page-label-text text-center py-1.5 text-xs font-medium text-gray-600 bg-white border-t border-gray-100 relative";
                pageLabel.innerHTML = `${editBadge}第 ${pageNum} 頁`;

                const context = canvas.getContext('2d');
                canvas.height = viewport.height;
                canvas.width = viewport.width;
                await page.render({ canvasContext: context, viewport: viewport }).promise;

                canvasWrapper.appendChild(canvas);
                cardInner.append(canvasWrapper, editBtn, rotateBtn, pageLabel);
                card.append(checkbox, cardInner);
                thumbnailsContainer.appendChild(card);
            }

            new Sortable(thumbnailsContainer, {
                animation: 150,
                ghostClass: 'sortable-ghost',
                onEnd: function () {
                    updatePageLabels();
                }
            });
        }

        function rotatePage(pageIndex, canvasElement) {
            let rot = (pageRotations[pageIndex] || 0) + 90;
            pageRotations[pageIndex] = rot % 360;
            canvasElement.style.transform = `rotate(${rot}deg)`;
            if (rot % 180 !== 0) {
                const scale = Math.min(canvasElement.parentElement.offsetWidth / canvasElement.height, canvasElement.parentElement.offsetHeight / canvasElement.width) * 0.9;
                canvasElement.style.transform += ` scale(${scale})`;
            }
        }

        let isSigReady = false;
        let originalSigImage = null;
        const sigCanvas = document.getElementById('sigCanvas');
        const sigCtx = sigCanvas.getContext('2d');

        document.getElementById('enableWmCb').onchange = (e) => {
            document.getElementById('wmControls').classList.toggle('opacity-50', !e.target.checked);
            document.getElementById('wmControls').classList.toggle('pointer-events-none', !e.target.checked);
        };
        
        document.getElementById('enableSigCb').onchange = (e) => {
            document.getElementById('sigControls').classList.toggle('opacity-50', !e.target.checked);
            document.getElementById('sigControls').classList.toggle('pointer-events-none', !e.target.checked);
        };

        // 加密開關連動邏輯
        document.getElementById('enableEncryptCb').onchange = (e) => {
            document.getElementById('encryptControls').classList.toggle('opacity-50', !e.target.checked);
            document.getElementById('encryptControls').classList.toggle('pointer-events-none', !e.target.checked);
        };

        const enableStrongCompressCb = document.getElementById('enableStrongCompressCb');
        const enableCompressCb = document.getElementById('enableCompressCb');
        const strongCompressControls = document.getElementById('strongCompressControls');

        document.querySelectorAll('.target-size-preset').forEach(button => {
            button.addEventListener('click', () => {
                document.getElementById('targetSizeMb').value = button.dataset.targetMb;
            });
        });

        enableStrongCompressCb.onchange = (e) => {
            strongCompressControls.classList.toggle('opacity-50', !e.target.checked);
            strongCompressControls.classList.toggle('pointer-events-none', !e.target.checked);
            if (e.target.checked) {
                document.getElementById('enableCompressCb').checked = false;
                document.getElementById('compressResult').textContent = '請確認目標 MB；系統會自動尋找最清晰且能達標的設定。';
            } else {
                document.getElementById('compressResult').textContent = '強力瘦身已關閉，不會將頁面轉成圖片。';
            }
        };

        enableCompressCb.addEventListener('change', (e) => {
            if (e.target.checked && enableStrongCompressCb.checked) {
                enableStrongCompressCb.checked = false;
                strongCompressControls.classList.add('opacity-50', 'pointer-events-none');
            }
        });

        document.getElementById('sigUploadBtn').onclick = () => document.getElementById('sigInput').click();
        document.getElementById('sigInput').onchange = (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (event) => {
                const img = new Image();
                img.onload = () => {
                    originalSigImage = img;
                    document.getElementById('sigPlaceholderText').classList.add('hidden');
                    sigCanvas.classList.remove('hidden');
                    processSignatureBackground();
                    isSigReady = true;
                };
                img.src = event.target.result;
            };
            reader.readAsDataURL(file);
        };

        document.getElementById('sigTolerance').oninput = (e) => {
            document.getElementById('sigToleranceVal').textContent = e.target.value;
            if (originalSigImage) processSignatureBackground();
        };

        function processSignatureBackground() {
            const threshold = parseInt(document.getElementById('sigTolerance').value);
            const maxDimension = 2000;
            const scale = Math.min(1, maxDimension / Math.max(originalSigImage.width, originalSigImage.height));
            sigCanvas.width = Math.max(1, Math.round(originalSigImage.width * scale));
            sigCanvas.height = Math.max(1, Math.round(originalSigImage.height * scale));
            sigCtx.clearRect(0, 0, sigCanvas.width, sigCanvas.height);
            sigCtx.drawImage(originalSigImage, 0, 0, sigCanvas.width, sigCanvas.height);
            const imgData = sigCtx.getImageData(0, 0, sigCanvas.width, sigCanvas.height);
            const data = imgData.data;
            for (let i = 0; i < data.length; i += 4) {
                if (data[i] >= threshold && data[i+1] >= threshold && data[i+2] >= threshold) {
                    data[i+3] = 0; 
                }
            }
            sigCtx.putImageData(imgData, 0, 0);
        }

        async function exportProcessedPdf(pageIndicesToExport, filenamePrefix) {
            if (!currentPdfDoc || pageIndicesToExport.length === 0) return;
            if (activeTool === 'compress' && !document.getElementById('enableCompressCb').checked && !document.getElementById('enableStrongCompressCb').checked) {
                showToast('這份 PDF 無法進一步無損瘦身。請開啟「強力瘦身」並設定目標大小。', 'info');
                return;
            }
            const exportPdf = await PDFLib.PDFDocument.create();
            
            const copiedPages = await exportPdf.copyPages(currentPdfDoc, pageIndicesToExport);

            let wmFont = null;
            if (document.getElementById('enableWmCb').checked && document.getElementById('wmText').value.trim()) {
                wmFont = await exportPdf.embedFont(PDFLib.StandardFonts.HelveticaBold);
            }
            let embedSigImg = null;
            if (document.getElementById('enableSigCb').checked && isSigReady) {
                embedSigImg = await exportPdf.embedPng(sigCanvas.toDataURL("image/png"));
            }

            for (let idx = 0; idx < copiedPages.length; idx++) {
                const page = copiedPages[idx];
                const originalIdx = pageIndicesToExport[idx];
                const { width, height } = page.getSize();

                if (pageEdits[originalIdx] && pageEdits[originalIdx].length > 0) {
                    const edits = pageEdits[originalIdx];
                    
                    for (const edit of edits) {
                        if (edit.type === 'whiteout') {
                            const rect = edit.data;
                            page.drawRectangle({
                                x: rect.x, y: rect.y, width: rect.w, height: rect.h,
                                color: PDFLib.rgb(1, 1, 1),
                            });
                        } else if (edit.type === 'text') {
                            const txt = edit.data;
                            const tCanvas = document.createElement('canvas');
                            const tCtx = tCanvas.getContext('2d');
                            const scale = 4; 
                            const fontSize = txt.size * scale;
                            tCtx.font = `bold ${fontSize}px sans-serif`;
                            
                            const metrics = tCtx.measureText(txt.text);
                            tCanvas.width = metrics.width + 20; 
                            tCanvas.height = fontSize * 1.5;

                            tCtx.font = `bold ${fontSize}px sans-serif`; 
                            tCtx.fillStyle = txt.color;
                            tCtx.textBaseline = 'top';
                            tCtx.fillText(txt.text, 5, 5);

                            const textImage = await exportPdf.embedPng(tCanvas.toDataURL('image/png'));
                            
                            const renderHeight = tCanvas.height / scale;
                            page.drawImage(textImage, {
                                x: txt.x, 
                                y: txt.y - renderHeight, 
                                width: tCanvas.width / scale,
                                height: renderHeight
                            });
                        }
                    }
                }

                if (pageRotations[originalIdx]) {
                    const currentAngle = page.getRotation().angle;
                    page.setRotation(PDFLib.degrees(currentAngle + pageRotations[originalIdx]));
                }

                const effectiveWidth = page.getRotation().angle % 180 === 0 ? width : height;
                const effectiveHeight = page.getRotation().angle % 180 === 0 ? height : width;

                if (wmFont) {
                    const text = document.getElementById('wmText').value;
                    const size = Math.min(500, Math.max(6, parseFloat(document.getElementById('wmSize').value) || 60));
                    const opacity = Math.min(1, Math.max(0.05, parseFloat(document.getElementById('wmOpacity').value) || 0.3));
                    const textWidth = wmFont.widthOfTextAtSize(text, size);
                    const textHeight = wmFont.heightAtSize(size);
                    page.drawText(text, {
                        x: effectiveWidth / 2 - textWidth / 2 + (textHeight/2), 
                        y: effectiveHeight / 2 - textHeight / 2,
                        size: size, font: wmFont, color: PDFLib.rgb(0.6, 0.6, 0.6), 
                        opacity: opacity,
                        rotate: PDFLib.degrees(45),
                    });
                }

                if (embedSigImg) {
                    const targetPages = document.getElementById('sigPages').value;
                    if (targetPages === 'all' || (targetPages === 'first' && idx === 0) || (targetPages === 'last' && idx === copiedPages.length - 1)) {
                        const sigDims = embedSigImg.scale((effectiveWidth / 4) / embedSigImg.width);
                        const pos = document.getElementById('sigPosition').value;
                        const margin = 40;
                        let x = 0, y = 0;
                        if (pos === 'br') { x = effectiveWidth - sigDims.width - margin; y = margin; }
                        if (pos === 'bl') { x = margin; y = margin; }
                        if (pos === 'tr') { x = effectiveWidth - sigDims.width - margin; y = effectiveHeight - sigDims.height - margin; }
                        if (pos === 'tl') { x = margin; y = effectiveHeight - sigDims.height - margin; }

                        page.drawImage(embedSigImg, { x: x, y: y, width: sigDims.width, height: sigDims.height });
                    }
                }

                exportPdf.addPage(page);
            }

            const uncompressedBytes = await exportPdf.save({
                useObjectStreams: false,
                addDefaultPage: false,
                objectsPerTick: 50
            });
            let pdfBytes = uncompressedBytes;
            let compressionPrefix = '';
            let strongTargetBytes = null;
            const useStrongCompression = document.getElementById('enableStrongCompressCb').checked;

            if (useStrongCompression) {
                const targetSizeMb = parseFloat(document.getElementById('targetSizeMb').value);
                if (!Number.isFinite(targetSizeMb) || targetSizeMb <= 0) {
                    document.getElementById('compressResult').textContent = '⛔ 請輸入大於 0 的目標檔案大小。';
                    showToast('請輸入希望壓縮到的檔案大小（MB）。');
                    return;
                }
                const targetBytes = Math.round(targetSizeMb * 1024 * 1024);
                strongTargetBytes = targetBytes;
                const compressionTargetBytes = document.getElementById('enableEncryptCb').checked
                    ? Math.floor(targetBytes * 0.98)
                    : targetBytes;
                const renderSourceBytes = await exportPdf.save({
                    useObjectStreams: true,
                    addDefaultPage: false,
                    objectsPerTick: 50
                });
                const maxDpi = parseInt(document.getElementById('strongCompressDpi').value, 10);
                const startingQuality = parseFloat(document.getElementById('strongCompressQuality').value);
                const compressionResult = await compressPdfToTarget(
                    renderSourceBytes,
                    compressionTargetBytes,
                    maxDpi,
                    startingQuality
                );
                const rasterizedBytes = compressionResult.bytes;
                const savedRatio = uncompressedBytes.length > 0
                    ? (uncompressedBytes.length - rasterizedBytes.length) / uncompressedBytes.length
                    : 0;
                const savedPercent = formatCompressionPercent(savedRatio);

                if (rasterizedBytes.length > targetBytes) {
                    document.getElementById('compressResult').innerHTML = `⛔ 最低只能壓到 <strong>${formatBytes(rasterizedBytes.length)}</strong>，無法達到 ${formatBytes(targetBytes)}，因此未提供下載。`;
                    showToast(`目前最低只能壓到 ${formatBytes(rasterizedBytes.length)}，仍無法達到 ${formatBytes(targetBytes)} 的目標，因此不會下載檔案。`);
                    return;
                }

                if (savedRatio < MIN_COMPRESSION_RATIO) {
                    document.getElementById('compressResult').innerHTML = `⛔ 強力瘦身僅能縮小 ${savedPercent}%，未達 10%，因此未提供下載。`;
                    showToast(`處理後僅縮小 ${savedPercent}%，未達 10% 門檻，因此不會下載檔案。`);
                    return;
                }

                pdfBytes = rasterizedBytes;
                compressionPrefix = 'Strong_';
                document.getElementById('compressResult').innerHTML = `✅ 已達到 ${formatBytes(targetBytes)} 目標：${formatBytes(uncompressedBytes.length)} → <strong>${formatBytes(pdfBytes.length)}</strong>，節省 ${savedPercent}%（${compressionResult.dpi} DPI／品質 ${Math.round(compressionResult.quality * 100)}%）。`;
            } else if (document.getElementById('enableCompressCb').checked) {
                const optimizedBytes = await exportPdf.save({
                    useObjectStreams: true,
                    addDefaultPage: false,
                    objectsPerTick: 50
                });
                const savedBytes = uncompressedBytes.length - optimizedBytes.length;
                const savedRatio = uncompressedBytes.length > 0 ? savedBytes / uncompressedBytes.length : 0;
                const savedPercent = formatCompressionPercent(savedRatio);

                if (savedRatio < MIN_COMPRESSION_RATIO) {
                    document.getElementById('compressResult').innerHTML = `⛔ 僅能縮小 ${savedPercent}%，未達 10% 門檻，因此未提供下載。`;
                    showToast(`此 PDF 無損瘦身幅度僅 ${savedPercent}%，未達 10% 門檻，因此不會下載檔案。`);
                    return;
                }

                pdfBytes = optimizedBytes;
                compressionPrefix = 'Compressed_';
                document.getElementById('compressResult').innerHTML = `✅ 無損瘦身完成：${formatBytes(uncompressedBytes.length)} → <strong>${formatBytes(pdfBytes.length)}</strong>，節省 ${savedPercent}%。`;
            } else {
                document.getElementById('compressResult').textContent = '無損瘦身未啟用。';
            }

            const outputFileName = compressionPrefix + filenamePrefix + document.getElementById('fileNameDisplay').textContent;

            // ==========================================
            // 【核心變更】純前端安全性加密 (@pdfsmaller/pdf-encrypt-lite)
            // ==========================================
            if (document.getElementById('enableEncryptCb').checked) {
                const password = document.getElementById('pdfPassword').value;
                if (!password) {
                    showToast("已開啟安全加密，但尚未輸入密碼，因此本次不會下載檔案。");
                    return;
                } else {
                    try {
                        // 使用 ESM 動態引入，避免破壞全域作用域與初始載入速度
                        const { encryptPDF } = await import('https://esm.sh/@pdfsmaller/pdf-encrypt-lite');
                        
                        // 執行純前端加密運算 (傳入檔案、開啟密碼、擁有者密碼)
                        const encryptedBytes = await encryptPDF(new Uint8Array(pdfBytes), password, password);
                        
                        // 將加密後的陣列覆蓋回去準備匯出
                        pdfBytes = new Uint8Array(encryptedBytes);
                    } catch (err) {
                        console.error(err);
                        showToast("執行前端加密時發生錯誤。為避免意外輸出未加密檔案，本次不會下載。");
                        return;
                    }
                }
            }

            if (strongTargetBytes && pdfBytes.length > strongTargetBytes) {
                document.getElementById('compressResult').innerHTML = `⛔ 最終檔案為 <strong>${formatBytes(pdfBytes.length)}</strong>，超過 ${formatBytes(strongTargetBytes)} 目標，因此未提供下載。`;
                showToast(`加入加密資訊後檔案大小為 ${formatBytes(pdfBytes.length)}，超過目標，因此不會下載。請稍微降低目標大小後再試一次。`);
                return;
            }

            const blob = new Blob([pdfBytes], { type: "application/pdf" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = outputFileName;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            showToast(`已建立 ${outputFileName}（${formatBytes(pdfBytes.length)}）`, 'success');
        }

        downloadAllBtn.onclick = async () => {
            downloadAllBtn.innerHTML = '<span class="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></span>處理中...';
            downloadAllBtn.disabled = true;
            downloadAllBtn.classList.add('opacity-60', 'cursor-wait');
            try {
                const checkboxes = thumbnailsContainer.querySelectorAll('.page-checkbox');
                const currentOrderIndices = Array.from(checkboxes).map(cb => parseInt(cb.value));
                await exportProcessedPdf(currentOrderIndices, "Processed_");
            } catch (error) {
                console.error(error);
                showToast('匯出 PDF 時發生錯誤，請調低壓縮強度或減少頁數後再試。');
            } finally {
                downloadAllBtn.innerHTML = getPrimaryActionHTML(activeTool);
                downloadAllBtn.disabled = false;
                downloadAllBtn.classList.remove('opacity-60', 'cursor-wait');
            }
        };

        downloadSelectedBtn.onclick = async () => {
            downloadSelectedBtn.textContent = "處理中...";
            downloadSelectedBtn.disabled = true;
            downloadSelectedBtn.classList.add('opacity-60', 'cursor-wait');
            try {
                const checkedBoxes = thumbnailsContainer.querySelectorAll('.page-checkbox:checked');
                const selectedOrderIndices = Array.from(checkedBoxes).map(cb => parseInt(cb.value));
                await exportProcessedPdf(selectedOrderIndices, "Extracted_");
            } catch (error) {
                console.error(error);
                showToast('匯出選取頁面時發生錯誤。');
            } finally {
                downloadSelectedBtn.textContent = `匯出選取的 ${selectedPages.size} 頁`;
                downloadSelectedBtn.disabled = false;
                downloadSelectedBtn.classList.remove('opacity-60', 'cursor-wait');
            }
        };

        document.getElementById('resetBtn').onclick = () => { location.reload(); }; 

        // ==========================================
        // PDF 轉 Excel 核心邏輯
        // ==========================================
        pdfToExcelBtn.onclick = async () => {
            if (pdfInput.files.length === 0) return;
            
            const btnOriginalHTML = pdfToExcelBtn.innerHTML;
            pdfToExcelBtn.innerHTML = '<div class="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div> 處理中...';
            pdfToExcelBtn.disabled = true;

            try {
                const workbook = XLSX.utils.book_new();

                for (let fileIdx = 0; fileIdx < pdfInput.files.length; fileIdx++) {
                    const file = pdfInput.files[fileIdx];
                    const arrayBuffer = await file.arrayBuffer();
                    
                    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
                    let allRows = [];

                    for (let i = 1; i <= pdf.numPages; i++) {
                        const page = await pdf.getPage(i);
                        const textContent = await page.getTextContent();
                        const items = textContent.items;

                        const rowMap = new Map();
                        const TOLERANCE = 4;

                        items.forEach(item => {
                            const x = item.transform[4];
                            const y = item.transform[5];

                            let rowY = null;
                            for (let key of rowMap.keys()) {
                                if (Math.abs(key - y) < TOLERANCE) {
                                    rowY = key;
                                    break;
                                }
                            }

                            if (rowY === null) {
                                rowY = y;
                                rowMap.set(rowY, []);
                            }
                            rowMap.get(rowY).push({ str: item.str, x: x });
                        });

                        const sortedY = Array.from(rowMap.keys()).sort((a, b) => b - a);

                        sortedY.forEach(y => {
                            const rowItems = rowMap.get(y).sort((a, b) => a.x - b.x);
                            const rowTextArray = rowItems.map(item => item.str.trim()).filter(str => str.length > 0);
                            if (rowTextArray.length > 0) {
                                allRows.push(rowTextArray);
                            }
                        });

                        allRows.push([]);
                    }

                    let safeSheetName = file.name.replace(/\.[^/.]+$/, "").replace(/[\\/*?:\[\]]/g, "_").substring(0, 31);
                    if (!safeSheetName) safeSheetName = "Sheet" + (fileIdx + 1);

                    const worksheet = XLSX.utils.aoa_to_sheet(allRows);
                    XLSX.utils.book_append_sheet(workbook, worksheet, safeSheetName);
                }

                XLSX.writeFile(workbook, "PDF_Export.xlsx");
                showToast('Excel 檔案已建立完成。', 'success');

            } catch (err) {
                console.error(err);
                showToast("轉換 Excel 發生錯誤，這可能是由於文件加密或格式不受支援。");
            } finally {
                pdfToExcelBtn.innerHTML = btnOriginalHTML;
                pdfToExcelBtn.disabled = false;
            }
        };
