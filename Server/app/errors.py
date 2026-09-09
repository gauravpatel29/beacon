"""RFC 9457 problem+json responses."""

from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

PROBLEM_BASE = "https://beacon.api/problems"
CONTENT_TYPE = "application/problem+json"


class ProblemError(Exception):
    """Raised anywhere in the app; rendered as problem+json by the handler."""

    def __init__(
        self,
        status: int,
        title: str,
        *,
        problem_type: str = "about:blank",
        detail: str | None = None,
        errors: list[dict[str, Any]] | None = None,
    ) -> None:
        super().__init__(title)
        self.status = status
        self.title = title
        self.problem_type = problem_type
        self.detail = detail
        self.errors = errors or []

    def to_dict(self, instance: str | None = None) -> dict[str, Any]:
        body: dict[str, Any] = {
            "type": self.problem_type,
            "title": self.title,
            "status": self.status,
        }
        if self.detail:
            body["detail"] = self.detail
        if instance:
            body["instance"] = instance
        if self.errors:
            body["errors"] = self.errors
        return body


def not_found(what: str) -> ProblemError:
    return ProblemError(
        404, "Not found", problem_type=f"{PROBLEM_BASE}/not-found", detail=what
    )


def conflict(detail: str, errors: list[dict[str, Any]] | None = None) -> ProblemError:
    return ProblemError(
        409, "Conflict", problem_type=f"{PROBLEM_BASE}/conflict",
        detail=detail, errors=errors,
    )


def bad_request(detail: str) -> ProblemError:
    return ProblemError(
        400, "Bad request", problem_type=f"{PROBLEM_BASE}/bad-request", detail=detail
    )


def unprocessable(
    title: str, detail: str | None = None, errors: list[dict[str, Any]] | None = None
) -> ProblemError:
    return ProblemError(
        422, title, problem_type=f"{PROBLEM_BASE}/validation-failed",
        detail=detail, errors=errors,
    )


def register_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ProblemError)
    async def _problem(request: Request, exc: ProblemError) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status,
            content=exc.to_dict(instance=str(request.url.path)),
            media_type=CONTENT_TYPE,
        )

    @app.exception_handler(RequestValidationError)
    async def _validation(
        request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        # Reshape FastAPI's default 422 into the contract's problem+json.
        errors = []
        for err in exc.errors():
            loc = [str(p) for p in err.get("loc", []) if p != "body"]
            errors.append(
                {
                    "pointer": "/" + "/".join(loc) if loc else "/",
                    "code": err.get("type", "invalid"),
                    "message": err.get("msg", "Invalid value."),
                }
            )
        problem = ProblemError(
            422,
            "Validation failed",
            problem_type=f"{PROBLEM_BASE}/validation-failed",
            errors=errors,
        )
        return JSONResponse(
            status_code=422,
            content=problem.to_dict(instance=str(request.url.path)),
            media_type=CONTENT_TYPE,
        )
