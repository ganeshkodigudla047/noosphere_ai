# High-Detail Vision OCR Pipeline

This document describes the complete pipeline for processing handwritten notebook pages with OpenAI's GPT-4o Vision API.

## Pipeline Overview

The Noosphere AI OCR system uses a three-stage approach:

1. **High-DPI PDF Rasterization** (300 DPI minimum)
2. **OpenCV Preprocessing** (line removal + stroke repair)
3. **High-Detail Vision API Transcription** (GPT-4o with `detail: "original"`)

---

## Stage 1: PDF Rasterization

**Location:** `apps/api/app/ocr.py` → `rasterize_page()`

```python
def rasterize_page(page: fitz.Page, dpi: int = 300) -> np.ndarray:
    pixmap = page.get_pixmap(dpi=dpi, alpha=False)
    # Returns RGB numpy array at 300 DPI
```

**Why 300 DPI?**
- Preserves fine details of cursive handwriting loops
- Prevents character merging that occurs at lower resolutions
- OpenAI's Vision API can handle the larger image sizes without auto-downsampling when `detail: "original"` is set

---

## Stage 2: OpenCV Preprocessing

**Location:** `apps/api/app/ocr.py` → `preprocess_page_image()`

This function removes horizontal notebook ruling lines while preserving handwritten text:

```python
def preprocess_page_image(rgb_image: np.ndarray) -> np.ndarray:
    # 1. Convert to grayscale and apply median blur to reduce noise
    gray = cv2.cvtColor(rgb_image, cv2.COLOR_RGB2GRAY)
    blurred = cv2.medianBlur(gray, 3)

    # 2. Adaptive thresholding (handles shadows and gradients)
    thresh = cv2.adaptiveThreshold(
        blurred, 255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY_INV,
        25, 9
    )

    # 3. Isolate and remove horizontal ruling lines
    horizontal_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (35, 1))
    detected_lines = cv2.morphologyEx(thresh, cv2.MORPH_OPEN, horizontal_kernel, iterations=2)
    cleaned_binary = cv2.subtract(thresh, detected_lines)

    # 4. Repair broken character strokes (vertical morphological closing)
    repair_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (1, 6))
    repaired_binary = cv2.morphologyEx(cleaned_binary, cv2.MORPH_CLOSE, repair_kernel)

    # 5. Invert back to standard black-on-white
    return cv2.bitwise_not(repaired_binary)
```

**Key Parameters:**
- `(35, 1)` horizontal kernel: Wide enough to catch ruling lines, narrow enough to preserve text
- `(1, 6)` vertical kernel: Repairs broken vertical strokes in cursive handwriting
- Adaptive thresholding with `blockSize=25`: Handles uneven lighting across the page

---

## Stage 3: High-Detail Vision API Transcription

**Location:** `apps/api/app/ocr.py` → `_transcribe_image()`

### Critical Configuration

```python
{
    "type": "image_url",
    "image_url": {
        "url": f"data:image/png;base64,{image_base64}",
        "detail": "original",  # CRITICAL: Prevents auto-resizing to 512px
    },
}
```

**Why `"detail": "original"`?**
- By default, OpenAI Vision API resizes images to 512px for cost optimization
- This destroys fine handwriting details needed for cursive text
- `"original"` preserves the full 300 DPI resolution
- Also valid: `"detail": "high"` (uses 768px tiles instead of 512px)

### Model Settings

```python
response = client.chat.completions.create(
    model="gpt-4o",           # Best vision + text model
    temperature=0.0,           # Deterministic, character-perfect extraction
    messages=[...]
)
```

**Temperature = 0.0:** Ensures consistent, literal transcription without creative interpretation

---

## Stage 4: Server-Sent Events (SSE) Streaming

**Location:** `apps/api/app/main.py` → `page_chat_stream_endpoint()`

### The Problem
Uvicorn and browsers can buffer SSE chunks, causing the UI to freeze until a threshold is reached.

### The Solution
Each token must be wrapped in a valid SSE frame with **double newlines** (`\n\n`):

```python
def _sse_event(token: str) -> str:
    """Wrap a content token in a valid SSE frame.
    
    SSE spec: each message ends with a blank line (two newlines).
    Multi-line tokens get one `data:` prefix per line.
    """
    lines = token.splitlines() or [""]
    return "".join(f"data: {line}\n" for line in lines) + "\n"
```

