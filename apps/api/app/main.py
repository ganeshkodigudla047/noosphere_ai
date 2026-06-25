import asyncio

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from .ocr import OCRConfig, OCRDocumentResult, NoospherePDFOCR
from .chat import PageChatRequest, PageChatResponse, answer_page_question, stream_page_answer
from .pipeline import IngestionResult, ingest_pdf

app = FastAPI(title="Noosphere AI Semantic Mapping API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:5174",
        "http://127.0.0.1:5174",
    ],
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/ingest/pdf", response_model=IngestionResult)
async def ingest_pdf_endpoint(
    file: UploadFile = File(...),
    user_id: str = Form(...),
    document_id: str | None = Form(default=None),
    layout_id: str | None = Form(default=None),
    radius: float = Form(default=1.0),
    ocr_if_needed: bool = Form(default=True),
    ocr_all_pages: bool = Form(default=False),
) -> IngestionResult:
    pdf_bytes = await file.read()
    return await ingest_pdf(
        pdf_bytes=pdf_bytes,
        filename=file.filename or "material.pdf",
        user_id=user_id,
        document_id=document_id,
        layout_id=layout_id,
        radius=radius,
        ocr_if_needed=ocr_if_needed,
        ocr_all_pages=ocr_all_pages,
    )


@app.post("/ocr/pdf", response_model=OCRDocumentResult)
async def ocr_pdf_endpoint(
    file: UploadFile = File(...),
    page_numbers: str | None = Form(default=None),
    save_preprocessed_images: bool = Form(default=False),
) -> OCRDocumentResult:
    pdf_bytes = await file.read()
    pages = parse_page_numbers(page_numbers)
    engine = NoospherePDFOCR(config=OCRConfig(save_preprocessed_images=save_preprocessed_images))
    return await asyncio.to_thread(
        engine.transcribe_pdf_bytes,
        pdf_bytes,
        file.filename or "material.pdf",
        pages,
        "ocr-preprocessed" if save_preprocessed_images else None,
    )


@app.post("/chat/page", response_model=PageChatResponse)
async def page_chat_endpoint(request: PageChatRequest) -> PageChatResponse:
    answer = await answer_page_question(request)
    return PageChatResponse(answer=answer)


def _sse_event(token: str) -> str:
    # Each token is sent as a single SSE data line.
    # Replace literal newlines with a space so the line stays intact;
    # the frontend receives the exact token text after stripping "data: ".
    return f"data: {token.replace(chr(10), ' ').replace(chr(13), '')}\n\n"


@app.post("/chat/page/stream")
async def page_chat_stream_endpoint(request: PageChatRequest, http_request: Request) -> StreamingResponse:
    async def event_stream():
        try:
            async for token in stream_page_answer(request):
                if await http_request.is_disconnected():
                    break
                yield _sse_event(token)
                await asyncio.sleep(0)
            yield "data: [DONE]\n\n"
        except Exception as exc:
            yield f"data: [ERROR] {str(exc)}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "X-Accel-Buffering": "no",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        },
    )


def parse_page_numbers(value: str | None) -> list[int] | None:
    if not value:
        return None
    pages: list[int] = []
    try:
        for part in value.split(","):
            stripped = part.strip()
            if not stripped:
                continue
            if "-" in stripped:
                start, end = stripped.split("-", 1)
                pages.extend(range(int(start), int(end) + 1))
            else:
                pages.append(int(stripped))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="page_numbers must look like 1,3-5") from exc
    return sorted(set(page for page in pages if page > 0))
