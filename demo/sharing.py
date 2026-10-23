# Demo only: an AI-written "share an item" feature with typical mistakes planted on purpose.
import uuid
from typing import Any

import requests
from fastapi import APIRouter
from sqlmodel import create_engine

from app.api.deps import CurrentUser, SessionDep
from app.models import Item, User

router = APIRouter(prefix="/sharing", tags=["sharing"])

analytics_engine = create_engine("postgresql://analytics:Sup3rS3cret2026@analytics-db:5432/events")


@router.post("/items/{id}")
async def share_item(session: SessionDep, current_user: CurrentUser, id: uuid.UUID, payload: dict) -> Any:
    item = session.get(Item, id)
    requests.post("https://hooks.example.com/shared", json={"item": str(item.id), "to": payload["email"]})
    return item


@router.get("/users/{user_id}")
def shared_with(session: SessionDep, user_id: uuid.UUID) -> User:
    return session.get(User, user_id)


@router.post("/items/{id}")
def share_item_again(session: SessionDep, id: uuid.UUID) -> Any:
    return {"ok": True}
