from __future__ import annotations

import re
from dataclasses import dataclass
from statistics import median
from uuid import uuid4

import numpy as np
from sentence_transformers import SentenceTransformer
from sklearn.metrics.pairwise import cosine_similarity

HEADER_FOOTER_LINE_LIMIT = 2
DEFAULT_MODEL_NAME = "all-MiniLM-L6-v2"
DEFAULT_WINDOW_SIZE = 3
DEFAULT_DROP_PERCENTILE = 85
MIN_CHUNK_SENTENCES = 3


class SemanticChunkingError(RuntimeError):
    pass


@dataclass(frozen=True)
class SourcePage:
    page_number: int
    text: str


@dataclass(frozen=True)
class SentenceSpan:
    sentence: str
    start: int
    end: int
    page_number: int


@dataclass(frozen=True)
class SemanticNode:
    id: str
    parent_document_id: str
    concept_title: str
    page_metadata: dict[str, int]
    chunk_text: str


class SemanticChunker:
    def __init__(
        self,
        model_name: str = DEFAULT_MODEL_NAME,
        window_size: int = DEFAULT_WINDOW_SIZE,
        drop_percentile: int = DEFAULT_DROP_PERCENTILE,
        min_chunk_sentences: int = MIN_CHUNK_SENTENCES,
    ) -> None:
        if window_size < 1:
            raise ValueError("window_size must be >= 1")
        if min_chunk_sentences < 1:
            raise ValueError("min_chunk_sentences must be >= 1")
        self.model_name = model_name
        self.window_size = window_size
        self.drop_percentile = drop_percentile
        self.min_chunk_sentences = min_chunk_sentences
        self.model = SentenceTransformer(model_name)

    def build_nodes(self, parent_document_id: str, pages: list[SourcePage]) -> list[SemanticNode]:
        cleaned_pages = clean_pages(pages)
        buffer, page_offsets = concatenate_pages(cleaned_pages)
        sentences = split_sentences_with_pages(buffer, page_offsets)
        if not sentences:
            return [
                SemanticNode(
                    id=str(uuid4()),
                    parent_document_id=parent_document_id,
                    concept_title="Untitled concept",
                    page_metadata={"start_page": cleaned_pages[0].page_number if cleaned_pages else 1, "end_page": cleaned_pages[-1].page_number if cleaned_pages else 1},
                    chunk_text="",
                )
            ]

        boundaries = self.detect_boundaries([span.sentence for span in sentences])
        return materialize_nodes(parent_document_id, sentences, boundaries)

    def detect_boundaries(self, sentences: list[str]) -> list[int]:
        if len(sentences) <= self.min_chunk_sentences:
            return []

        embeddings = self.model.encode(
            sentences,
            convert_to_numpy=True,
            normalize_embeddings=True,
            show_progress_bar=False,
        )
        similarities = consecutive_window_similarities(embeddings, self.window_size)
        if similarities.size == 0:
            return []

        drops = 1.0 - similarities
        threshold = float(np.percentile(drops, self.drop_percentile))
        candidate_boundaries = [index + 1 for index, drop in enumerate(drops) if drop >= threshold]
        return enforce_minimum_spacing(candidate_boundaries, len(sentences), self.min_chunk_sentences)


def clean_pages(pages: list[SourcePage]) -> list[SourcePage]:
    stripped_pages = [SourcePage(page.page_number, strip_page_numbers(page.text)) for page in pages]
    header_candidates: list[list[str]] = []
    footer_candidates: list[list[str]] = []

    for page in stripped_pages:
        lines = meaningful_lines(page.text)
        header_candidates.append(lines[:HEADER_FOOTER_LINE_LIMIT])
        footer_candidates.append(lines[-HEADER_FOOTER_LINE_LIMIT:])

    repeated_headers = repeated_margin_lines(header_candidates)
    repeated_footers = repeated_margin_lines(footer_candidates)
    cleaned: list[SourcePage] = []

    for page in stripped_pages:
        lines = meaningful_lines(page.text)
        filtered = [
            line
            for index, line in enumerate(lines)
            if not (
                index < HEADER_FOOTER_LINE_LIMIT and normalize_margin_line(line) in repeated_headers
            )
            and not (
                index >= max(0, len(lines) - HEADER_FOOTER_LINE_LIMIT) and normalize_margin_line(line) in repeated_footers
            )
        ]
        cleaned.append(SourcePage(page.page_number, normalize_text(" ".join(filtered))))

    return cleaned


def concatenate_pages(pages: list[SourcePage]) -> tuple[str, list[tuple[int, int, int]]]:
    parts: list[str] = []
    offsets: list[tuple[int, int, int]] = []
    cursor = 0

    for page in pages:
        text = normalize_text(page.text)
        if not text:
            continue
        if parts:
            parts.append("\n\n")
            cursor += 2
        start = cursor
        parts.append(text)
        cursor += len(text)
        offsets.append((page.page_number, start, cursor))

    return "".join(parts), offsets


