from __future__ import annotations

from typing import AsyncGenerator

from pydantic import BaseModel
from openai import AsyncOpenAI

from .config import GROQ_API_KEY

# Groq is OpenAI-compatible — just point to a different base URL
GROQ_BASE_URL = "https://api.groq.com/openai/v1"
CHAT_MODEL = "llama-3.1-8b-instant"


def _client() -> AsyncOpenAI:
    return AsyncOpenAI(api_key=GROQ_API_KEY, base_url=GROQ_BASE_URL)


class PageChatRequest(BaseModel):
    document_id: str
    node_id: str
    topic: str
    summary: str
    content: str | None = None
    question: str


class PageChatResponse(BaseModel):
    answer: str


def _build_messages(request: PageChatRequest) -> list[dict]:
    page_content = request.content or request.summary or ""
    system = (
        "You are a smart, friendly study companion. "
        "Answer the user's question using only the content provided below. "
        "If the answer is not in the content, say so honestly. "
        "Be concise, clear, and conversational."
    )
    user = (
        f"Page topic: {request.topic}\n"
        f"Page summary: {request.summary}\n"
        f"Page content:\n{page_content}\n\n"
        f"Question: {request.question}"
    )
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]


async def answer_page_question(request: PageChatRequest) -> str:
    response = await _client().chat.completions.create(
        model=CHAT_MODEL,
        messages=_build_messages(request),
        temperature=0.0,
    )
    return (response.choices[0].message.content or "").strip()


async def stream_page_answer(request: PageChatRequest) -> AsyncGenerator[str, None]:
    # Groq supports standard OpenAI streaming — use stream=True directly
    stream = await _client().chat.completions.create(
        model=CHAT_MODEL,
        messages=_build_messages(request),
        temperature=0.0,
        stream=True,
    )
    async for chunk in stream:
        if chunk.choices and chunk.choices[0].delta.content:
            yield chunk.choices[0].delta.content
