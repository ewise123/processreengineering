import os

from openai import OpenAI

from app.config import EMBEDDING_DIM

EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "text-embedding-3-small")
EMBEDDING_BATCH = 100

_client: OpenAI | None = None


def _get_client() -> OpenAI:
    global _client
    if _client is None:
        api_key = os.getenv("OPENAI_API_KEY")
        if not api_key:
            raise RuntimeError(
                "OPENAI_API_KEY is not set. Add it to backend/.env to use embeddings."
            )
        _client = OpenAI(api_key=api_key)
    return _client


def embed_texts(texts: list[str]) -> list[list[float]]:
    """Embed a batch of texts via OpenAI. Returns vectors of length EMBEDDING_DIM."""
    if not texts:
        return []
    client = _get_client()
    out: list[list[float]] = []
    for start in range(0, len(texts), EMBEDDING_BATCH):
        batch = texts[start : start + EMBEDDING_BATCH]
        resp = client.embeddings.create(
            model=EMBEDDING_MODEL,
            input=batch,
            dimensions=EMBEDDING_DIM,
        )
        out.extend([item.embedding for item in resp.data])
    return out
