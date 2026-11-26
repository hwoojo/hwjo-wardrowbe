import logging
from typing import Annotated
from uuid import UUID

import io
from fastapi import APIRouter, Depends, HTTPException, status, File, UploadFile
from pydantic import BaseModel
from sqlalchemy import select

from app.config import get_settings
from app.database import DbSession
from app.models.item import ClothingItem
from app.models.preference import UserPreference
from app.models.user import User
from app.schemas.item import ItemUpdate, ItemTags
from app.services.ai_service import AIDisabledError, AIService, require_internal_ai
from app.services.item_service import ItemService
from app.utils.auth import get_current_user
from app.utils.rate_limit import rate_limit_by_user
from app.utils.uploads import UploadTooLargeError, read_upload_within_limit

logger = logging.getLogger(__name__)
settings = get_settings()

router = APIRouter(prefix="/items", tags=["Items"])

class CareLabelResponse(BaseModel):
    care_label: str

async def _read_image_or_413(image: UploadFile) -> bytes:
    try:
        return await read_upload_within_limit(image, settings.max_upload_size_mb)
    except UploadTooLargeError as e:
        raise HTTPException(
            status_code=status.HTTP_413_CONTENT_TOO_LARGE,
            detail=str(e),
        ) from None


async def _owned_item(item_service: ItemService, item_id: UUID, user: User) -> ClothingItem:
    item = await item_service.get_by_id(item_id, user.id)
    if item is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Item not found")
    return item

@router.post("/{item_id}/care-label", response_model=CareLabelResponse)
async def detect_care_label(
    item_id: UUID,
    db: DbSession,
    current_user: Annotated[User, Depends(get_current_user)],
    image: UploadFile = File(...),
) -> CareLabelResponse:
    
    item_service = ItemService(db)
    item = await _owned_item(item_service, item_id, current_user)

    try:
        require_internal_ai("vision")
    except AIDisabledError as e:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"message": "AI vision is disabled", "error_code": "AI_VISION_DISABLED"},
        ) from e
    await rate_limit_by_user(current_user.id, "detect-care-label", max_requests=10, window_seconds=60)
    
    data = await _read_image_or_413(image)
    ai_endpoints = (
        await db.execute(
            select(UserPreference.ai_endpoints).where(UserPreference.user_id == current_user.id)
        )
    ).scalar_one_or_none()
    try:
        text = await AIService(endpoints=ai_endpoints).read_care_label(io.BytesIO(data), current_user.locale)
    except Exception as e:
        logger.error(f"Care label detection failed for item {item_id}: {e}")
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail={
                "message": "The AI service could not be reached",
                "error_code": "AI_UNREACHABLE",
            },
        ) from e
    if text is None:
        logger.info(f"Care label detection failed for item {item_id}")
        raise HTTPException(
           status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "message": "Care label unreadable",
                "error_code": "CARE_LABEL_UNREADABLE",
            },
        )
    text = text[:255]
    await item_service.update(item, ItemUpdate(tags=ItemTags(care_instructions=text)))

    return CareLabelResponse(
        care_label = text
    )