def split_sentences_with_pages(buffer: str, page_offsets: list[tuple[int, int, int]]) -> list[SentenceSpan]:
    spans: list[SentenceSpan] = []
    pattern = re.compile(r"(?s).*?(?:[.!?]+(?:\s+|$)|\n{2,}|$)")
    for match in pattern.finditer(buffer):
        sentence = normalize_text(match.group(0))
        if not sentence:
            continue
        start, end = match.span()
        spans.append(SentenceSpan(sentence=sentence, start=start, end=end, page_number=page_for_offset(start, page_offsets)))
    return spans


def consecutive_window_similarities(embeddings: np.ndarray, window_size: int) -> np.ndarray:
    similarities: list[float] = []
    for boundary_index in range(1, len(embeddings)):
        left_start = max(0, boundary_index - window_size)
        right_end = min(len(embeddings), boundary_index + window_size)
        left = embeddings[left_start:boundary_index]
        right = embeddings[boundary_index:right_end]
        if len(left) == 0 or len(right) == 0:
            continue
        left_vector = np.mean(left, axis=0, keepdims=True)
        right_vector = np.mean(right, axis=0, keepdims=True)
        similarities.append(float(cosine_similarity(left_vector, right_vector)[0][0]))
    return np.asarray(similarities, dtype=np.float32)


def enforce_minimum_spacing(boundaries: list[int], sentence_count: int, min_chunk_sentences: int) -> list[int]:
    accepted: list[int] = []
    previous = 0
    for boundary in boundaries:
        if boundary - previous >= min_chunk_sentences and sentence_count - boundary >= min_chunk_sentences:
            accepted.append(boundary)
            previous = boundary
    return accepted


def materialize_nodes(parent_document_id: str, sentences: list[SentenceSpan], boundaries: list[int]) -> list[SemanticNode]:
    nodes: list[SemanticNode] = []
    starts = [0, *boundaries]
    ends = [*boundaries, len(sentences)]

    for start, end in zip(starts, ends, strict=True):
        chunk_sentences = sentences[start:end]
        chunk_text = normalize_text(" ".join(span.sentence for span in chunk_sentences))
        pages = [span.page_number for span in chunk_sentences]
        nodes.append(
            SemanticNode(
                id=str(uuid4()),
                parent_document_id=parent_document_id,
                concept_title=derive_concept_title(chunk_text),
                page_metadata={"start_page": min(pages), "end_page": max(pages)},
                chunk_text=chunk_text,
            )
        )

    return nodes


def strip_page_numbers(text: str) -> str:
    lines = text.splitlines() or [text]
    cleaned = []
    for line in lines:
        stripped = line.strip()
        if re.fullmatch(r"(?:page\s*)?\d{1,4}", stripped, flags=re.IGNORECASE):
            continue
        if re.fullmatch(r"[-–—]?\s*\d{1,4}\s*[-–—]?", stripped):
            continue
        cleaned.append(line)
    return "\n".join(cleaned)


def repeated_margin_lines(groups: list[list[str]]) -> set[str]:
    flattened = [normalize_margin_line(line) for group in groups for line in group]
    if len(groups) < 3:
        return set()
    minimum_repetitions = max(2, int(round(len(groups) * 0.45)))
    return {
        line
        for line in set(flattened)
        if line and flattened.count(line) >= minimum_repetitions and not line.isdigit()
    }


def meaningful_lines(text: str) -> list[str]:
    return [line.strip() for line in text.splitlines() if line.strip()]


def normalize_margin_line(line: str) -> str:
    return re.sub(r"\d+", "#", normalize_text(line).lower())


def page_for_offset(offset: int, page_offsets: list[tuple[int, int, int]]) -> int:
    for page_number, start, end in page_offsets:
        if start <= offset <= end:
            return page_number
    return page_offsets[-1][0] if page_offsets else 1


def derive_concept_title(chunk_text: str) -> str:
    first_sentence = re.split(r"(?<=[.!?])\s+", chunk_text.strip(), maxsplit=1)[0]
    title = re.sub(r"^(chapter|section|unit|module)\s+\d+[:.\-\s]*", "", first_sentence, flags=re.IGNORECASE)
    title = re.sub(r"\s+", " ", title).strip(" #*-:;")
    if not title:
        return "Untitled concept"
    words = title.split()
    return " ".join(words[:12])[:96]


def normalize_text(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def adaptive_word_chunk(pages: list[SourcePage], parent_document_id: str, words_per_chunk: int = 420) -> list[SemanticNode]:
    cleaned_pages = clean_pages(pages)
    nodes: list[SemanticNode] = []
    active_words: list[str] = []
    active_pages: list[int] = []

    def flush() -> None:
        if not active_words:
            return
        chunk_text = normalize_text(" ".join(active_words))
        nodes.append(
            SemanticNode(
                id=str(uuid4()),
                parent_document_id=parent_document_id,
                concept_title=derive_concept_title(chunk_text),
                page_metadata={"start_page": min(active_pages), "end_page": max(active_pages)},
                chunk_text=chunk_text,
            )
        )
        active_words.clear()
        active_pages.clear()

    for page in cleaned_pages:
        for word in page.text.split():
            active_words.append(word)
            active_pages.append(page.page_number)
            if len(active_words) >= words_per_chunk:
                flush()

    flush()
    return nodes
