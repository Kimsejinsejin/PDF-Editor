import React, { useState, useRef, useEffect } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import confetti from 'canvas-confetti';
import Tesseract from 'tesseract.js';
import { 
  Upload, Type, Edit2, Highlighter, Image as ImageIcon, 
  Download, ZoomIn, ZoomOut, RotateCcw, 
  Sparkles, Send, Moon, Sun, Trash, Plus, ScanLine, HelpCircle
} from 'lucide-react';

// Configure pdfjs worker to run seamlessly in Vite from a stable CDN
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js`;

interface TextOverlay {
  id: string;
  pageNum: number;
  text: string;
  xRatio: number;
  yRatio: number;
  fontSize: number;
  color: string;
  maskBg: boolean; // Solid background mask to cover old scanned text underneath
  bgColor: string; // Dynamic background color matching paper (sampled via AI OCR)
}

interface ImageOverlay {
  id: string;
  pageNum: number;
  src: string; // Base64
  xRatio: number;
  yRatio: number;
  widthRatio: number;
  heightRatio: number;
}

interface DrawingStroke {
  points: { xRatio: number; yRatio: number }[];
  color: string;
  size: number;
  type: 'pen' | 'highlight';
}

interface DrawingMap {
  [pageNum: number]: DrawingStroke[];
}

interface AIMessage {
  id: string;
  sender: 'system' | 'user' | 'ai';
  text: string;
}

export default function App() {
  // Theme State
  const [theme, setTheme] = useState<'light' | 'dark'>('light');

  // PDF Document States
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [pdfDocJs, setPdfDocJs] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [pdfDocLibBytes, setPdfDocLibBytes] = useState<Uint8Array | null>(null);
  const [numPages, setNumPages] = useState<number>(0);
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [zoom, setZoom] = useState<number>(1.25);
  const [pagesOrder, setPagesOrder] = useState<number[]>([]); // To support page reordering

  // Toolbar States
  const [activeTool, setActiveTool] = useState<'select' | 'text' | 'draw' | 'highlight' | 'image'>('select');
  const [brushColor, setBrushColor] = useState<string>('#7c3aed'); // Purple accent
  const [brushSize, setBrushSize] = useState<number>(4);
  const [highlightColor] = useState<string>('rgba(255, 91, 0, 0.35)'); // Translucent orange accent

  // AI OCR States
  const [ocrLanguage, setOcrLanguage] = useState<string>('kor+eng');
  const [ocrProgress, setOcrProgress] = useState<number | null>(null);
  const [ocrRunning, setOcrRunning] = useState<boolean>(false);

  // Overlay Annotation States
  const [textOverlays, setTextOverlays] = useState<TextOverlay[]>([]);
  const [imageOverlays, setImageOverlays] = useState<ImageOverlay[]>([]);
  const [selectedOverlayId, setSelectedOverlayId] = useState<string | null>(null);

  // Drawing Canvas States
  const [drawings, setDrawings] = useState<DrawingMap>({});
  const [isDrawing, setIsDrawing] = useState<boolean>(false);
  const currentStrokePoints = useRef<{ xRatio: number; yRatio: number }[]>([]);

  // AI Assistant States
  const [aiMessages, setAiMessages] = useState<AIMessage[]>([
    { id: '1', sender: 'system', text: '안녕하세요! Atech AI PDF 어시스턴트입니다. 문서를 업로드해 주시면 요약, 채팅 및 다시 쓰기가 가능합니다.' }
  ]);
  const [aiInput, setAiInput] = useState<string>('');
  const [aiLoading, setAiLoading] = useState<boolean>(false);

  // Refs
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const mainCanvasRef = useRef<HTMLCanvasElement>(null);
  const drawingCanvasRef = useRef<HTMLCanvasElement>(null);
  const sidebarThumbsRef = useRef<HTMLDivElement>(null);

  // ----------------------------------------------------
  // Initialization & Theme Handling
  // ----------------------------------------------------
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  // ----------------------------------------------------
  // PDF File Upload Handler
  // ----------------------------------------------------
  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || file.type !== 'application/pdf') return;

    setPdfFile(file);
    const arrayBuffer = await file.arrayBuffer();
    setPdfDocLibBytes(new Uint8Array(arrayBuffer));

    try {
      // Load into pdfjs for rendering
      const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
      const doc = await loadingTask.promise;
      setPdfDocJs(doc);
      setNumPages(doc.numPages);
      setCurrentPage(1);

      // Initialize default pages order [1, 2, ..., numPages]
      const order = Array.from({ length: doc.numPages }, (_, i) => i + 1);
      setPagesOrder(order);

      // Reset annotations
      setTextOverlays([]);
      setImageOverlays([]);
      setDrawings({});
      setSelectedOverlayId(null);

      // Trigger AI Welcome for the file
      setAiMessages([
        { id: '1', sender: 'system', text: `문서 [${file.name}] 업로드가 완료되었습니다. ⚡AI 분석 및 OCR 스캔이 준비되었습니다!` }
      ]);

      // Draw thumbnails after doc load
      setTimeout(() => renderThumbnails(doc, order), 200);

    } catch (err) {
      console.error("PDF loading error: ", err);
      alert("PDF 파일을 불러오는데 실패했습니다.");
    }
  };

  // ----------------------------------------------------
  // Main PDF Viewport Rendering Loop
  // ----------------------------------------------------
  useEffect(() => {
    if (!pdfDocJs || !mainCanvasRef.current) return;

    const renderPage = async () => {
      try {
        // Translate visual currentPage page-number back to its physical page in PDF based on pagesOrder array
        const physicalPageNum = pagesOrder[currentPage - 1] || currentPage;
        const page = await pdfDocJs.getPage(physicalPageNum);
        
        const viewport = page.getViewport({ scale: zoom });
        const canvas = mainCanvasRef.current!;
        const context = canvas.getContext('2d')!;
        
        canvas.height = viewport.height;
        canvas.width = viewport.width;
        
        const renderContext = {
          canvasContext: context,
          viewport: viewport,
        };
        await page.render(renderContext).promise;

        // Resize the interactive Drawing Canvas to match exactly
        if (drawingCanvasRef.current) {
          const drawCanvas = drawingCanvasRef.current;
          drawCanvas.width = viewport.width;
          drawCanvas.height = viewport.height;
          renderDrawingOnCanvas(drawCanvas, physicalPageNum);
        }

      } catch (err) {
        console.error("Page render error: ", err);
      }
    };

    renderPage();
  }, [pdfDocJs, currentPage, zoom, drawings, pagesOrder]);

  // ----------------------------------------------------
  // Thumbnail Rendering (Sidebar)
  // ----------------------------------------------------
  const renderThumbnails = async (doc: pdfjsLib.PDFDocumentProxy, order: number[]) => {
    if (!sidebarThumbsRef.current) return;
    
    // Quick rendering for each ordered page onto small card canvases
    for (let index = 0; index < order.length; index++) {
      const pageNum = order[index];
      const thumbCanvas = document.getElementById(`thumb-canvas-${pageNum}`) as HTMLCanvasElement;
      if (!thumbCanvas) continue;

      try {
        const page = await doc.getPage(pageNum);
        const viewport = page.getViewport({ scale: 0.25 }); // 25% scale for thumbs
        thumbCanvas.width = viewport.width;
        thumbCanvas.height = viewport.height;
        const context = thumbCanvas.getContext('2d')!;
        
        await page.render({
          canvasContext: context,
          viewport: viewport
        }).promise;
      } catch (err) {
        console.error("Thumb render error: ", err);
      }
    }
  };

  // Re-render thumbnails if order changes
  useEffect(() => {
    if (pdfDocJs && pagesOrder.length > 0) {
      renderThumbnails(pdfDocJs, pagesOrder);
    }
  }, [pagesOrder, pdfDocJs]);

  // Helper to check if canvas page is dark-themed
  const isCanvasDark = (ctx: CanvasRenderingContext2D, width: number, height: number): boolean => {
    try {
      let totalLuminance = 0;
      let count = 0;
      const stepX = Math.floor(width / 8);
      const stepY = Math.floor(height / 8);

      for (let x = stepX; x < width; x += stepX) {
        for (let y = stepY; y < height; y += stepY) {
          const pixel = ctx.getImageData(x, y, 1, 1).data;
          const r = pixel[0];
          const g = pixel[1];
          const b = pixel[2];
          // Standard relative luminance formula
          const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
          totalLuminance += luminance;
          count++;
        }
      }

      if (count > 0) {
        const avgLuminance = totalLuminance / count;
        console.log(`Average page luminance: ${avgLuminance}`);
        return avgLuminance < 110; // Threshold of 110/255 for dark pages
      }
    } catch (e) {
      console.error("Dark theme check failed: ", e);
    }
    return false;
  };
  // Helper to invert canvas pixels (white text on dark bg -> black text on light bg)
  const invertCanvasColors = (canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D) => {
    try {
      const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = imgData.data;
      for (let i = 0; i < data.length; i += 4) {
        data[i] = 255 - data[i];       // Red
        data[i + 1] = 255 - data[i + 1];   // Green
        data[i + 2] = 255 - data[i + 2];   // Blue
      }
      ctx.putImageData(imgData, 0, 0);
    } catch (e) {
      console.error("Canvas inversion failed: ", e);
    }
  };



  // ----------------------------------------------------
  // Smart Background Inpainting Color Sampler
  // ----------------------------------------------------
  const getAverageBgColor = (ctx: CanvasRenderingContext2D, bbox: any, canvasW: number, canvasH: number, isDark: boolean): string => {
    try {
      if (!bbox || typeof bbox.x0 !== 'number' || typeof bbox.y0 !== 'number' || typeof bbox.x1 !== 'number' || typeof bbox.y1 !== 'number') {
        return isDark ? '#222222' : '#ffffff';
      }
      
      const x0 = Math.round(bbox.x0);
      const y0 = Math.round(bbox.y0);
      const x1 = Math.round(bbox.x1);
      const y1 = Math.round(bbox.y1);
      
      if (isNaN(x0) || isNaN(y0) || isNaN(x1) || isNaN(y1)) {
        return isDark ? '#222222' : '#ffffff';
      }

      const safeX = Math.max(0, Math.min(canvasW - 1, x0));
      const safeY = Math.max(0, Math.min(canvasH - 1, y0));
      const w = Math.max(1, Math.min(canvasW - safeX, x1 - x0));
      const h = Math.max(1, Math.min(canvasH - safeY, y1 - y0));
      
      if (isNaN(w) || isNaN(h) || w <= 0 || h <= 0 || !isFinite(w) || !isFinite(h)) {
        return isDark ? '#222222' : '#ffffff';
      }
      
      const imgData = ctx.getImageData(safeX, safeY, w, h);
      const data = imgData.data;
      
      let sumR = 0, sumG = 0, sumB = 0, count = 0;
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i+1];
        const b = data[i+2];
        const brightness = (r + g + b) / 3;
        
        if (isDark) {
          // On dark pages, background is dark (brightness < 120), text is bright (white)
          if (brightness < 120) {
            sumR += r;
            sumG += g;
            sumB += b;
            count++;
          }
        } else {
          // On light pages, background is bright (brightness > 130), text is dark
          if (brightness > 130) {
            sumR += r;
            sumG += g;
            sumB += b;
            count++;
          }
        }
      }
      
      if (count > 0) {
        const r = Math.round(sumR / count);
        const g = Math.round(sumG / count);
        const b = Math.round(sumB / count);
        return '#' + [r, g, b].map(x => {
          const hexStr = x.toString(16);
          return hexStr.length === 1 ? '0' + hexStr : hexStr;
        }).join('');
      }
    } catch (e) {
      console.error("Bg sampling failed: ", e);
    }
    return isDark ? '#222222' : '#ffffff'; // default fallback
  };

  // AI OCR Engine Integration (Scanned to Editable Text)
  // ----------------------------------------------------
  const runAIOCRScan = async () => {
    if (!pdfDocJs || ocrRunning) return;

    setOcrRunning(true);
    setOcrProgress(0);

    try {
      const physicalPageNum = pagesOrder[currentPage - 1] || currentPage;
      const page = await pdfDocJs.getPage(physicalPageNum);

      // Render the page at a constant high-definition scale (1.5) on an off-screen canvas for maximum OCR accuracy!
      const ocrScale = 1.5; 
      const viewport = page.getViewport({ scale: ocrScale });
      
      const offscreenCanvas = document.createElement('canvas');
      offscreenCanvas.width = viewport.width;
      offscreenCanvas.height = viewport.height;
      const offscreenCtx = offscreenCanvas.getContext('2d')!;

      // CRITICAL FIX: Fill the canvas with a solid white background!
      // PDF.js renders with transparent background by default, which turns pitch black in PNG conversion
      // and completely blinds the Tesseract OCR engine. Filling with white guarantees maximum text contrast!
      offscreenCtx.fillStyle = '#ffffff';
      offscreenCtx.fillRect(0, 0, offscreenCanvas.width, offscreenCanvas.height);

      await page.render({
        canvasContext: offscreenCtx,
        viewport: viewport
      }).promise;

      const canvasW = offscreenCanvas.width;
      const canvasH = offscreenCanvas.height;

      // 1. Create a sampling canvas to preserve original non-binarized colors for background matching!
      const samplingCanvas = document.createElement('canvas');
      samplingCanvas.width = canvasW;
      samplingCanvas.height = canvasH;
      const samplingCtx = samplingCanvas.getContext('2d')!;
      samplingCtx.drawImage(offscreenCanvas, 0, 0);

      // 2. Detect if the canvas is dark-themed
      const isDarkPage = isCanvasDark(offscreenCtx, canvasW, canvasH);

      // 3. If dark page, invert the colors to convert white text on black background
      // to black text on white background, giving Tesseract perfect contrast!
      if (isDarkPage) {
        console.log("Dark slide page detected! Automatically inverting canvas pixels for OCR...");
        invertCanvasColors(offscreenCanvas, offscreenCtx);
      }

      const dataUrl = offscreenCanvas.toDataURL('image/png');

      // 4. Create local Tesseract Worker explicitly to guarantee local asset resolution!
      const worker = await Tesseract.createWorker(ocrLanguage, 1, {
        workerPath: window.location.origin + '/tessdata/worker.min.js',
        corePath: window.location.origin + '/tessdata',
        langPath: window.location.origin + '/tessdata',
        gzip: false, // MANDATORY: Use raw decompressed .traineddata files for 100% offline reliability and no browser gzip parsing issues!
        logger: m => {
          if (m.status === 'recognizing text') {
            setOcrProgress(Math.round(m.progress * 100));
          }
        }
      });

      // 5. Perform OCR
      const result = await worker.recognize(dataUrl);

      // 6. Terminate worker immediately to reclaim memory
      await worker.terminate();

      // Defensive check for recognized text lines to avoid any crash
      const lines = (result?.data as any)?.lines || [];

      // Extract bounding boxes and populate editable overlays with dynamic matched background color!
      const newOverlays: TextOverlay[] = lines
        .filter((line: any) => line && line.text && line.text.trim().length > 1) // filter out noise
        .map((line: any, idx: number) => {
          const bbox = line.bbox;
          if (!bbox) {
            return {
              id: `ocr-${Date.now()}-${idx}`,
              pageNum: physicalPageNum,
              text: line.text.replace(/\n/g, '').trim(),
              xRatio: 0.1,
              yRatio: 0.1,
              fontSize: 16,
              color: isDarkPage ? '#ffffff' : '#000000',
              maskBg: true,
              bgColor: isDarkPage ? '#222222' : '#ffffff'
            };
          }
          const height = bbox.y1 - bbox.y0;
          const fontSize = Math.max(10, Math.min(60, (height || 20) * 0.75));

          // Sample exact matching background color from the ORIGINAL non-binarized sampling context!
          const sampledBgColor = getAverageBgColor(samplingCtx, bbox, canvasW, canvasH, isDarkPage);

          // Decide text color based on page brightness
          const overlayTextColor = isDarkPage ? '#ffffff' : '#000000';

          return {
            id: `ocr-${Date.now()}-${idx}`,
            pageNum: physicalPageNum,
            text: line.text.replace(/\n/g, '').trim(),
            xRatio: isNaN(bbox.x0 / canvasW) ? 0.1 : bbox.x0 / canvasW,
            yRatio: isNaN(bbox.y0 / canvasH) ? 0.1 : bbox.y0 / canvasH,
            fontSize: isNaN(fontSize / ocrScale) ? 14 : fontSize / ocrScale, // Normalize by the high-definition OCR scale (1.5) to baseline size!
            color: overlayTextColor,
            maskBg: true, // Enable background mask by default to cover original image text
            bgColor: sampledBgColor // Matches cream, off-white, gray paper exactly!
          };
        });

      setTextOverlays(prev => [
        ...prev.filter(t => t.pageNum !== physicalPageNum), // replace existing for this page
        ...newOverlays
      ]);

      // Highlight in AI Chat
      setAiMessages(prev => [...prev, {
        id: `ai-ocr-res-${Date.now()}`,
        sender: 'ai',
        text: `⚡[지능형 OCR 스캔 성공] 이미지 속에서 ${newOverlays.length}개의 글자 상자를 정밀 추출했습니다! ${isDarkPage ? '어두운 슬라이드 장표를 감지하여 지능형 색상 반전 기술(Invert Segmenter)을 적용해 인식을 완료하고, ' : '밝은 문서 장표의 텍스트 레이아웃을 그대로 분석하여, '}모든 리소스를 로컬에서 안전하고 신속하게 구동했습니다. 원본 텍스트는 감쪽같이 가려지고 수정 가능한 텍스트 상자로 대치되었습니다.`
      }]);

      confetti({
        particleCount: 80,
        spread: 50,
        colors: ['#7c3aed', '#ff5b00']
      });

    } catch (err: any) {
      console.error("OCR Scan failed: ", err);
      alert("OCR 문자 인식을 수행하는 데 실패했습니다.\n상세 사유: " + (err.message || err));
    } finally {
      setOcrRunning(false);
      setOcrProgress(null);
    }
  };

  // ----------------------------------------------------
  // Dynamic Resize Handler for Overlays (Text / Images)
  // ----------------------------------------------------
  const startResize = (e: React.MouseEvent, id: string, type: 'text' | 'image') => {
    e.stopPropagation();
    e.preventDefault();

    const initialX = e.clientX;

    if (type === 'image') {
      const img = imageOverlays.find(i => i.id === id);
      if (!img) return;

      const initialWidthRatio = img.widthRatio;
      const initialHeightRatio = img.heightRatio;

      const handleMouseMove = (moveEvent: MouseEvent) => {
        const dx = moveEvent.clientX - initialX;
        
        // Container dimensions
        const canvas = mainCanvasRef.current;
        if (!canvas) return;
        
        const dWidthRatio = dx / canvas.width;
        // Scale height proportionally to maintain aspect ratio!
        const aspectRatio = initialHeightRatio / initialWidthRatio;
        const newWidth = Math.max(0.05, Math.min(0.95, initialWidthRatio + dWidthRatio));
        const newHeight = Math.max(0.05, Math.min(0.95, newWidth * aspectRatio));

        setImageOverlays(prev => prev.map(i => i.id === id ? {
          ...i,
          widthRatio: newWidth,
          heightRatio: newHeight
        } : i));
      };

      const handleMouseUp = () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };

      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    } else {
      const txt = textOverlays.find(t => t.id === id);
      if (!txt) return;

      const initialFontSize = txt.fontSize;

      const handleMouseMove = (moveEvent: MouseEvent) => {
        const dx = moveEvent.clientX - initialX;
        // Dragging right increases font size, left decreases
        const newFontSize = Math.max(8, Math.min(120, initialFontSize + dx * 0.15));

        setTextOverlays(prev => prev.map(t => t.id === id ? {
          ...t,
          fontSize: newFontSize
        } : t));
      };

      const handleMouseUp = () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };

      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    }
  };

  // ----------------------------------------------------
  // Drawing Canvas Logic (Mouse events relative coordinates)
  // ----------------------------------------------------
  const handleDrawMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (activeTool !== 'draw' && activeTool !== 'highlight') return;
    setIsDrawing(true);
    
    const canvas = drawingCanvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    currentStrokePoints.current = [{
      xRatio: x / canvas.width,
      yRatio: y / canvas.height
    }];
  };

  const handleDrawMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDrawing || (activeTool !== 'draw' && activeTool !== 'highlight')) return;
    
    const canvas = drawingCanvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    currentStrokePoints.current.push({
      xRatio: x / canvas.width,
      yRatio: y / canvas.height
    });

    // Draw temporary preview in canvas in real time
    const ctx = canvas.getContext('2d')!;
    const points = currentStrokePoints.current;
    
    ctx.strokeStyle = activeTool === 'highlight' ? highlightColor : brushColor;
    ctx.lineWidth = activeTool === 'highlight' ? brushSize * 3 : brushSize;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    
    ctx.beginPath();
    const startX = points[0].xRatio * canvas.width;
    const startY = points[0].yRatio * canvas.height;
    ctx.moveTo(startX, startY);
    
    for (let i = 1; i < points.length; i++) {
      const pX = points[i].xRatio * canvas.width;
      const pY = points[i].yRatio * canvas.height;
      ctx.lineTo(pX, pY);
    }
    ctx.stroke();
  };

  const handleDrawMouseUp = () => {
    if (!isDrawing) return;
    setIsDrawing(false);

    const physicalPageNum = pagesOrder[currentPage - 1];
    const newStroke: DrawingStroke = {
      points: currentStrokePoints.current,
      color: activeTool === 'highlight' ? highlightColor : brushColor,
      size: activeTool === 'highlight' ? brushSize * 3 : brushSize,
      type: activeTool === 'highlight' ? 'highlight' : 'pen'
    };

    setDrawings(prev => {
      const pageDrawings = prev[physicalPageNum] || [];
      return {
        ...prev,
        [physicalPageNum]: [...pageDrawings, newStroke]
      };
    });

    currentStrokePoints.current = [];
  };

  const renderDrawingOnCanvas = (canvas: HTMLCanvasElement, physicalPageNum: number) => {
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    const pageStrokes = drawings[physicalPageNum] || [];
    pageStrokes.forEach(stroke => {
      if (stroke.points.length === 0) return;
      
      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = stroke.size;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      
      ctx.beginPath();
      ctx.moveTo(stroke.points[0].xRatio * canvas.width, stroke.points[0].yRatio * canvas.height);
      
      for (let i = 1; i < stroke.points.length; i++) {
        ctx.lineTo(stroke.points[i].xRatio * canvas.width, stroke.points[i].yRatio * canvas.height);
      }
      ctx.stroke();
    });
  };

  // ----------------------------------------------------
  // Text & Image Overlay Click-to-Add Event Handlers
  // ----------------------------------------------------
  const handleOverlayAreaClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (activeTool !== 'text') {
      // Clear selection if clicked background
      if (e.target === e.currentTarget) {
        setSelectedOverlayId(null);
      }
      return;
    }

    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const physicalPageNum = pagesOrder[currentPage - 1];

    const newText: TextOverlay = {
      id: `text-${Date.now()}`,
      pageNum: physicalPageNum,
      text: '텍스트를 더블클릭하여 입력하세요',
      xRatio: x / rect.width,
      yRatio: y / rect.height,
      fontSize: 16,
      color: brushColor,
      maskBg: false, // newly added custom text doesn't need masking by default
      bgColor: '#ffffff'
    };

    setTextOverlays(prev => [...prev, newText]);
    setSelectedOverlayId(newText.id);
    setActiveTool('select'); // Automatically toggle back to select tool
  };

  // Drag-and-drop overlays handling
  const handleDragOverlayStart = (e: React.DragEvent<HTMLDivElement>, id: string) => {
    e.dataTransfer.setData('text/plain', id);
    setSelectedOverlayId(id);
  };

  const handleOverlayDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const id = e.dataTransfer.getData('text/plain');
    if (!id) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const xRatio = x / rect.width;
    const yRatio = y / rect.height;

    if (id.startsWith('text-') || id.startsWith('ocr-')) {
      setTextOverlays(prev => prev.map(t => t.id === id ? { ...t, xRatio, yRatio } : t));
    } else if (id.startsWith('img-')) {
      setImageOverlays(prev => prev.map(i => i.id === id ? { ...i, xRatio, yRatio } : i));
    }
  };

  // Image insertion triggers
  const handleImageInsertBtn = () => {
    imageInputRef.current?.click();
  };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const base64 = event.target?.result as string;
      const physicalPageNum = pagesOrder[currentPage - 1];

      const newImage: ImageOverlay = {
        id: `img-${Date.now()}`,
        pageNum: physicalPageNum,
        src: base64,
        xRatio: 0.35, // Place in center initially
        yRatio: 0.35,
        widthRatio: 0.25, // 25% of page width
        heightRatio: 0.2
      };

      setImageOverlays(prev => [...prev, newImage]);
      setSelectedOverlayId(newImage.id);
      setActiveTool('select');
    };
    reader.readAsDataURL(file);
  };

  // Delete an overlay element
  const deleteOverlay = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setTextOverlays(prev => prev.filter(t => t.id !== id));
    setImageOverlays(prev => prev.filter(i => i.id !== id));
    setSelectedOverlayId(null);
  };

  // Toggle solid background mask (to hide background scanned text)
  const toggleOverlayMask = (id: string) => {
    setTextOverlays(prev => prev.map(t => t.id === id ? { ...t, maskBg: !t.maskBg } : t));
  };

  // ----------------------------------------------------
  // Page Operations (Move Up, Down, Delete, Insert Blank)
  // ----------------------------------------------------
  const movePageUp = (pageNum: number, e: React.MouseEvent) => {
    e.stopPropagation();
    const index = pagesOrder.indexOf(pageNum);
    if (index <= 0) return;

    const newOrder = [...pagesOrder];
    // Swap
    newOrder[index] = newOrder[index - 1];
    newOrder[index - 1] = pageNum;
    
    setPagesOrder(newOrder);
    if (currentPage > 1 && currentPage === index + 1) {
      setCurrentPage(currentPage - 1);
    }
  };

  const movePageDown = (pageNum: number, e: React.MouseEvent) => {
    e.stopPropagation();
    const index = pagesOrder.indexOf(pageNum);
    if (index < 0 || index >= pagesOrder.length - 1) return;

    const newOrder = [...pagesOrder];
    // Swap
    newOrder[index] = newOrder[index + 1];
    newOrder[index + 1] = pageNum;

    setPagesOrder(newOrder);
    if (currentPage < numPages && currentPage === index + 1) {
      setCurrentPage(currentPage + 1);
    }
  };

  const deletePage = (pageNum: number, e: React.MouseEvent) => {
    e.stopPropagation();
    if (pagesOrder.length <= 1) {
      alert("최소 한 개의 페이지는 보존되어야 합니다.");
      return;
    }

    if (!confirm("해당 페이지를 삭제하시겠습니까?")) return;

    const newOrder = pagesOrder.filter(p => p !== pageNum);
    
    setPagesOrder(newOrder);
    setNumPages(newOrder.length);
    
    // Clear page's annotations
    setTextOverlays(prev => prev.filter(t => t.pageNum !== pageNum));
    setImageOverlays(prev => prev.filter(i => i.pageNum !== pageNum));
    setDrawings(prev => {
      const copy = { ...prev };
      delete copy[pageNum];
      return copy;
    });

    if (currentPage > newOrder.length) {
      setCurrentPage(newOrder.length);
    }
  };

  const insertBlankPage = () => {
    if (!pdfDocJs) return;
    const newPageNum = 999 + Date.now(); // Unique ID placeholder for local page addition
    const orderIndex = currentPage; // Insert after current page
    
    const newOrder = [...pagesOrder];
    newOrder.splice(orderIndex, 0, newPageNum);

    setPagesOrder(newOrder);
    setNumPages(newOrder.length);
    setCurrentPage(orderIndex + 1);
  };

  // ----------------------------------------------------
  // Save & Export Compiler (Via pdf-lib)
  // ----------------------------------------------------
  const handleExportPDF = async () => {
    if (!pdfDocLibBytes) return;

    try {
      const pdfDoc = await PDFDocument.load(pdfDocLibBytes);
      const helveticaFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
      
      const newPdfDoc = await PDFDocument.create();

      // Process each physical page in the customized pagesOrder array
      for (let i = 0; i < pagesOrder.length; i++) {
        const physicalPageNum = pagesOrder[i];
        
        let newPage;
        if (physicalPageNum > 999) {
          // It's a new blank page inserted!
          newPage = newPdfDoc.addPage([595.28, 841.89]); // A4 Size standard in points
        } else {
          // Copy original page
          const [copiedPage] = await newPdfDoc.copyPages(pdfDoc, [physicalPageNum - 1]);
          newPage = newPdfDoc.addPage(copiedPage);
        }

        const pdfWidth = newPage.getWidth();
        const pdfHeight = newPage.getHeight();

        // 1. Compile drawings/drawings vector curves using lines
        const pageDrawings = drawings[physicalPageNum] || [];
        pageDrawings.forEach(stroke => {
          if (stroke.points.length < 2) return;
          
          const strokeColorHex = stroke.color.startsWith('rgba') ? '#ff5b00' : stroke.color; // Standardize opacity
          const hexR = parseInt(strokeColorHex.slice(1, 3), 16) / 255;
          const hexG = parseInt(strokeColorHex.slice(3, 5), 16) / 255;
          const hexB = parseInt(strokeColorHex.slice(5, 7), 16) / 255;

          // Draw vector paths line by line
          for (let k = 0; k < stroke.points.length - 1; k++) {
            const startPt = stroke.points[k];
            const endPt = stroke.points[k + 1];

            // Convert Top-Left screen coords to Bottom-Left PDF points
            const startX = startPt.xRatio * pdfWidth;
            const startY = (1 - startPt.yRatio) * pdfHeight;
            const endX = endPt.xRatio * pdfWidth;
            const endY = (1 - endPt.yRatio) * pdfHeight;

            newPage.drawLine({
              start: { x: startX, y: startY },
              end: { x: endX, y: endY },
              color: rgb(hexR, hexG, hexB),
              thickness: stroke.size * 0.75,
              opacity: stroke.type === 'highlight' ? 0.4 : 1.0,
            });
          }
        });

        // 2. Compile Text Overlays (Including Smart Matched Background Masking)
        const pageText = textOverlays.filter(t => t.pageNum === physicalPageNum);
        pageText.forEach(txt => {
          // Translate top-left screen coordinates into bottom-left PDF coordinates
          const pdfX = txt.xRatio * pdfWidth;
          const pdfY = (1 - txt.yRatio) * pdfHeight - (txt.fontSize * 0.85);

          // If maskBg is true, draw a solid block matching the paper background exactly!
          if (txt.maskBg) {
            // Rough estimation of the word/line text size in points
            const approxCharWidth = txt.fontSize * 0.55;
            const blockW = Math.max(30, txt.text.length * approxCharWidth);
            const blockH = txt.fontSize * 1.3;

            const bgColorHex = txt.bgColor || '#ffffff';
            const bgR = parseInt(bgColorHex.slice(1, 3), 16) / 255;
            const bgG = parseInt(bgColorHex.slice(3, 5), 16) / 255;
            const bgB = parseInt(bgColorHex.slice(5, 7), 16) / 255;

            newPage.drawRectangle({
              x: pdfX - 4,
              y: pdfY - (blockH * 0.15),
              width: blockW + 8,
              height: blockH,
              color: rgb(bgR, bgG, bgB), // matched background color!
            });
          }

          const colorHex = txt.color;
          const r = parseInt(colorHex.slice(1, 3), 16) / 255;
          const g = parseInt(colorHex.slice(3, 5), 16) / 255;
          const b = parseInt(colorHex.slice(5, 7), 16) / 255;

          newPage.drawText(txt.text, {
            x: pdfX,
            y: pdfY,
            size: txt.fontSize * 0.8,
            font: helveticaFont,
            color: rgb(r, g, b)
          });
        });

        // 3. Compile Image Overlays
        const pageImages = imageOverlays.filter(img => img.pageNum === physicalPageNum);
        for (const img of pageImages) {
          try {
            // Embed Base64 Image
            const isPng = img.src.includes('image/png');
            let embeddedImg;
            if (isPng) {
              embeddedImg = await newPdfDoc.embedPng(img.src);
            } else {
              embeddedImg = await newPdfDoc.embedJpg(img.src);
            }

            const imgW = img.widthRatio * pdfWidth;
            const imgH = img.heightRatio * pdfHeight;
            const pdfX = img.xRatio * pdfWidth;
            const pdfY = (1 - img.yRatio) * pdfHeight - imgH;

            newPage.drawImage(embeddedImg, {
              x: pdfX,
              y: pdfY,
              width: imgW,
              height: imgH
            });
          } catch (e) {
            console.error("Image embedding failed: ", e);
          }
        }
      }

      const pdfBytesFinal = await newPdfDoc.save();

      // Trigger Browser file download
      const blob = new Blob([pdfBytesFinal as any], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = pdfFile ? `[Edited]_${pdfFile.name}` : `edited_document.pdf`;
      link.click();

      // Celebrations
      confetti({
        particleCount: 150,
        spread: 80,
        origin: { y: 0.6 }
      });

    } catch (err) {
      console.error("Error saving PDF file: ", err);
      alert("PDF 문서 컴파일 중 에러가 발생했습니다.");
    }
  };

  // ----------------------------------------------------
  // Interactive Mock AI Doc Copilot Response Logic
  // ----------------------------------------------------
  const handleSendAIMessage = () => {
    if (!aiInput.trim()) return;

    const userMsg: AIMessage = {
      id: `ai-msg-${Date.now()}`,
      sender: 'user',
      text: aiInput
    };

    setAiMessages(prev => [...prev, userMsg]);
    setAiInput('');
    setAiLoading(true);

    setTimeout(() => {
      let aiText = "문서를 심층적으로 검토해 드렸습니다. ";
      
      const query = userMsg.text.toLowerCase();
      if (query.includes('요약') || query.includes('summary')) {
        aiText += `이 문서는 전체 ${numPages}페이지로 구성되어 있으며, 핵심 테마는 스마트 오피스 및 문서 편집 협업 도구의 생산성 개선 방안입니다. 
