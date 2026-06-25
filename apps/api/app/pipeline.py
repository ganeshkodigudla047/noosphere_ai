from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha256
from io import BytesIO
from math import sqrt
from uuid import uuid4

import numpy as np
import umap
from openai import AsyncOpenAI
from pydantic import BaseModel, Field
from pypdf import PdfReader

from .ocr import NoospherePDFOCR, OCRConfig

EMBEDDING_MODEL = "text-embedding-3-small"
EMBEDDING_DIMENSIONS = 1536
DEFAULT_RANDOM_SEED = 42
OCR_NATIVE_TEXT_THRESHOLD = 80


class SpherePoint(BaseModel):
    x: float
    y: float
    z: float


class MappedChunk(BaseModel):
    id: str
    chunk_index: int
    page_start: int
    page_end: int
    title: str
    summary: str
    token_count: int
    umap: SpherePoint
    sphere: SpherePoint


class ParentMacroNode(BaseModel):
    id: str
    label: str
    child_count: int
    sphere: SpherePoint
    cluster_radius: float


class IngestionResult(BaseModel):
    user_id: str
    document_id: str
    layout_id: str
    filename: str
    checksum_sha256: str
    embedding_model: str = EMBEDDING_MODEL
    radius: float
    ocr_pages: list[int] = Field(default_factory=list)
    parent: ParentMacroNode
    children: list[MappedChunk]
    supabase_rows: dict[str, list[dict]] = Field(default_factory=dict)


@dataclass(frozen=True)
class ExtractedPage:
    page_number: int
    title: str
    text: str
    extraction_method: str = "native"


@dataclass(frozen=True)
class TextChunk:
    chunk_index: int
    page_start: int
    page_end: int
    title: str
    content: str


async def ingest_pdf(
    pdf_bytes: bytes,
    filename: str,
    user_id: str,
    document_id: str | None = None,
    layout_id: str | None = None,
    radius: float = 1.0,
    ocr_if_needed: bool = True,
    ocr_all_pages: bool = False,
) -> IngestionResult:
    document_id = document_id or str(uuid4())
    layout_id = layout_id or str(uuid4())
    parent_id = str(uuid4())

    pages = await extract_pdf_pages(
        pdf_bytes=pdf_bytes,
        filename=filename,
        ocr_if_needed=ocr_if_needed,
        ocr_all_pages=ocr_all_pages,
    )
    ocr_pages = [page.page_number for page in pages if page.extraction_method == "vision_ocr"]
    chunks = build_semantic_chunks(pages)
    embeddings = await embed_chunks([chunk.content for chunk in chunks])
    umap_points = reduce_embeddings_to_3d(embeddings)
    sphere_points = normalize_points_to_sphere(umap_points, radius)
    parent_sphere = calculate_parent_coordinate(sphere_points, radius)
    cluster_radius = float(np.mean(np.linalg.norm(sphere_points - parent_sphere, axis=1))) if len(sphere_points) else 0.0

    children = [
        MappedChunk(
            id=str(uuid4()),
            chunk_index=chunk.chunk_index,
            page_start=chunk.page_start,
            page_end=chunk.page_end,
            title=chunk.title,
            summary=chunk.content[:260].strip(),
            token_count=count_tokens_roughly(chunk.content),
            umap=SpherePoint(x=float(umap_points[index][0]), y=float(umap_points[index][1]), z=float(umap_points[index][2])),
            sphere=SpherePoint(x=float(sphere_points[index][0]), y=float(sphere_points[index][1]), z=float(sphere_points[index][2])),
        )
        for index, chunk in enumerate(chunks)
    ]

    parent = ParentMacroNode(
        id=parent_id,
        label=filename.removesuffix(".pdf").replace("_", " ").replace("-", " "),
        child_count=len(children),
        sphere=SpherePoint(x=float(parent_sphere[0]), y=float(parent_sphere[1]), z=float(parent_sphere[2])),
        cluster_radius=cluster_radius,
    )

    return IngestionResult(
        user_id=user_id,
        document_id=document_id,
        layout_id=layout_id,
        filename=filename,
        checksum_sha256=sha256(pdf_bytes).hexdigest(),
        radius=radius,
        ocr_pages=ocr_pages,
        parent=parent,
        children=children,
        supabase_rows=build_supabase_rows(
            user_id=user_id,
            document_id=document_id,
            layout_id=layout_id,
            parent=parent,
            chunks=chunks,
            children=children,
            embeddings=embeddings,
            radius=radius,
        ),
    )


