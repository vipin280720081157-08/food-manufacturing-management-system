"""
Seed demonstration roles and user accounts.

This script creates the five documented application roles and
six demonstration accounts, including two Salesman accounts
required by the benchmark scenario.

Passwords and email addresses are supplied through environment
variables. No credentials are embedded in source code.

The operation is idempotent and runs in one database transaction.
Existing users and role assignments are retained. Passwords change
only with the explicit --evaluator-demo option.
"""

from __future__ import annotations

import argparse
import os
import sys
from dataclasses import dataclass
from pathlib import Path

from pwdlib import PasswordHash
from sqlalchemy import func, select
from sqlalchemy.orm import Session

BACKEND_DIR = Path(__file__).resolve().parents[2] / "backend"

if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.core.database import SessionLocal
from app.core.config import settings
from app.core.demo_accounts import DEMO_PASSWORD
from app.core.security import verify_password
from app.models import Role, User, UserRole
from app.services import auth_service


ROLE_DEFINITIONS: tuple[tuple[str, str], ...] = (
    (
        "Factory Admin",
        "Authorized factory administration and commercial operations.",
    ),
    (
        "Salesman",
        "Customer order collection and authorized sales records.",
    ),
    (
        "Production Supervisor",
        "Authorized production execution and material movements.",
    ),
    (
        "Accountant/Auditor",
        "Read-only financial verification, audit, and reporting.",
    ),
    (
        "Owner",
        "Business-wide read-only management visibility.",
    ),
)


@dataclass(frozen=True)
class DemoAccount:
    key: str
    full_name: str
    role_name: str
    email_variable: str
    password_variable: str


DEMO_ACCOUNTS: tuple[DemoAccount, ...] = (
    DemoAccount(
        key="factory_admin",
        full_name="Factory Admin",
        role_name="Factory Admin",
        email_variable="DEMO_ADMIN_EMAIL",
        password_variable="DEMO_ADMIN_PASSWORD",
    ),
    DemoAccount(
        key="salesman_a",
        full_name="Salesman A",
        role_name="Salesman",
        email_variable="DEMO_SALESMAN_A_EMAIL",
        password_variable="DEMO_SALESMAN_A_PASSWORD",
    ),
    DemoAccount(
        key="salesman_b",
        full_name="Salesman B",
        role_name="Salesman",
        email_variable="DEMO_SALESMAN_B_EMAIL",
        password_variable="DEMO_SALESMAN_B_PASSWORD",
    ),
    DemoAccount(
        key="production_supervisor",
        full_name="Production Supervisor",
        role_name="Production Supervisor",
        email_variable="DEMO_PRODUCTION_EMAIL",
        password_variable="DEMO_PRODUCTION_PASSWORD",
    ),
    DemoAccount(
        key="accountant_auditor",
        full_name="Accountant/Auditor",
        role_name="Accountant/Auditor",
        email_variable="DEMO_ACCOUNTANT_EMAIL",
        password_variable="DEMO_ACCOUNTANT_PASSWORD",
    ),
    DemoAccount(
        key="owner",
        full_name="Owner",
        role_name="Owner",
        email_variable="DEMO_OWNER_EMAIL",
        password_variable="DEMO_OWNER_PASSWORD",
    ),
)


@dataclass(frozen=True)
class AccountCredentials:
    account: DemoAccount
    email: str
    password: str


@dataclass
class SeedResult:
    roles_created: int = 0
    users_created: int = 0
    users_existing: int = 0
    assignments_created: int = 0
    passwords_updated: int = 0
    display_names_updated: int = 0


def load_credentials() -> list[AccountCredentials]:
    """
    Read and validate all required demonstration credentials.

    Validation completes before any database transaction starts.
    """

    credentials: list[AccountCredentials] = []
    missing_variables: list[str] = []
    seen_emails: set[str] = set()

    for account in DEMO_ACCOUNTS:
        email = os.environ.get(
            account.email_variable,
            "",
        ).strip().lower()

        password = os.environ.get(
            account.password_variable,
            "",
        )

        if not email:
            missing_variables.append(account.email_variable)

        if not password:
            missing_variables.append(account.password_variable)

        if not email or not password:
            continue

        if (
            "@" not in email
            or email.startswith("@")
            or email.endswith("@")
            or any(character.isspace() for character in email)
        ):
            raise ValueError(
                f"Invalid email address in {account.email_variable}."
            )

        if email in seen_emails:
            raise ValueError(
                "Demonstration accounts must have distinct email addresses."
            )

        seen_emails.add(email)

        if len(password) < 12:
            if (
                password != DEMO_PASSWORD
                or os.environ.get("DEMO_MODE", "").lower() != "true"
            ):
                raise ValueError(
                    f"{account.password_variable} must contain "
                    "at least 12 characters."
                )

        if len(password) > 1024:
            raise ValueError(
                f"{account.password_variable} exceeds "
                "the permitted password length."
            )

        credentials.append(
            AccountCredentials(
                account=account,
                email=email,
                password=password,
            )
        )

    if missing_variables:
        raise ValueError(
            "Required environment variables are missing: "
            + ", ".join(sorted(missing_variables))
        )

    return credentials


