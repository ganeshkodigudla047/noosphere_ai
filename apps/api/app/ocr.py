from __future__ import annotations

import base64
import logging
import time
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from typing import Iterable

import cv2
import fitz
import numpy as np
from openai import APIConnectionError, APIStatusError, OpenAI, RateLimitError
from pydantic import BaseModel

OCR_MODEL = "gpt-4o"
OCR_DPI = 300
OCR_TEMPERATURE = 0.0
OCR_MAX_RETRIES = 4

OCR_SYSTEM_PROMPT = """You are an expert OCR and handwriting transcription engine for academic study materials.

Extract every visible written element from the image with maximum literal accuracy.

Rules:
- Transcribe handwritten, printed, cursive, and mixed text exactly as written.
- Preserve reading order from top-to-bottom and left-to-right.
- Preserve headings, bullets, numbering, tables, labels, and diagrams when possible.
- Convert mathematical notation and equations into clean Markdown/LaTeX.
- Use Markdown structure only; do not add commentary about the image.
- If a word is uncertain, mark it as [unclear: possible_text].
- Do not hallucinate missing text.
- Do not summarize. Return only the extracted page content.
"""


class OCRPipelineError(RuntimeError):
    pass


class OCRPageResult(BaseModel):
    page_number: int
    markdown: str
    image_path: str | None = None


class OCRDocumentResult(BaseModel):
    filename: str
    page_count: int
    pages: list[OCRPageResult]


@dataclass(frozen=True)
class OCRConfig:
    model: str = OCR_MODEL
    dpi: int = OCR_DPI
    temperature: float = OCR_TEMPERATURE
    max_retries: int = OCR_MAX_RETRIES
    save_preprocessed_images: bool = False


class NoospherePDFOCR:
    def __init__(self, config: OCRConfig | None = None, client: OpenAI | None = None) -> None:
        self.config = config or OCRConfig()
        self.client = client or OpenAI()

    def transcribe_pdf_bytes(
        self,
        pdf_bytes: bytes,
        filename: str = "material.pdf",
        page_numbers: Iterable[int] | None = None,
        output_image_dir: str | Path | None = None,
    ) -> OCRDocumentResult:
        try:
            document = fitz.open(stream=pdf_bytes, filetype="pdf")
        except Exception as exc:
            raise OCRPipelineError("Could not open PDF bytes for OCR") from exc

        page_count = document.page_count
        requested_pages = set(page_numbers or range(1, document.page_count + 1))
        image_dir = self._prepare_image_dir(output_image_dir)
        pages: list[OCRPageResult] = []

        try:
            for page_index in range(document.page_count):
                page_number = page_index + 1
                if page_number not in requested_pages:
                    continue

                try:
                    rgb_image = rasterize_page(document[page_index], dpi=self.config.dpi)
                    processed = preprocess_page_image(rgb_image)
                    image_path = self._save_image(processed, image_dir, page_number)
                    markdown = self._transcribe_image(processed, page_number)
                    pages.append(OCRPageResult(page_number=page_number, markdown=markdown.strip(), image_path=image_path))
                except Exception as exc:
                    logging.exception("OCR failed for page %s", page_number)
                    pages.append(OCRPageResult(page_number=page_number, markdown=f"[OCR failed for page {page_number}: {exc}]"))
        finally:
            document.close()

        return OCRDocumentResult(filename=filename, page_count=page_count, pages=pages)

    def transcribe_pdf_path(
        self,
        pdf_path: str | Path,
        page_numbers: Iterable[int] | None = None,
        output_image_dir: str | Path | None = None,
    ) -> OCRDocumentResult:
        source = Path(pdf_path).expanduser().resolve()
        if not source.exists():
            raise FileNotFoundError(f"PDF not found: {source}")
        return self.transcribe_pdf_bytes(source.read_bytes(), source.name, page_numbers, output_image_dir)

    def _transcribe_image(self, image: np.ndarray, page_number: int) -> str:
        image_base64 = encode_png_base64(image)
        content = [
            {"type": "text", "text": f"Transcribe page {page_number} into structured Markdown."},
            {
                "type": "image_url",
                "image_url": {
                    "url": f"data:image/png;base64,{image_base64}",
                    "detail": "original",
                },
            },
        ]

        for attempt in range(self.config.max_retries + 1):
            try:
                response = self.client.chat.completions.create(
                    model=self.config.model,
                    temperature=self.config.temperature,
                    messages=[
                        {"role": "system", "content": OCR_SYSTEM_PROMPT},
                        {"role": "user", "content": content},
                    ],
                )
                markdown = response.choices[0].message.content
                if not markdown:
                    raise OCRPipelineError(f"OpenAI returned empty OCR content for page {page_number}")
                return markdown
            except RateLimitError as exc:
                self._sleep_before_retry(attempt, exc)
            except APIConnectionError as exc:
                self._sleep_before_retry(attempt, exc)
            except APIStatusError as exc:
                if 400 <= exc.status_code < 500 and exc.status_code != 429:
                    raise OCRPipelineError(f"OpenAI OCR request failed for page {page_number}: {exc}") from exc
                self._sleep_before_retry(attempt, exc)

        raise OCRPipelineError(f"OpenAI OCR failed after retries for page {page_number}")

    def _sleep_before_retry(self, attempt: int, exc: Exception) -> None:
        if attempt >= self.config.max_retries:
            raise OCRPipelineError(f"OCR request failed after {self.config.max_retries + 1} attempts: {exc}") from exc
        time.sleep(min(2**attempt, 20) + 0.25)

    def _prepare_image_dir(self, output_image_dir: str | Path | None) -> Path | None:
        if not self.config.save_preprocessed_images:
            return None
        if output_image_dir is None:
            raise ValueError("output_image_dir is required when save_preprocessed_images is enabled")
        image_dir = Path(output_image_dir).expanduser().resolve()
        image_dir.mkdir(parents=True, exist_ok=True)
        return image_dir

    def _save_image(self, image: np.ndarray, image_dir: Path | None, page_number: int) -> str | None:
        if image_dir is None:
            return None
        path = image_dir / f"page_{page_number:04d}.png"
        if not cv2.imwrite(str(path), image):
            raise OCRPipelineError(f"Could not write preprocessed image: {path}")
        return str(path)