async def extract_pdf_pages(
    pdf_bytes: bytes,
    filename: str = "material.pdf",
    ocr_if_needed: bool = True,
    ocr_all_pages: bool = False,
) -> list[ExtractedPage]:
    reader = PdfReader(BytesIO(pdf_bytes))
    pages: list[ExtractedPage] = []
    for index, page in enumerate(reader.pages, start=1):
        text = normalize_text(page.extract_text() or "")
        pages.append(ExtractedPage(page_number=index, title=derive_title(text, index), text=text))

    if not pages:
        pages = [ExtractedPage(page_number=1, title="Untitled PDF", text="")]

    should_ocr = [
        page.page_number
        for page in pages
        if ocr_all_pages or len(page.text) < OCR_NATIVE_TEXT_THRESHOLD
    ]
    if ocr_if_needed and should_ocr:
        ocr_result = await run_vision_ocr(pdf_bytes, filename, should_ocr)
        ocr_by_page = {
            page.page_number: page.markdown
            for page in ocr_result.pages
            if page.markdown.strip() and not page.markdown.startswith("[OCR failed")
        }
        pages = [
            ExtractedPage(
                page_number=page.page_number,
                title=derive_title(ocr_by_page.get(page.page_number, page.text), page.page_number),
                text=normalize_text(ocr_by_page.get(page.page_number, page.text)),
                extraction_method="vision_ocr" if page.page_number in ocr_by_page else page.extraction_method,
            )
            for page in pages
        ]

    return pages


async def run_vision_ocr(pdf_bytes: bytes, filename: str, page_numbers: list[int]):
    import asyncio

    engine = NoospherePDFOCR(config=OCRConfig())
    return await asyncio.to_thread(engine.transcribe_pdf_bytes, pdf_bytes, filename, page_numbers)


def build_semantic_chunks(pages: list[ExtractedPage], max_words: int = 900, min_similarity: float = 0.16) -> list[TextChunk]:
    chunks: list[TextChunk] = []
    active_title = ""
    active_pages: list[int] = []
    active_text: list[str] = []
    previous_signature: set[str] = set()

    def flush() -> None:
        if not active_pages:
            return
        chunks.append(
            TextChunk(
                chunk_index=len(chunks),
                page_start=min(active_pages),
                page_end=max(active_pages),
                title=active_title,
                content=normalize_text(" ".join(active_text)),
            )
        )

    for page in pages:
        signature = keyword_signature(page.text)
        similarity = jaccard(previous_signature, signature)
        active_word_count = count_tokens_roughly(" ".join(active_text))
        starts_new_topic = bool(active_pages) and (
            active_word_count >= max_words
            or (previous_signature and signature and similarity < min_similarity)
            or looks_like_chapter_boundary(page.title)
        )

        if starts_new_topic:
            flush()
            active_pages = []
            active_text = []

        if not active_pages:
            active_title = page.title
        active_pages.append(page.page_number)
        active_text.append(page.text)
        previous_signature = signature

    flush()
    return chunks or [TextChunk(chunk_index=0, page_start=1, page_end=1, title="Untitled PDF", content="")]


async def embed_chunks(chunks: list[str]) -> np.ndarray:
    client = AsyncOpenAI()
    response = await client.embeddings.create(
        model=EMBEDDING_MODEL,
        input=[chunk or "Empty page" for chunk in chunks],
        dimensions=EMBEDDING_DIMENSIONS,
    )
    vectors = [item.embedding for item in response.data]
    return np.asarray(vectors, dtype=np.float32)


def reduce_embeddings_to_3d(embeddings: np.ndarray) -> np.ndarray:
    if len(embeddings) < 4:
        return deterministic_small_layout(len(embeddings))

    reducer = umap.UMAP(
        n_components=3,
        n_neighbors=min(12, max(2, len(embeddings) - 1)),
        min_dist=0.08,
        metric="cosine",
        random_state=DEFAULT_RANDOM_SEED,
    )
    return reducer.fit_transform(embeddings).astype(np.float32)


