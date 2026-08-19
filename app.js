pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

        let currentPdfDoc = null; 
        let currentPdfBytes = null; 
        let sourceFileSize = 0;
        let pageRotations = {};   
        let selectedPages = new Set(); 
        let isLoadingPdf = false;
        let activeTool = 'organize';
        let fullWorkspaceMode = false;
        let losslessEstimatedRatio = 0;
        let losslessEstimatedBytes = 0;
        let documentHasTextLayer = false;
        let activeOperation = null;
        let activeOcrWorker = null;
        
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
        const extractContentBtn = document.getElementById('extractContentBtn');
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
            excel: { title: '內容擷取', description: '依需求輸出可編輯 Word、表格 Excel 或純文字 TXT。', upload: '載入要擷取內容的 PDF' }
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
            extractContentBtn.classList.toggle('hidden', tool !== 'excel');
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
                fullWorkspaceMode = requestedTool === 'all';
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

        let exportConfirmResolver = null;

        function requestExportConfirmation(pageCount) {
            if (!fullWorkspaceMode) return Promise.resolve(true);
            const features = [];
            if (document.getElementById('enableWmCb').checked) features.push('文字浮水印');
            if (document.getElementById('enableSigCb').checked) features.push('簽名疊加');
            if (document.getElementById('enableCompressCb').checked) features.push('無損瘦身');
            if (document.getElementById('enableStrongCompressCb').checked) features.push(`強力瘦身至 ${document.getElementById('targetSizeMb').value || '?'} MB`);
            if (document.getElementById('enableEncryptCb').checked) features.push('密碼加密');
            if (Object.values(pageRotations).some(angle => angle)) features.push('頁面旋轉');
            if (Object.values(pageEdits).some(edits => edits?.length)) features.push('單頁內容覆蓋');

            const rows = [
                ['來源檔案', document.getElementById('fileNameDisplay').textContent],
                ['輸出頁數', `${pageCount} 頁`],
                ['套用功能', features.length ? features.join('、') : '僅輸出目前頁面與順序'],
                ['注意事項', document.getElementById('enableStrongCompressCb').checked ? '強力瘦身會失去文字搜尋、連結及表單。' : '保留目前 PDF 頁面內容。']
            ];
            const summary = document.getElementById('exportConfirmSummary');
            summary.innerHTML = '';
            rows.forEach(([label, value]) => {
                const row = document.createElement('div');
                row.className = 'grid grid-cols-[6rem_1fr] gap-3 py-2 border-b border-gray-100 dark:border-gray-800 last:border-0';
                const labelElement = document.createElement('span');
                labelElement.className = 'text-gray-500';
                labelElement.textContent = label;
                const valueElement = document.createElement('span');
                valueElement.className = 'font-medium break-words';
                valueElement.textContent = value;
                row.append(labelElement, valueElement);
                summary.appendChild(row);
            });

            const modal = document.getElementById('exportConfirmModal');
            modal.classList.remove('hidden');
            modal.classList.add('flex');
            document.getElementById('confirmExportBtn').focus();
            return new Promise(resolve => { exportConfirmResolver = resolve; });
        }

        function closeExportConfirmation(result) {
            const modal = document.getElementById('exportConfirmModal');
            modal.classList.add('hidden');
            modal.classList.remove('flex');
            exportConfirmResolver?.(result);
            exportConfirmResolver = null;
        }

        document.getElementById('confirmExportBtn').addEventListener('click', () => closeExportConfirmation(true));
        document.getElementById('cancelExportConfirmBtn').addEventListener('click', () => closeExportConfirmation(false));

        function formatBytes(bytes) {
            if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
            const units = ['B', 'KB', 'MB', 'GB'];
            const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
            const value = bytes / Math.pow(1024, unitIndex);
            return `${value.toFixed(unitIndex === 0 ? 0 : 2)} ${units[unitIndex]}`;
        }

        function downloadBlob(blob, filename) {
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = filename;
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
            window.setTimeout(() => URL.revokeObjectURL(url), 1000);
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

        class OperationCancelledError extends Error {
            constructor() {
                super('Operation cancelled');
                this.name = 'OperationCancelledError';
            }
        }

        function startOperation(title) {
            activeOperation = { cancelled: false };
            document.getElementById('operationProgressPanel').classList.remove('hidden');
            document.getElementById('operationProgressTitle').textContent = title;
            updateOperationProgress(0, '準備中...');
            return activeOperation;
        }

        function updateOperationProgress(percent, detail) {
            const safePercent = Math.min(100, Math.max(0, Number(percent) || 0));
            document.getElementById('operationProgressBar').style.width = `${safePercent}%`;
            document.getElementById('operationProgressDetail').textContent = `${detail} · ${Math.round(safePercent)}%`;
        }

        function finishOperation() {
            document.getElementById('operationProgressPanel').classList.add('hidden');
            document.getElementById('operationProgressBar').style.width = '0%';
            activeOperation = null;
        }

        function ensureOperationNotCancelled(operation = activeOperation) {
            if (operation?.cancelled) throw new OperationCancelledError();
        }

        document.getElementById('cancelOperationBtn').addEventListener('click', () => {
            if (activeOperation) {
                activeOperation.cancelled = true;
                document.getElementById('operationProgressDetail').textContent = '正在取消，請稍候...';
                if (activeOcrWorker) {
                    activeOcrWorker.terminate().catch(() => {});
                    activeOcrWorker = null;
                }
            }
        });

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
            losslessEstimatedRatio = savedRatio;
            losslessEstimatedBytes = optimizedBytes.length;
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

        async function analyzeDocumentCharacteristics(pdfBytes) {
            const pdf = await pdfjsLib.getDocument({ data: pdfBytes.slice(0) }).promise;
            let extractedCharacters = 0;
            const sampleCount = Math.min(pdf.numPages, 3);
            for (let pageNumber = 1; pageNumber <= sampleCount; pageNumber++) {
                const page = await pdf.getPage(pageNumber);
                const textContent = await page.getTextContent();
                extractedCharacters += textContent.items.reduce((total, item) => total + (item.str || '').trim().length, 0);
                page.cleanup();
            }
            documentHasTextLayer = extractedCharacters >= 20;
            await pdf.destroy();
        }

        function getRecommendedStrongProfile(targetRatio) {
            if (targetRatio >= 0.70) return { dpi: 150, quality: 0.85 };
            if (targetRatio >= 0.45) return { dpi: 120, quality: 0.75 };
            if (targetRatio >= 0.25) return { dpi: 96, quality: 0.65 };
            return { dpi: 72, quality: 0.50 };
        }

        function updateCompressionRecommendation(applyMode = true) {
            if (!sourceFileSize) return;
            const targetMb = parseFloat(document.getElementById('targetSizeMb').value);
            const recommendation = document.getElementById('compressRecommendation');
            if (!Number.isFinite(targetMb) || targetMb <= 0) {
                recommendation.textContent = '請先輸入有效的目標檔案大小。';
                return;
            }

            const targetBytes = targetMb * 1024 * 1024;
            const targetRatio = targetBytes / sourceFileSize;
            const canUseLossless = losslessEstimatedRatio >= MIN_COMPRESSION_RATIO && losslessEstimatedBytes <= targetBytes;
            const textNote = documentHasTextLayer ? '此 PDF 含有可搜尋文字。' : '此 PDF 主要看起來是掃描圖片。';

            if (targetBytes >= sourceFileSize) {
                recommendation.innerHTML = `ℹ️ 目標 ${formatBytes(targetBytes)} 不小於目前檔案 ${formatBytes(sourceFileSize)}，不需要進行瘦身。`;
                return;
            }

            if (canUseLossless) {
                recommendation.innerHTML = `✅ <strong>建議無損瘦身</strong>：預估可達 ${formatBytes(losslessEstimatedBytes)}，且保留文字、連結與畫質。${textNote}`;
                if (applyMode) {
                    enableCompressCb.checked = true;
                    enableStrongCompressCb.checked = false;
                    strongCompressControls.classList.add('opacity-50', 'pointer-events-none');
                }
            } else {
                const profile = getRecommendedStrongProfile(targetRatio);
                recommendation.innerHTML = `⚡ <strong>建議強力瘦身</strong>：無損模式無法達到 ${formatBytes(targetBytes)}。${textNote} 將整頁轉成圖片，請先確認畫質預覽。`;
                document.getElementById('strongCompressDpi').value = String(profile.dpi);
                document.getElementById('strongCompressQuality').value = String(profile.quality);
                if (applyMode) {
                    enableCompressCb.checked = false;
                    enableStrongCompressCb.checked = true;
                    strongCompressControls.classList.remove('opacity-50', 'pointer-events-none');
                }
            }
        }

        function populateCompressionPreviewPages(pageCount) {
            const select = document.getElementById('compressionPreviewPage');
            select.innerHTML = '';
            for (let index = 0; index < pageCount; index++) {
                const option = document.createElement('option');
                option.value = String(index);
                option.textContent = `第 ${index + 1} 頁`;
                select.appendChild(option);
            }
        }

        async function generateCompressionPreview() {
            if (!currentPdfBytes) return;
            const button = document.getElementById('generateCompressionPreviewBtn');
            const originalLabel = button.textContent;
            button.disabled = true;
            button.textContent = '產生中...';
            try {
                const pageIndex = parseInt(document.getElementById('compressionPreviewPage').value, 10) || 0;
                const dpi = parseInt(document.getElementById('strongCompressDpi').value, 10) || 120;
                const quality = parseFloat(document.getElementById('strongCompressQuality').value) || 0.75;
                const pdf = await pdfjsLib.getDocument({ data: currentPdfBytes.slice(0) }).promise;
                const page = await pdf.getPage(pageIndex + 1);
                const baseViewport = page.getViewport({ scale: 1 });
                const displayScale = Math.min(1.2, 640 / baseViewport.width);
                const displayViewport = page.getViewport({ scale: displayScale });

                const originalCanvas = document.getElementById('originalCompressionPreview');
                originalCanvas.width = Math.round(displayViewport.width);
                originalCanvas.height = Math.round(displayViewport.height);
                await page.render({ canvasContext: originalCanvas.getContext('2d'), viewport: displayViewport }).promise;

                const renderViewport = page.getViewport({ scale: dpi / 72 });
                const sourceCanvas = document.createElement('canvas');
                sourceCanvas.width = Math.round(renderViewport.width);
                sourceCanvas.height = Math.round(renderViewport.height);
                const sourceContext = sourceCanvas.getContext('2d', { alpha: false });
                sourceContext.fillStyle = '#fff';
                sourceContext.fillRect(0, 0, sourceCanvas.width, sourceCanvas.height);
                await page.render({ canvasContext: sourceContext, viewport: renderViewport }).promise;

                const imageBlob = await new Promise(resolve => sourceCanvas.toBlob(resolve, 'image/jpeg', quality));
                if (!imageBlob) throw new Error('無法建立 JPEG 預覽');
                const bitmap = await createImageBitmap(imageBlob);
                const compressedCanvas = document.getElementById('compressedCompressionPreview');
                compressedCanvas.width = originalCanvas.width;
                compressedCanvas.height = originalCanvas.height;
                compressedCanvas.getContext('2d').drawImage(bitmap, 0, 0, compressedCanvas.width, compressedCanvas.height);
                bitmap.close();

                document.getElementById('compressionPreviewArea').classList.remove('hidden');
                document.getElementById('compressionPreviewInfo').textContent = `第 ${pageIndex + 1} 頁 · 建議設定 ${dpi} DPI／品質 ${Math.round(quality * 100)}% · 此預覽不會處理其他頁面。`;
                sourceCanvas.width = 1;
                sourceCanvas.height = 1;
                page.cleanup();
                await pdf.destroy();
            } catch (error) {
                console.error(error);
                showToast('產生壓縮畫質預覽時發生錯誤。');
            } finally {
                button.disabled = false;
                button.textContent = originalLabel;
            }
        }

        document.getElementById('generateCompressionPreviewBtn').addEventListener('click', generateCompressionPreview);

        async function rasterizePdf(pdfBytes, dpi, jpegQuality, options = {}) {
            const sourcePdf = await pdfjsLib.getDocument({ data: pdfBytes.slice(0) }).promise;
            const rasterPdf = await PDFLib.PDFDocument.create();
            const MAX_CANVAS_PIXELS = 24000000;

            for (let pageNumber = 1; pageNumber <= sourcePdf.numPages; pageNumber++) {
                ensureOperationNotCancelled(options.operation);
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
                options.onProgress?.(pageNumber / sourcePdf.numPages, pageNumber, sourcePdf.numPages);
            }

            ensureOperationNotCancelled(options.operation);
            await sourcePdf.destroy();
            return rasterPdf.save({ useObjectStreams: true, addDefaultPage: false, objectsPerTick: 50 });
        }

        async function compressPdfToTarget(pdfBytes, targetBytes, maxDpi, startingQuality, operation) {
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
                ensureOperationNotCancelled(operation);
                const bytes = await rasterizePdf(pdfBytes, dpi, quality, {
                    operation,
                    onProgress: (pageProgress, pageNumber, pageCount) => {
                        const totalProgress = ((index + pageProgress) / profiles.length) * 100;
                        updateOperationProgress(totalProgress, `壓縮階段 ${index + 1}/${profiles.length} · 第 ${pageNumber}/${pageCount} 頁`);
                    }
                });
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
            if (e.key === 'Escape') {
                if (!document.getElementById('exportConfirmModal').classList.contains('hidden')) closeExportConfirmation(false);
                else if (!editModal.classList.contains('hidden')) document.getElementById('closeEditModalBtn').click();
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
                await analyzeDocumentCharacteristics(currentPdfBytes);
                populateCompressionPreviewPages(currentPdfDoc.getPageCount());
                updateCompressionRecommendation(true);
                
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

        function setOcrControlsEnabled(enabled) {
            const controls = document.getElementById('ocrControls');
            controls.classList.toggle('opacity-50', !enabled);
            controls.classList.toggle('pointer-events-none', !enabled);
            controls.querySelectorAll('input, select').forEach(control => { control.disabled = !enabled; });
        }

        document.getElementById('enableOcrCb').onchange = (e) => setOcrControlsEnabled(e.target.checked);
        setOcrControlsEnabled(false);

        const extractionFormatMeta = {
            docx: {
                button: '匯出 Word',
                hint: 'Word 會建立可編輯段落並保留分頁，但不承諾與原 PDF 完全相同的版面。'
            },
            xlsx: {
                button: '擷取表格至 Excel',
                hint: 'Excel 會依文字座標推測列與欄，每份來源 PDF 建立一個工作表；合併儲存格與無框線表格可能錯位。'
            },
            txt: {
                button: '匯出純文字',
                hint: 'TXT 只保留文字、來源檔名與頁碼，不保留字型、圖片或版面，最適合搜尋與再次整理。'
            }
        };

        function updateExtractionFormatUI() {
            const format = document.querySelector('input[name="extractFormat"]:checked')?.value || 'docx';
            const meta = extractionFormatMeta[format];
            const label = document.getElementById('extractContentBtnLabel');
            if (label) label.textContent = meta.button;
            document.getElementById('extractFormatHint').textContent = meta.hint;
        }

        document.querySelectorAll('input[name="extractFormat"]').forEach(input => {
            input.addEventListener('change', updateExtractionFormatUI);
        });
        updateExtractionFormatUI();

        function updateOcrModeUI() {
            const mode = document.querySelector('input[name="ocrMode"]:checked')?.value || 'standard';
            document.getElementById('ocrModeHint').textContent = mode === 'accurate'
                ? '高準確度會提高渲染解析度，分別辨識「對比增強」與「黑白化」影像，再採用信心分數較高的結果。'
                : '標準模式速度較快，適合清楚、端正的掃描文件。';
        }

        document.querySelectorAll('input[name="ocrMode"]').forEach(input => {
            input.addEventListener('change', updateOcrModeUI);
        });
        updateOcrModeUI();

        const enableStrongCompressCb = document.getElementById('enableStrongCompressCb');
        const enableCompressCb = document.getElementById('enableCompressCb');
        const strongCompressControls = document.getElementById('strongCompressControls');

        document.querySelectorAll('.target-size-preset').forEach(button => {
            button.addEventListener('click', () => {
                document.getElementById('targetSizeMb').value = button.dataset.targetMb;
                updateCompressionRecommendation(true);
            });
        });

        document.getElementById('targetSizeMb').addEventListener('input', () => updateCompressionRecommendation(true));

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
                const compressionOperation = startOperation('正在強力瘦身');
                const compressionResult = await compressPdfToTarget(
                    renderSourceBytes,
                    compressionTargetBytes,
                    maxDpi,
                    startingQuality,
                    compressionOperation
                );
                updateOperationProgress(100, '壓縮完成，正在建立檔案');
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
            const checkboxes = thumbnailsContainer.querySelectorAll('.page-checkbox');
            if (!(await requestExportConfirmation(checkboxes.length))) return;
            downloadAllBtn.innerHTML = '<span class="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></span>處理中...';
            downloadAllBtn.disabled = true;
            downloadAllBtn.classList.add('opacity-60', 'cursor-wait');
            try {
                const currentOrderIndices = Array.from(checkboxes).map(cb => parseInt(cb.value));
                await exportProcessedPdf(currentOrderIndices, "Processed_");
            } catch (error) {
                console.error(error);
                if (error instanceof OperationCancelledError) showToast('已取消處理。', 'info');
                else showToast('匯出 PDF 時發生錯誤，請調低壓縮強度或減少頁數後再試。');
            } finally {
                finishOperation();
                downloadAllBtn.innerHTML = getPrimaryActionHTML(activeTool);
                downloadAllBtn.disabled = false;
                downloadAllBtn.classList.remove('opacity-60', 'cursor-wait');
            }
        };

        downloadSelectedBtn.onclick = async () => {
            const checkedBoxes = thumbnailsContainer.querySelectorAll('.page-checkbox:checked');
            if (!(await requestExportConfirmation(checkedBoxes.length))) return;
            downloadSelectedBtn.textContent = "處理中...";
            downloadSelectedBtn.disabled = true;
            downloadSelectedBtn.classList.add('opacity-60', 'cursor-wait');
            try {
                const selectedOrderIndices = Array.from(checkedBoxes).map(cb => parseInt(cb.value));
                await exportProcessedPdf(selectedOrderIndices, "Extracted_");
            } catch (error) {
                console.error(error);
                if (error instanceof OperationCancelledError) showToast('已取消處理。', 'info');
                else showToast('匯出選取頁面時發生錯誤。');
            } finally {
                finishOperation();
                downloadSelectedBtn.textContent = `匯出選取的 ${selectedPages.size} 頁`;
                downloadSelectedBtn.disabled = false;
                downloadSelectedBtn.classList.remove('opacity-60', 'cursor-wait');
            }
        };

        document.getElementById('resetBtn').onclick = () => { location.reload(); }; 

        // ==========================================
        // PDF 內容擷取：Word / Excel / TXT
        // ==========================================
        function extractRowsFromTextItems(items) {
            const rowMap = new Map();
            const TOLERANCE = 4;
            items.forEach(item => {
                const x = item.transform[4];
                const y = item.transform[5];
                let rowY = null;
                for (const key of rowMap.keys()) {
                    if (Math.abs(key - y) < TOLERANCE) { rowY = key; break; }
                }
                if (rowY === null) {
                    rowY = y;
                    rowMap.set(rowY, []);
                }
                rowMap.get(rowY).push({ str: item.str, x });
            });
            return Array.from(rowMap.keys()).sort((a, b) => b - a).flatMap(y => {
                const row = rowMap.get(y).sort((a, b) => a.x - b.x).map(item => item.str.trim()).filter(Boolean);
                return row.length ? [row] : [];
            });
        }

        function extractRowsFromOcrText(text) {
            return text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
                const cells = line.split(/\t|\s{2,}/).map(cell => cell.trim()).filter(Boolean);
                return cells.length ? cells : [line];
            });
        }

        function getOcrRenderScale(page, mode) {
            const baseViewport = page.getViewport({ scale: 1 });
            const requestedScale = mode === 'accurate' ? (300 / 72) : 2;
            const maxPixels = mode === 'accurate' ? 10000000 : 6000000;
            const safeScale = Math.sqrt(maxPixels / Math.max(1, baseViewport.width * baseViewport.height));
            return Math.max(1, Math.min(requestedScale, safeScale));
        }

        function getHistogramPercentile(histogram, total, ratio) {
            const target = total * ratio;
            let cumulative = 0;
            for (let value = 0; value < histogram.length; value++) {
                cumulative += histogram[value];
                if (cumulative >= target) return value;
            }
            return 255;
        }

        function getOtsuThreshold(histogram, total) {
            let weightedTotal = 0;
            for (let value = 0; value < 256; value++) weightedTotal += value * histogram[value];
            let backgroundWeight = 0;
            let backgroundSum = 0;
            let bestVariance = -1;
            let bestThreshold = 160;

            for (let threshold = 0; threshold < 256; threshold++) {
                backgroundWeight += histogram[threshold];
                if (!backgroundWeight) continue;
                const foregroundWeight = total - backgroundWeight;
                if (!foregroundWeight) break;
                backgroundSum += threshold * histogram[threshold];
                const backgroundMean = backgroundSum / backgroundWeight;
                const foregroundMean = (weightedTotal - backgroundSum) / foregroundWeight;
                const variance = backgroundWeight * foregroundWeight * Math.pow(backgroundMean - foregroundMean, 2);
                if (variance > bestVariance) {
                    bestVariance = variance;
                    bestThreshold = threshold;
                }
            }
            return bestThreshold;
        }

        function createOcrPreprocessedCanvas(sourceCanvas, binary = false) {
            const canvas = document.createElement('canvas');
            canvas.width = sourceCanvas.width;
            canvas.height = sourceCanvas.height;
            const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
            context.drawImage(sourceCanvas, 0, 0);
            const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
            const pixels = imageData.data;
            const pixelCount = pixels.length / 4;
            const grayscale = new Uint8Array(pixelCount);
            const histogram = new Uint32Array(256);

            for (let pixelIndex = 0, offset = 0; pixelIndex < pixelCount; pixelIndex++, offset += 4) {
                const gray = Math.round(pixels[offset] * 0.299 + pixels[offset + 1] * 0.587 + pixels[offset + 2] * 0.114);
                grayscale[pixelIndex] = gray;
                histogram[gray] += 1;
            }

            const low = getHistogramPercentile(histogram, pixelCount, 0.01);
            const high = getHistogramPercentile(histogram, pixelCount, 0.99);
            const range = Math.max(32, high - low);
            const normalizedHistogram = new Uint32Array(256);

            for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
                const normalized = Math.max(0, Math.min(255, Math.round((grayscale[pixelIndex] - low) * 255 / range)));
                grayscale[pixelIndex] = normalized;
                normalizedHistogram[normalized] += 1;
            }

            const threshold = binary ? getOtsuThreshold(normalizedHistogram, pixelCount) : 0;
            for (let pixelIndex = 0, offset = 0; pixelIndex < pixelCount; pixelIndex++, offset += 4) {
                const value = binary ? (grayscale[pixelIndex] >= threshold ? 255 : 0) : grayscale[pixelIndex];
                pixels[offset] = value;
                pixels[offset + 1] = value;
                pixels[offset + 2] = value;
                pixels[offset + 3] = 255;
            }
            context.putImageData(imageData, 0, 0);
            return canvas;
        }

        function getOcrConfidence(result) {
            const textLength = (result?.data?.text || '').trim().length;
            if (!textLength) return -1;
            const confidence = Number(result?.data?.confidence);
            return Number.isFinite(confidence) ? confidence : 0;
        }

        function getSafeOutputStem(files) {
            if (files.length !== 1) return 'PDF_內容擷取';
            const stem = files[0].name.replace(/\.[^/.]+$/, '').replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').trim();
            return stem || 'PDF_內容擷取';
        }

        async function extractContentFromPdfs(files, useOcr, operation) {
            const extractedFiles = [];
            let currentOcrBase = 0;
            let currentOcrSpan = 0;
            const ocrMode = document.querySelector('input[name="ocrMode"]:checked')?.value || 'standard';

            if (useOcr) {
                if (!window.Tesseract) throw new Error('OCR 套件尚未載入');
                const languages = document.getElementById('ocrLanguage').value.split('+');
                activeOcrWorker = await Tesseract.createWorker(languages, 1, {
                    logger: message => {
                        if (message.status === 'recognizing text') {
                            updateOperationProgress(currentOcrBase + message.progress * currentOcrSpan, '正在辨識掃描頁面文字');
                        }
                    }
                });
                await activeOcrWorker.setParameters({
                    tessedit_pageseg_mode: Tesseract.PSM?.AUTO || '3',
                    preserve_interword_spaces: '1',
                    user_defined_dpi: ocrMode === 'accurate' ? '300' : '144'
                });
            }

            for (let fileIdx = 0; fileIdx < files.length; fileIdx++) {
                ensureOperationNotCancelled(operation);
                const file = files[fileIdx];
                const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
                const extractedFile = { name: file.name, pages: [] };

                try {
                    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
                        ensureOperationNotCancelled(operation);
                        const page = await pdf.getPage(pageNumber);
                        const pageBase = ((fileIdx + (pageNumber - 1) / pdf.numPages) / files.length) * 94;
                        const pageSpan = (1 / pdf.numPages / files.length) * 94;

                        try {
                            const textContent = await page.getTextContent();
                            const readableCharacters = textContent.items.reduce((total, item) => total + (item.str || '').trim().length, 0);
                            let rows;
                            let source;

                            if (readableCharacters >= 5) {
                                rows = extractRowsFromTextItems(textContent.items);
                                source = 'text';
                                updateOperationProgress(pageBase + pageSpan, `讀取 ${file.name} · 第 ${pageNumber}/${pdf.numPages} 頁`);
                            } else if (useOcr) {
                                const renderScale = getOcrRenderScale(page, ocrMode);
                                const viewport = page.getViewport({ scale: renderScale });
                                const canvas = document.createElement('canvas');
                                canvas.width = Math.round(viewport.width);
                                canvas.height = Math.round(viewport.height);
                                const canvasContext = canvas.getContext('2d', { alpha: false });
                                canvasContext.fillStyle = '#ffffff';
                                canvasContext.fillRect(0, 0, canvas.width, canvas.height);
                                await page.render({ canvasContext, viewport }).promise;

                                try {
                                    let result;
                                    if (ocrMode === 'accurate') {
                                        updateOperationProgress(pageBase + pageSpan * 0.06, `強化影像 · ${file.name} 第 ${pageNumber} 頁`);
                                        await new Promise(resolve => requestAnimationFrame(resolve));
                                        ensureOperationNotCancelled(operation);
                                        const enhancedCanvas = createOcrPreprocessedCanvas(canvas, false);
                                        currentOcrBase = pageBase + pageSpan * 0.08;
                                        currentOcrSpan = pageSpan * 0.42;
                                        let enhancedResult;
                                        try {
                                            enhancedResult = await activeOcrWorker.recognize(enhancedCanvas);
                                        } finally {
                                            enhancedCanvas.width = 1;
                                            enhancedCanvas.height = 1;
                                        }
                                        ensureOperationNotCancelled(operation);

                                        updateOperationProgress(pageBase + pageSpan * 0.50, `建立黑白版本 · ${file.name} 第 ${pageNumber} 頁`);
                                        await new Promise(resolve => requestAnimationFrame(resolve));
                                        ensureOperationNotCancelled(operation);
                                        const binaryCanvas = createOcrPreprocessedCanvas(canvas, true);
                                        currentOcrBase = pageBase + pageSpan * 0.52;
                                        currentOcrSpan = pageSpan * 0.42;
                                        let binaryResult;
                                        try {
                                            binaryResult = await activeOcrWorker.recognize(binaryCanvas);
                                        } finally {
                                            binaryCanvas.width = 1;
                                            binaryCanvas.height = 1;
                                        }
                                        ensureOperationNotCancelled(operation);

                                        result = getOcrConfidence(enhancedResult) >= getOcrConfidence(binaryResult)
                                            ? enhancedResult
                                            : binaryResult;
                                        updateOperationProgress(pageBase + pageSpan, `完成高準確度辨識 · 第 ${pageNumber}/${pdf.numPages} 頁`);
                                    } else {
                                        currentOcrBase = pageBase;
                                        currentOcrSpan = pageSpan;
                                        result = await activeOcrWorker.recognize(canvas);
                                        ensureOperationNotCancelled(operation);
                                    }
                                    rows = extractRowsFromOcrText(result.data.text || '');
                                    source = 'ocr';
                                } finally {
                                    canvas.width = 1;
                                    canvas.height = 1;
                                }
                            } else {
                                rows = [['[此頁沒有可讀文字；可啟用 OCR 再試]']];
                                source = 'empty';
                                updateOperationProgress(pageBase + pageSpan, `略過掃描頁面 · 第 ${pageNumber}/${pdf.numPages} 頁`);
                            }

                            if (!rows.length) rows = [[source === 'ocr' ? '[OCR 未辨識到文字]' : '[此頁沒有可讀文字]']];
                            extractedFile.pages.push({ pageNumber, rows, source });
                        } finally {
                            page.cleanup();
                        }
                    }
                } finally {
                    await pdf.destroy();
                }

                extractedFiles.push(extractedFile);
            }

            return extractedFiles;
        }

        function buildTxtBlob(extractedFiles) {
            const sections = [];
            extractedFiles.forEach(file => {
                sections.push(`===== ${file.name} =====`);
                file.pages.forEach(page => {
                    sections.push(`--- 第 ${page.pageNumber} 頁 ---`);
                    sections.push(page.rows.map(row => row.join('\t')).join('\n'));
                });
            });
            return new Blob([`\uFEFF${sections.join('\n\n')}`], { type: 'text/plain;charset=utf-8' });
        }

        function appendUniqueSheet(workbook, rows, preferredName, index) {
            const base = (preferredName.replace(/\.[^/.]+$/, '').replace(/[\\/*?:\[\]]/g, '_').substring(0, 31) || `Sheet${index + 1}`);
            let name = base;
            let suffix = 2;
            while (workbook.SheetNames.includes(name)) {
                const ending = `_${suffix++}`;
                name = `${base.substring(0, 31 - ending.length)}${ending}`;
            }
            XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), name);
        }

        function buildExcelBlob(extractedFiles) {
            if (!window.XLSX) throw new Error('Excel 套件尚未載入');
            const workbook = XLSX.utils.book_new();
            extractedFiles.forEach((file, fileIndex) => {
                const rows = [];
                file.pages.forEach(page => {
                    rows.push([`第 ${page.pageNumber} 頁`]);
                    rows.push(...page.rows, []);
                });
                appendUniqueSheet(workbook, rows, file.name, fileIndex);
            });
            const bytes = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
            return new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        }

        async function buildWordBlob(extractedFiles) {
            if (!window.docx) throw new Error('Word 套件尚未載入');
            const { Document, Packer, Paragraph, TextRun, PageBreak } = window.docx;
            const children = [];
            const totalPages = extractedFiles.reduce((sum, file) => sum + file.pages.length, 0);
            let emittedPages = 0;

            if (extractedFiles.length > 1) {
                children.push(new Paragraph({
                    style: 'DocumentTitle',
                    children: [new TextRun('PDF 內容擷取')]
                }));
            }

            extractedFiles.forEach(file => {
                children.push(new Paragraph({
                    style: extractedFiles.length > 1 ? 'SourceTitle' : 'DocumentTitle',
                    children: [new TextRun(file.name.replace(/\.[^/.]+$/, ''))]
                }));

                file.pages.forEach(page => {
                    children.push(new Paragraph({
                        style: 'PageLabel',
                        children: [new TextRun(`第 ${page.pageNumber} 頁${page.source === 'ocr' ? ' · OCR' : ''}`)]
                    }));
                    page.rows.forEach(row => {
                        children.push(new Paragraph({
                            style: 'ExtractedBody',
                            children: [new TextRun(row.join('    '))]
                        }));
                    });
                    emittedPages += 1;
                    if (emittedPages < totalPages) children.push(new Paragraph({ children: [new PageBreak()] }));
                });
            });

            const documentFile = new Document({
                creator: 'Web PDF Tools',
                description: '從 PDF 擷取的可編輯文字內容',
                styles: {
                    default: {
                        document: {
                            run: { font: 'Arial', size: 22, color: '111827' },
                            paragraph: { spacing: { after: 120, line: 264 } }
                        }
                    },
                    paragraphStyles: [
                        {
                            id: 'DocumentTitle', name: 'Document Title', basedOn: 'Normal', next: 'ExtractedBody', quickFormat: true,
                            run: { font: 'Arial', size: 40, bold: true, color: '0F172A' },
                            paragraph: { spacing: { before: 0, after: 240 }, outlineLevel: 0 }
                        },
                        {
                            id: 'SourceTitle', name: 'Source Title', basedOn: 'Normal', next: 'PageLabel', quickFormat: true,
                            run: { font: 'Arial', size: 32, bold: true, color: '0E7490' },
                            paragraph: { spacing: { before: 0, after: 160 }, outlineLevel: 1 }
                        },
                        {
                            id: 'PageLabel', name: 'Page Label', basedOn: 'Normal', next: 'ExtractedBody', quickFormat: true,
                            run: { font: 'Arial', size: 18, bold: true, color: '64748B' },
                            paragraph: { spacing: { before: 0, after: 160 } }
                        },
                        {
                            id: 'ExtractedBody', name: 'Extracted Body', basedOn: 'Normal', next: 'ExtractedBody', quickFormat: true,
                            run: { font: 'Arial', size: 22, color: '111827' },
                            paragraph: { spacing: { before: 0, after: 120, line: 264 } }
                        }
                    ]
                },
                sections: [{
                    properties: {
                        page: {
                            size: { width: 12240, height: 15840 },
                            margin: { top: 1440, right: 1440, bottom: 1440, left: 1440, header: 708, footer: 708 }
                        }
                    },
                    children
                }]
            });
            return Packer.toBlob(documentFile);
        }

        extractContentBtn.onclick = async () => {
            if (pdfInput.files.length === 0) return;
            const btnOriginalHTML = extractContentBtn.innerHTML;
            extractContentBtn.innerHTML = '<div class="w-4 h-4 border-2 border-cyan-600 border-t-transparent rounded-full animate-spin"></div> 處理中...';
            extractContentBtn.disabled = true;
            const format = document.querySelector('input[name="extractFormat"]:checked')?.value || 'docx';
            const formatName = { docx: 'Word', xlsx: 'Excel', txt: 'TXT' }[format];
            const useOcr = document.getElementById('enableOcrCb').checked;
            const highAccuracyOcr = useOcr && document.querySelector('input[name="ocrMode"]:checked')?.value === 'accurate';
            const operation = startOperation(highAccuracyOcr ? `正在進行高準確度 OCR 並建立 ${formatName}` : `正在擷取內容並建立 ${formatName}`);

            try {
                const files = Array.from(pdfInput.files);
                const extractedFiles = await extractContentFromPdfs(files, useOcr, operation);
                ensureOperationNotCancelled(operation);
                updateOperationProgress(96, `正在建立 ${formatName} 檔案`);

                const outputStem = getSafeOutputStem(files);
                let blob;
                let filename;
                if (format === 'docx') {
                    blob = await buildWordBlob(extractedFiles);
                    filename = `${outputStem}_可編輯文字.docx`;
                } else if (format === 'xlsx') {
                    blob = buildExcelBlob(extractedFiles);
                    filename = `${outputStem}_表格擷取.xlsx`;
                } else {
                    blob = buildTxtBlob(extractedFiles);
                    filename = `${outputStem}_純文字.txt`;
                }

                ensureOperationNotCancelled(operation);
                updateOperationProgress(100, `${formatName} 檔案已完成`);
                downloadBlob(blob, filename);
                showToast(`已建立 ${filename}（${formatBytes(blob.size)}）`, 'success');
            } catch (err) {
                console.error(err);
                if (operation.cancelled || err instanceof OperationCancelledError) showToast('已取消內容擷取。', 'info');
                else showToast(`建立 ${formatName} 時發生錯誤。OCR 首次使用需保持網路連線，且加密或損毀的 PDF 可能無法處理。`);
            } finally {
                if (activeOcrWorker) {
                    await activeOcrWorker.terminate().catch(() => {});
                    activeOcrWorker = null;
                }
                finishOperation();
                extractContentBtn.innerHTML = btnOriginalHTML;
                extractContentBtn.disabled = false;
                updateExtractionFormatUI();
            }
        };
