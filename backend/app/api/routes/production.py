"""Production planning and batch posting endpoints."""

from datetime import date
from uuid import UUID

from fastapi import APIRouter, Query

from app.api.dependencies import DBSession, ProductionOperatorUser, TransactionalDBSession
from app.schemas.production import ProductionRunCreate, ProductionRunDetailResponse, ProductionRunStartRequest, ProductionRunCancellationRequest
from app.services import production_service

router = APIRouter(prefix="/production", tags=["Production"])


def _payload(run):
    payload = ProductionRunDetailResponse.model_validate(run).model_dump(mode="json")
    occurred_at = run.start_time or run.completion_time
    payload.update({
        "id": str(run.production_run_id),
        "run_number": run.production_number,
        "product_name": run.product.inventory_item.item_name if run.product and run.product.inventory_item else "",
        "production_date": occurred_at.date().isoformat() if occurred_at else "",
        "planned_quantity": str(run.planned_output),
        "actual_good_quantity": str(run.good_output) if run.status == "COMPLETED" else None,
        "created_at": occurred_at.isoformat() if occurred_at else "",
    })
    return payload


@router.get("/runs")
def list_runs(actor: ProductionOperatorUser, db: DBSession, status: str | None = None, product_id: UUID | None = None, page: int = Query(1, ge=1), page_size: int = Query(50, ge=1, le=500)):
    runs, total = production_service.list_production_runs(db, actor_id=actor.user_id, run_status=status.upper() if status else None, product_id=product_id, page=page, page_size=page_size)
    return {"items": [_payload(run) for run in runs], "total": total, "page": page, "page_size": page_size}


@router.post("/runs", status_code=201)
def create_run(payload: ProductionRunCreate, actor: ProductionOperatorUser, db: TransactionalDBSession):
    run = production_service.create_production_run(db, actor_id=actor.user_id, product_id=payload.product_id, bom_id=payload.bom_id, planned_output=payload.planned_output, production_date=date.today())
    return _payload(run)


@router.get("/runs/{run_id}")
def get_run(run_id: UUID, actor: ProductionOperatorUser, db: DBSession):
    return _payload(production_service.get_production_run(db, production_run_id=run_id, actor_id=actor.user_id))


@router.post("/runs/{run_id}/start")
def start_run(run_id: UUID, _payload: ProductionRunStartRequest, actor: ProductionOperatorUser, db: TransactionalDBSession):
    return _payload(production_service.start_production_run(db, production_run_id=run_id, actor_id=actor.user_id))


@router.post("/runs/{run_id}/cancel")
def cancel_run(run_id: UUID, payload: ProductionRunCancellationRequest, actor: ProductionOperatorUser, db: TransactionalDBSession):
    return _payload(production_service.cancel_production_run(db, production_run_id=run_id, actor_id=actor.user_id, reason=payload.reason))