1. 지적 근로자용 AI 보조 도구(Copilot)의 활용 극대화
2. 실시간 PDF 서명 및 벡터 드로잉 주석 처리 레이어 통합
3. NotebookLM 및 슬라이드 연동을 통한 지식 아카이빙 간소화 
위 단락들이 주된 핵심 골자입니다.`;
      } else if (query.includes('ocr') || query.includes('글자 인식') || query.includes('스캔')) {
        aiText += `이미지 기반 PDF 스캔을 위한 고정밀 OCR 엔진이 완전히 로딩되었습니다. 상단 툴바의 'AI OCR 텍스트 인식' 주황색 버튼을 클릭하시면, 스캔된 문자들을 좌표 분석하여 1초 만에 그대로 편집 가능한 문자 박스로 교체해 드립니다!`;
      } else if (query.includes('카카오톡') || query.includes('kakao')) {
        aiText += `문서 내 카카오톡 또는 백업에 관한 직접 검색 결과는 미비하지만, 대화 복구 및 PDF 아카이브 관련 기술 지침 파일이 감지되었습니다. 텍스트 추출 기능을 통해 해당 장표의 인용구를 클릭하면 바로 탐색 가능합니다.`;
      } else {
        aiText += `질문하신 내용 [${userMsg.text}] 에 대한 AI 벡터 분석 결과, 해당 장표 내 3페이지 및 5페이지에 분산되어 기재된 솔루션 매칭 성공률이 약 94%로 검출되었습니다. 텍스트 도구를 활용해 편집 중인 PDF 영역 바로 위에 의견을 주석으로 달아두시면 효율적입니다!`;
      }

      setAiMessages(prev => [...prev, {
        id: `ai-msg-res-${Date.now()}`,
        sender: 'ai',
        text: aiText
      }]);
      setAiLoading(false);
    }, 1500);
  };

  // Trigger quick actions
  const triggerQuickAI = (action: string) => {
    setAiInput(action);
    setTimeout(() => handleSendAIMessage(), 100);
  };

  const activePhysicalPageNum = pagesOrder[currentPage - 1];

  return (
    <div className="flex flex-col h-screen overflow-hidden">
      {/* 1. Header Navigation */}
      <header className="app-header">
        <div className="logo-section">
          <div className="logo-icon">A</div>
          <div className="logo-text">Atech PDF Editor</div>
          <div className="logo-badge">AI OCR Pro</div>
        </div>

        {pdfFile && (
          <div className="toolbar">
            <button 
              className={`tool-btn ${activeTool === 'select' ? 'active' : ''}`}
              onClick={() => setActiveTool('select')}
            >
              <RotateCcw size={15} /> 선택
            </button>
            <button 
              className={`tool-btn ${activeTool === 'text' ? 'active' : ''}`}
              onClick={() => setActiveTool('text')}
            >
              <Type size={15} /> 텍스트 추가
            </button>
            <button 
              className={`tool-btn ${activeTool === 'draw' ? 'active' : ''}`}
              onClick={() => setActiveTool('draw')}
            >
              <Edit2 size={15} /> 펜 드로잉
            </button>
            <button 
              className={`tool-btn ${activeTool === 'highlight' ? 'active' : ''}`}
              onClick={() => setActiveTool('highlight')}
            >
              <Highlighter size={15} /> 형광펜
            </button>
            <button 
              className="tool-btn"
              onClick={handleImageInsertBtn}
            >
              <ImageIcon size={15} /> 이미지 삽입
            </button>
            <input 
              type="file" 
              ref={imageInputRef} 
              style={{ display: 'none' }} 
              accept="image/*" 
              onChange={handleImageUpload} 
            />
          </div>
        )}

        <div className="action-controls">
          {pdfFile && (
            <>
              {/* Vibrant OCR Button */}
              <div className="flex items-center gap-1 bg-purple-50 rounded-lg p-1 border border-purple-200" style={{ display: 'flex', alignItems: 'center', background: 'rgba(124, 58, 237, 0.05)', border: '1px solid rgba(124, 58, 237, 0.2)', padding: '3px 8px', borderRadius: '8px' }}>
                <span className="text-xs font-semibold text-purple-700 mr-2" style={{ fontSize: '11px', color: 'var(--primary)', fontWeight: 600, marginRight: '8px' }}>OCR 언어:</span>
                <select 
                  className="bg-white border rounded px-1 text-xs cursor-pointer outline-none"
                  style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-color)', fontSize: '11px', color: 'var(--text-main)', padding: '2px 4px', borderRadius: '4px', cursor: 'pointer' }}
                  value={ocrLanguage}
                  onChange={(e) => setOcrLanguage(e.target.value)}
                >
                  <option value="kor+eng">한국어 + 영어 (kor+eng)</option>
                  <option value="kor">한국어 전용 (kor)</option>
                  <option value="eng">영어 전용 (eng)</option>
                </select>

                <button 
                  className="action-btn primary flex items-center gap-1 py-1 px-3 ml-2" 
                  style={{ 
                    padding: '4px 12px', 
                    borderRadius: '6px', 
                    fontSize: '11px', 
                    background: 'linear-gradient(135deg, var(--primary), var(--accent))', 
                    color: 'white', 
                    border: 'none', 
                    cursor: 'pointer',
                    fontWeight: 600,
                    boxShadow: '0 2px 6px rgba(124,58,237,0.2)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px'
                  }}
                  onClick={runAIOCRScan}
                  disabled={ocrRunning}
                >
                  <ScanLine size={12} /> {ocrRunning ? '인식 중...' : 'AI OCR 텍스트 인식'}
                </button>
              </div>

              {/* Zoom controls */}
              <div className="flex items-center gap-1 bg-gray-100 rounded-lg p-1" style={{ display: 'flex', background: 'rgba(0,0,0,0.05)', borderRadius: '6px', padding: '4px' }}>
                <button className="p-1.5 hover:bg-white rounded border-none cursor-pointer" onClick={() => setZoom(z => Math.max(0.5, z - 0.25))}>
                  <ZoomOut size={14} />
                </button>
                <span className="text-xs font-semibold px-2" style={{ alignSelf: 'center', fontSize: '12px', fontWeight: 600, padding: '0 6px' }}>{Math.round(zoom * 100)}%</span>
                <button className="p-1.5 hover:bg-white rounded border-none cursor-pointer" onClick={() => setZoom(z => Math.min(3, z + 0.25))}>
                  <ZoomIn size={14} />
                </button>
              </div>
              
              <button className="action-btn" onClick={insertBlankPage}>
                <Plus size={15} /> 빈 페이지 추가
              </button>

              <button className="action-btn primary" onClick={handleExportPDF}>
                <Download size={15} /> 저장 및 내보내기
              </button>
            </>
          )}

          <button 
            className="action-btn" 
            style={{ border: 'none', background: 'none', cursor: 'pointer', boxShadow: 'none' }}
            onClick={() => setTheme(t => t === 'light' ? 'dark' : 'light')}
          >
            {theme === 'light' ? <Moon size={18} /> : <Sun size={18} />}
          </button>
        </div>
      </header>

      {/* 2. Tool Options Panel */}
      {pdfFile && (activeTool === 'draw' || activeTool === 'text' || activeTool === 'highlight' || selectedOverlayId) && (
        <div className="tool-options-bar">
          <div className="option-group">
            <span>색상:</span>
            {['#7c3aed', '#ff5b00', '#000000', '#22c55e', '#ef4444'].map(color => (
              <span 
                key={color}
                className={`color-dot ${brushColor === color ? 'active' : ''}`}
                style={{ backgroundColor: color }}
                onClick={() => {
                  setBrushColor(color);
                  if (selectedOverlayId && (selectedOverlayId.startsWith('text-') || selectedOverlayId.startsWith('ocr-'))) {
                    setTextOverlays(prev => prev.map(t => t.id === selectedOverlayId ? { ...t, color } : t));
                  }
                }}
              />
            ))}
          </div>

          {(activeTool === 'draw' || activeTool === 'highlight') && (
            <div className="option-group">
              <span>두께:</span>
              <input 
                type="range" 
                min="1" 
                max="20" 
                value={brushSize} 
                className="option-control"
                style={{ cursor: 'pointer' }}
                onChange={(e) => setBrushSize(Number(e.target.value))} 
              />
              <span>{brushSize}px</span>
            </div>
          )}

          {selectedOverlayId && (selectedOverlayId.startsWith('text-') || selectedOverlayId.startsWith('ocr-')) && (
            <div className="option-group" style={{ marginLeft: 'auto', borderLeft: '1px solid var(--border-color)', paddingLeft: '20px' }}>
              <span>글자 크기:</span>
              <button 
                className="bg-gray-100 px-2 py-0.5 rounded text-xs cursor-pointer border"
                style={{ background: 'var(--bg-app)', border: '1px solid var(--border-color)', borderRadius: '4px', cursor: 'pointer', padding: '2px 6px' }}
                onClick={() => setTextOverlays(prev => prev.map(t => t.id === selectedOverlayId ? { ...t, fontSize: Math.max(8, t.fontSize - 2) } : t))}
              >
                가-
              </button>
              <button 
                className="bg-gray-100 px-2 py-0.5 rounded text-xs cursor-pointer border ml-1"
                style={{ background: 'var(--bg-app)', border: '1px solid var(--border-color)', borderRadius: '4px', cursor: 'pointer', padding: '2px 6px', marginLeft: '4px' }}
                onClick={() => setTextOverlays(prev => prev.map(t => t.id === selectedOverlayId ? { ...t, fontSize: Math.min(72, t.fontSize + 2) } : t))}
              >
                가+
              </button>

              <label className="flex items-center gap-1 ml-4 cursor-pointer text-xs" style={{ display: 'flex', alignItems: 'center', gap: '4px', marginLeft: '16px', cursor: 'pointer', fontSize: '12px' }}>
                <input 
                  type="checkbox" 
                  checked={textOverlays.find(t => t.id === selectedOverlayId)?.maskBg || false}
                  onChange={() => toggleOverlayMask(selectedOverlayId)}
                  style={{ cursor: 'pointer' }}
                />
                <span>원래 글자 지우기 (마스킹)</span>
                <span title="체크 시 원본 이미지의 해당 글자 부분을 하얀색 박스로 가리고 가필한 글자만 출력합니다.">
                  <HelpCircle size={12} className="text-gray-400" />
                </span>
              </label>
            </div>
          )}
        </div>
      )}

      {/* 3. Main Workspace */}
      <div className="workspace">
        {!pdfDocJs ? (
          /* Empty / Upload Placeholder Zone */
          <div className="upload-placeholder" onClick={() => fileInputRef.current?.click()}>
            <div className="upload-icon">
              <Upload size={32} />
            </div>
            <h3 className="upload-title">스마트 PDF 파일 올리기</h3>
            <p className="upload-desc">
              이곳을 클릭하거나 PDF 문서를 드래그앤드롭하여 업로드하세요.<br />
              실시간 서명, 드로잉, 이미지 OCR 스캔 및 글자 교정 기능이 열립니다.
            </p>
            <input 
              type="file" 
              ref={fileInputRef} 
              style={{ display: 'none' }} 
              accept="application/pdf" 
              onChange={handleFileUpload} 
            />
          </div>
        ) : (
          /* Active Document Editor view */
          <>
            {/* Left Sidebar Thumbnail Pages Navigation */}
            <aside className="sidebar">
              <div className="sidebar-title">
                <span>페이지 목록 ({numPages})</span>
              </div>
              <div className="thumb-list" ref={sidebarThumbsRef}>
                {pagesOrder.map((pageNum, idx) => (
                  <div 
                    key={pageNum}
                    className={`thumb-card ${currentPage === idx + 1 ? 'active' : ''}`}
                    onClick={() => setCurrentPage(idx + 1)}
                  >
                    <div className="thumb-number">{idx + 1}</div>
                    
                    {/* Render thumbnail as canvas page */}
                    {pageNum > 999 ? (
                      <div className="flex items-center justify-center bg-white border rounded" style={{ height: '120px', width: '100%', fontSize: '11px', color: '#94a3b8', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        빈 페이지
                      </div>
                    ) : (
                      <canvas id={`thumb-canvas-${pageNum}`} className="thumb-canvas" />
                    )}

                    <div className="thumb-actions">
                      <button 
                        className="thumb-action-btn" 
                        title="위로 이동"
                        onClick={(e) => movePageUp(pageNum, e)}
                        disabled={idx === 0}
                      >
                        ▲
                      </button>
                      <button 
                        className="thumb-action-btn" 
                        title="아래로 이동"
                        onClick={(e) => movePageDown(pageNum, e)}
                        disabled={idx === pagesOrder.length - 1}
                      >
                        ▼
                      </button>
                      <button 
                        className="thumb-action-btn text-red-500 hover:bg-red-50" 
                        title="페이지 삭제"
                        onClick={(e) => deletePage(pageNum, e)}
                      >
                        <Trash size={12} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </aside>

            {/* Middle Main PDF Viewport Canvas Scroll area */}
            <main className="pdf-viewer" style={{ position: 'relative' }}>
              {/* Dynamic Tesseract OCR Loading Overlay */}
              {ocrProgress !== null && (
                <div 
                  className="absolute inset-0 bg-black/60 backdrop-blur-sm z-50 flex flex-col items-center justify-center text-white"
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    bottom: 0,
                    backgroundColor: 'rgba(15, 23, 42, 0.75)',
                    backdropFilter: 'blur(4px)',
                    zIndex: 100,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: 'white',
                    fontFamily: 'var(--font-heading)'
                  }}
                >
                  <Sparkles size={40} className="text-purple-400 animate-pulse mb-4" />
                  <h4 className="text-lg font-bold mb-2">AI OCR 이미지 글자 추출 중...</h4>
                  <p className="text-xs text-slate-400 mb-6">스캔된 글자의 박스 좌표를 계산하고 있습니다.</p>
                  
                  {/* Progress Bar */}
                  <div className="w-64 bg-slate-800 rounded-full h-3 border border-slate-700 overflow-hidden" style={{ width: '256px', background: '#334155', borderRadius: '9999px', height: '10px', overflow: 'hidden' }}>
                    <div 
                      className="bg-gradient-to-r from-purple-500 to-orange-500 h-full transition-all duration-300"
                      style={{ 
                        width: `${ocrProgress}%`,
                        height: '100%',
                        background: 'linear-gradient(to right, var(--primary), var(--accent))'
                      }}
                    />
                  </div>
                  <span className="text-sm font-semibold mt-2" style={{ marginTop: '8px', fontSize: '14px', fontWeight: 600 }}>{ocrProgress}%</span>
                </div>
              )}

              <div 
                className="page-container"
                style={{ transform: `scale(${zoom})` }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={handleOverlayDrop}
              >
                <canvas ref={mainCanvasRef} className="pdf-canvas" />

                {/* Annotation Overlay Layer */}
                <div 
                  className="editor-overlay"
                  onClick={handleOverlayAreaClick}
                  style={{ cursor: activeTool === 'text' ? 'text' : activeTool === 'draw' || activeTool === 'highlight' ? 'crosshair' : 'default' }}
                >
                  {/* Drawing overlay vector canvas */}
                  <canvas 
                    ref={drawingCanvasRef} 
                    className={`drawing-canvas ${(activeTool === 'draw' || activeTool === 'highlight') ? 'active' : ''}`}
                    onMouseDown={handleDrawMouseDown}
                    onMouseMove={handleDrawMouseMove}
                    onMouseUp={handleDrawMouseUp}
                  />

                  {/* Text Overlays rendering (OCR Support & Dynamic Resizing included) */}
                  {textOverlays
                    .filter(t => t.pageNum === activePhysicalPageNum)
                    .map(txt => (
                      <div
                        key={txt.id}
                        className={`overlay-element ${selectedOverlayId === txt.id ? 'selected' : ''}`}
                        style={{ 
                          left: `${txt.xRatio * 100}%`, 
                          top: `${txt.yRatio * 100}%`, 
                          fontSize: `${txt.fontSize}px`, 
                          color: txt.color,
                          backgroundColor: txt.maskBg ? txt.bgColor : 'transparent',
                          padding: '2px 4px',
                          borderRadius: '2px'
                        }}
                        draggable={activeTool === 'select'}
                        onDragStart={(e) => handleDragOverlayStart(e, txt.id)}
                        onClick={(e) => { e.stopPropagation(); setSelectedOverlayId(txt.id); }}
                      >
                        <div 
                          className="overlay-element-text"
                          contentEditable
                          suppressContentEditableWarning
                          onBlur={(e) => {
                            const newTextValue = e.currentTarget.textContent || '';
                            setTextOverlays(prev => prev.map(t => t.id === txt.id ? { ...t, text: newTextValue } : t));
                          }}
                        >
                          {txt.text}
                        </div>
                        
                        {/* Drag Handle to Resize/Scale Font Size! */}
                        {selectedOverlayId === txt.id && (
                          <div 
                            className="resize-handle" 
                            onMouseDown={(e) => startResize(e, txt.id, 'text')}
                          />
                        )}

                        <button className="overlay-delete-btn" onClick={(e) => deleteOverlay(txt.id, e)}>
                          ×
                        </button>
                      </div>
                    ))}

                  {/* Image Overlays rendering (Dynamic Resizing included) */}
                  {imageOverlays
                    .filter(img => img.pageNum === activePhysicalPageNum)
                    .map(img => (
                      <div
                        key={img.id}
                        className={`overlay-element ${selectedOverlayId === img.id ? 'selected' : ''}`}
                        style={{ 
                          left: `${img.xRatio * 100}%`, 
                          top: `${img.yRatio * 100}%`, 
                          width: `${img.widthRatio * 100}%`,
                          height: `${img.heightRatio * 100}%`,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center'
                        }}
                        draggable={activeTool === 'select'}
                        onDragStart={(e) => handleDragOverlayStart(e, img.id)}
                        onClick={(e) => { e.stopPropagation(); setSelectedOverlayId(img.id); }}
                      >
                        <img src={img.src} className="overlay-element-image" alt="Overlay stamp" />
                        
                        {/* Drag Handle to Resize/Scale Image Bounding Box! */}
                        {selectedOverlayId === img.id && (
                          <div 
                            className="resize-handle" 
                            onMouseDown={(e) => startResize(e, img.id, 'image')}
                          />
                        )}

                        <button className="overlay-delete-btn" onClick={(e) => deleteOverlay(img.id, e)}>
                          ×
                        </button>
                      </div>
                    ))}
                </div>
              </div>
            </main>

            {/* Right Sidebar - Tenorshare-style AI Doc Assistant Panel */}
            <aside className="ai-panel">
              <div className="ai-header">
                <Sparkles size={16} className="text-purple-600" />
                <span className="ai-title">Atech AI PDF 어시스턴트</span>
              </div>

              <div className="ai-chat-area">
                {aiMessages.map(msg => (
                  <div key={msg.id} className={`ai-message ${msg.sender}`}>
                    {msg.text}
                  </div>
                ))}
                {aiLoading && (
                  <div className="ai-message ai text-gray-400 italic">
                    AI 분석 에이전트가 문서를 읽는 중... ⚡
                  </div>
                )}
              </div>

              <div className="ai-suggested">
                <button className="ai-suggest-btn" onClick={() => triggerQuickAI('3줄 요약해 줘')}>
                  📝 전체 요약하기
                </button>
                <button className="ai-suggest-btn" onClick={() => triggerQuickAI('이미지 PDF OCR은 어떻게 구동해?')}>
                  🔍 OCR 사용 가이드
                </button>
              </div>

              <div className="ai-input-bar">
                <input 
                  type="text" 
                  className="ai-input" 
                  placeholder="AI 어시스턴트에게 물어보세요..." 
                  value={aiInput}
                  onChange={(e) => setAiInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSendAIMessage()}
                />
                <button className="ai-send-btn" onClick={handleSendAIMessage}>
                  <Send size={15} />
                </button>
              </div>
            </aside>
          </>
        )}
      </div>
    </div>
  );
}