def get_or_create_roles(
    session: Session,
    result: SeedResult,
) -> dict[str, Role]:
    """Create missing roles without changing existing definitions."""

    roles: dict[str, Role] = {}

    for role_name, description in ROLE_DEFINITIONS:
        role = session.scalar(
            select(Role)
            .where(Role.role_name == role_name)
            .with_for_update()
        )

        if role is None:
            role = Role(
                role_name=role_name,
                description=description,
            )

            session.add(role)
            session.flush()

            result.roles_created += 1

        roles[role_name] = role

    return roles


def seed_accounts(
    session: Session,
    credentials: list[AccountCredentials],
    roles: dict[str, Role],
    password_hasher: PasswordHash,
    result: SeedResult,
    *,
    update_existing_passwords: bool = False,
    normalize_existing_names: bool = False,
) -> None:
    """
    Create missing users and primary role assignments.

    Existing accounts are retained unchanged. An existing user
    with an unexpected primary role causes the transaction to fail
    rather than silently changing permissions.
    """

    admin_actor_id = None
    for entry in credentials:
        account = entry.account

        user = session.scalar(
            select(User)
            .where(func.lower(User.email) == entry.email)
            .with_for_update()
        )

        is_existing = user is not None
        if user is None:
            user = User(
                full_name=account.full_name,
                email=entry.email,
                password_hash=password_hasher.hash(
                    entry.password
                ),
                is_active=True,
            )

            session.add(user)
            session.flush()

            result.users_created += 1
        else:
            result.users_existing += 1

        expected_role = roles[account.role_name]

        assignment = session.scalar(
            select(UserRole)
            .where(UserRole.user_id == user.user_id)
            .with_for_update()
        )

        if assignment is None:
            session.add(
                UserRole(
                    user_id=user.user_id,
                    role_id=expected_role.role_id,
                )
            )

            session.flush()
            result.assignments_created += 1

        elif assignment.role_id != expected_role.role_id:
            raise ValueError(
                "Existing user has a different primary role: "
                f"{entry.email}. "
                "Resolve the role assignment through authorized "
                "user management before running this seed."
            )

        if account.role_name == "Factory Admin":
            admin_actor_id = user.user_id

        if (
            is_existing
            and normalize_existing_names
            and user.full_name != account.full_name
        ):
            auth_service.update_user(
                session,
                actor_id=admin_actor_id or user.user_id,
                user_id=user.user_id,
                full_name=account.full_name,
            )
            result.display_names_updated += 1

        if update_existing_passwords and is_existing:
            # Existing demo users are reset through the normal audited service.
            # New users already received the requested hash during creation.
            if is_existing and not verify_password(entry.password, user.password_hash):
                auth_service.reset_user_password(
                    session,
                    actor_id=admin_actor_id or user.user_id,
                    user_id=user.user_id,
                    new_password=entry.password,
                    allow_demo_password=True,
                )
                result.passwords_updated += 1


def seed_demo_users(*, update_existing_passwords: bool = False) -> SeedResult:
    """
    Execute the seed operation as one atomic transaction.

    The transaction rolls back automatically if validation,
    insertion, or database constraints fail.
    """

    credentials = load_credentials()
    password_hasher = PasswordHash.recommended()
    result = SeedResult()

    with SessionLocal.begin() as session:
        roles = get_or_create_roles(
            session=session,
            result=result,
        )

        seed_accounts(
            session=session,
            credentials=credentials,
            roles=roles,
            password_hasher=password_hasher,
            result=result,
            update_existing_passwords=update_existing_passwords,
            normalize_existing_names=update_existing_passwords,
        )

    return result


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Create demonstration users and roles for the "
            "Food Manufacturing Management System."
        )
    )

    parser.add_argument(
        "--apply",
        action="store_true",
        help="Explicitly authorize database seed execution.",
    )
    parser.add_argument(
        "--evaluator-demo",
        action="store_true",
        help="Use the six standard localhost evaluator aliases and password.",
    )

    args = parser.parse_args()

    if not args.apply:
        parser.error(
            "No database changes were made. "
            "Pass --apply to execute the seed."
        )

    environment = settings.ENVIRONMENT.strip().lower()

    if environment == "production":
        parser.error(
            "Demonstration user seeding is disabled "
            "in the production environment."
        )

    if args.evaluator_demo:
        os.environ["DEMO_MODE"] = "true"
        demo_emails = (
            "factory-admin@fmms.local", "salesman-a@fmms.local", "salesman-b@fmms.local",
            "production@fmms.local", "accountant@fmms.local", "owner@fmms.local",
        )
        for account, email in zip(DEMO_ACCOUNTS, demo_emails):
            os.environ.setdefault(account.email_variable, email)
            os.environ.setdefault(account.password_variable, DEMO_PASSWORD)

    try:
        result = seed_demo_users(update_existing_passwords=args.evaluator_demo)

    except (ValueError, RuntimeError) as exc:
        print(
            f"Demo user seed failed: {exc}",
            file=sys.stderr,
        )
        return 1

    except Exception:
        print(
            "Demo user seed failed. "
            "The transaction was not committed.",
            file=sys.stderr,
        )
        raise

    print(
        "Demo user seed completed. "
        f"Roles created: {result.roles_created}; "
        f"users created: {result.users_created}; "
        f"existing users: {result.users_existing}; "
        f"role assignments created: "
        f"{result.assignments_created}; passwords updated: "
        f"{result.passwords_updated}; display names updated: "
        f"{result.display_names_updated}."
    )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