def normalize_points_to_sphere(points: np.ndarray, radius: float) -> np.ndarray:
    normalized = []
    for point in points:
        norm = sqrt(float(np.dot(point, point)))
        if norm == 0:
            normalized.append(np.array([0.0, 0.0, radius], dtype=np.float32))
        else:
            normalized.append((point / norm) * radius)
    return np.asarray(normalized, dtype=np.float32)


def calculate_parent_coordinate(child_points: np.ndarray, radius: float) -> np.ndarray:
    if len(child_points) == 0:
        return np.array([0.0, 0.0, radius], dtype=np.float32)
    center = np.mean(child_points, axis=0)
    norm = sqrt(float(np.dot(center, center)))
    if norm == 0:
        return child_points[0]
    return (center / norm) * radius


def build_supabase_rows(
    user_id: str,
    document_id: str,
    layout_id: str,
    parent: ParentMacroNode,
    chunks: list[TextChunk],
    children: list[MappedChunk],
    embeddings: np.ndarray,
    radius: float,
) -> dict[str, list[dict]]:
    parent_row = {
        "id": parent.id,
        "user_id": user_id,
        "document_id": document_id,
        "layout_id": layout_id,
        "kind": "macro",
        "label": parent.label,
        "summary": f"{parent.child_count} semantic child nodes",
        "umap_x": parent.sphere.x,
        "umap_y": parent.sphere.y,
        "umap_z": parent.sphere.z,
        "sphere_x": parent.sphere.x,
        "sphere_y": parent.sphere.y,
        "sphere_z": parent.sphere.z,
        "radius": radius,
        "cluster_radius": parent.cluster_radius,
        "child_count": parent.child_count,
    }

    node_rows = [parent_row]
    chunk_rows = []
    for chunk, child, embedding in zip(chunks, children, embeddings, strict=True):
        node_rows.append(
            {
                "id": child.id,
                "user_id": user_id,
                "document_id": document_id,
                "parent_node_id": parent.id,
                "layout_id": layout_id,
                "kind": "micro",
                "chunk_strategy": "hybrid",
                "chunk_index": child.chunk_index,
                "page_start": child.page_start,
                "page_end": child.page_end,
                "label": child.title,
                "summary": child.summary,
                "embedding": embedding.tolist(),
                "umap_x": child.umap.x,
                "umap_y": child.umap.y,
                "umap_z": child.umap.z,
                "sphere_x": child.sphere.x,
                "sphere_y": child.sphere.y,
                "sphere_z": child.sphere.z,
                "radius": radius,
                "color_key": "document-child",
            }
        )
        chunk_rows.append(
            {
                "user_id": user_id,
                "document_id": document_id,
                "node_id": child.id,
                "chunk_index": child.chunk_index,
                "page_start": chunk.page_start,
                "page_end": chunk.page_end,
                "title": chunk.title,
                "content": chunk.content,
                "token_count": child.token_count,
                "chunk_strategy": "hybrid",
                "embedding": embedding.tolist(),
            }
        )

    return {"knowledge_nodes": node_rows, "page_chunks": chunk_rows}


def deterministic_small_layout(count: int) -> np.ndarray:
    if count <= 0:
        return np.zeros((0, 3), dtype=np.float32)
    points = []
    for index in range(count):
        angle = (index / max(1, count)) * np.pi * 2
        points.append([np.cos(angle), np.sin(angle) * 0.55, 1.0 + index * 0.03])
    return np.asarray(points, dtype=np.float32)


def normalize_text(text: str) -> str:
    return " ".join(text.split())


def derive_title(text: str, page_number: int) -> str:
    if not text:
        return f"Page {page_number}"
    first_sentence = text.split(". ")[0]
    return first_sentence[:80].strip() or f"Page {page_number}"


def keyword_signature(text: str) -> set[str]:
    stop_words = {"about", "after", "also", "because", "before", "being", "between", "could", "from", "have", "into", "more", "that", "their", "there", "these", "this", "through", "with", "would"}
    return {
        word
        for word in normalize_text(text.lower()).replace("-", " ").split()
        if len(word) > 4 and word.isalnum() and word not in stop_words
    }


def jaccard(left: set[str], right: set[str]) -> float:
    if not left or not right:
        return 0.0
    return len(left & right) / len(left | right)


def looks_like_chapter_boundary(title: str) -> bool:
    lowered = title.lower()
    return lowered.startswith(("chapter ", "unit ", "module ", "section "))


def count_tokens_roughly(text: str) -> int:
    return len(text.split())
