import os
from dotenv import load_dotenv

load_dotenv()

DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgresql+psycopg://poet:poet@localhost:5433/poet",
)
EMBEDDING_DIM = int(os.getenv("EMBEDDING_DIM", "1536"))
