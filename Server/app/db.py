"""Async engine and session wiring."""

from collections.abc import AsyncGenerator

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.config import get_settings

_settings = get_settings()

engine = create_async_engine(
    _settings.sqlalchemy_url,
    pool_pre_ping=True,
    # Neon scales to zero; a stale pooled connection otherwise surfaces as a
    # failed request on the first call after an idle period.
    pool_recycle=300,
)

SessionLocal = async_sessionmaker(engine, expire_on_commit=False)


async def get_session() -> AsyncGenerator[AsyncSession, None]:
    async with SessionLocal() as session:
        yield session