def rasterize_page(page: fitz.Page, dpi: int = OCR_DPI) -> np.ndarray:
    pixmap = page.get_pixmap(dpi=dpi, alpha=False)
    image = np.frombuffer(pixmap.samples, dtype=np.uint8).reshape(pixmap.height, pixmap.width, pixmap.n)
    if pixmap.n == 4:
        return cv2.cvtColor(image, cv2.COLOR_RGBA2RGB)
    if pixmap.n == 1:
        return cv2.cvtColor(image, cv2.COLOR_GRAY2RGB)
    return image


def preprocess_page_image(rgb_image: np.ndarray) -> np.ndarray:
    if rgb_image.size == 0:
        raise OCRPipelineError("Rasterized page image is empty")

    gray = cv2.cvtColor(rgb_image, cv2.COLOR_RGB2GRAY)
    blurred = cv2.medianBlur(gray, 3)

    thresh = cv2.adaptiveThreshold(
        blurred,
        255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY_INV,
        25,
        9,
    )

    horizontal_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (35, 1))
    detected_lines = cv2.morphologyEx(thresh, cv2.MORPH_OPEN, horizontal_kernel, iterations=2)

    cleaned_binary = cv2.subtract(thresh, detected_lines)

    repair_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (1, 6))
    repaired_binary = cv2.morphologyEx(cleaned_binary, cv2.MORPH_CLOSE, repair_kernel)

    return cv2.bitwise_not(repaired_binary)


def encode_png_base64(image: np.ndarray) -> str:
    ok, encoded = cv2.imencode(".png", image)
    if not ok:
        raise OCRPipelineError("Could not encode preprocessed image as PNG")
    return base64.b64encode(encoded.tobytes()).decode("utf-8")