### Full Streaming Handler

```python
@app.post("/chat/page/stream")
async def page_chat_stream_endpoint(request: PageChatRequest, http_request: Request):
    async def event_stream():
        try:
            async for token in stream_page_answer(request):
                if await http_request.is_disconnected():
                    break
                # Emit each token immediately — no buffering
                yield _sse_event(token)
                await asyncio.sleep(0)  # Yield control to event loop
            yield "data: [DONE]\n\n"
        except Exception as exc:
            yield f"event: error\ndata: {str(exc)}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "X-Accel-Buffering": "no",  # Disable Nginx buffering
            "Cache-Control": "no-cache",
        },
    )
```

**Key Details:**
- `X-Accel-Buffering: no`: Prevents Nginx reverse proxies from buffering
- `await asyncio.sleep(0)`: Forces the event loop to yield and flush
- Each token gets its own SSE frame with `\n\n` terminator

---

## Configuration Constants

**Location:** `apps/api/app/ocr.py` (top of file)

```python
OCR_MODEL = "gpt-4o"          # Best vision + language model
OCR_DPI = 300                 # High-resolution rasterization
OCR_TEMPERATURE = 0.0         # Deterministic transcription
OCR_MAX_RETRIES = 4           # Retry logic for rate limits
```

---

## Testing the Pipeline

### 1. Test OCR Endpoint

```bash
curl -X POST "http://localhost:8000/ocr/pdf" \
  -F "file=@notebook.pdf" \
  -F "page_numbers=1-3" \
  -F "save_preprocessed_images=true"
```

This will:
- Rasterize pages 1-3 at 300 DPI
- Apply OpenCV preprocessing
- Save preprocessed images to `ocr-preprocessed/`
- Return transcribed Markdown for each page

### 2. Test Chat Streaming

```bash
curl -X POST "http://localhost:8000/chat/page/stream" \
  -H "Content-Type: application/json" \
  -d '{
    "document_id": "test-doc",
    "node_id": "test-node",
    "topic": "Chemistry Notes",
    "summary": "Organic chemistry reactions",
    "content": "...",
    "question": "What is the mechanism?"
  }'
```

You should see tokens stream immediately with no buffering.

---

## Dependencies

All required packages are already in `requirements.txt`:

```
opencv-python-headless==4.10.0.84  # Image preprocessing
PyMuPDF==1.25.1                     # PDF rasterization
openai==1.59.7                       # Vision API client
fastapi==0.115.6                    # SSE streaming
uvicorn[standard]==0.34.0           # ASGI server
```

---

## Architecture Diagram

```
┌─────────────────┐
│   PDF Upload    │
└────────┬────────┘
         │
         ▼
┌─────────────────────────┐
│  PyMuPDF (300 DPI)      │
│  page.get_pixmap()      │
└────────┬────────────────┘
         │
         ▼
┌─────────────────────────┐
│  OpenCV Preprocessing   │
│  • Median blur          │
│  • Adaptive threshold   │
│  • Horizontal line      │
│    extraction (35×1)    │
│  • Vertical repair (1×6)│
└────────┬────────────────┘
         │
         ▼
┌─────────────────────────┐
│  Base64 PNG Encoding    │
└────────┬────────────────┘
         │
         ▼
┌─────────────────────────┐
│  OpenAI GPT-4o Vision   │
│  • detail: "original"   │
│  • temperature: 0.0     │
└────────┬────────────────┘
         │
         ▼
┌─────────────────────────┐
│  Markdown Output        │
│  (or streaming tokens)  │
└─────────────────────────┘
```

---

## Summary

✅ **300 DPI rasterization** preserves handwriting detail  
✅ **OpenCV preprocessing** removes notebook lines while repairing character strokes  
✅ **`detail: "original"`** prevents Vision API from downsampling  
✅ **`temperature: 0.0`** ensures deterministic, literal transcription  
✅ **Proper SSE formatting** (`\n\n` terminator) prevents buffering freezes  

The pipeline is production-ready and handles cursive handwriting, mixed printed text, mathematical notation, and diagrams.
