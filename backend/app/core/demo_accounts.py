"""Fixed evaluator accounts, exposed only by loopback demo mode."""

from dataclasses import dataclass


DEMO_PASSWORD = "Demo123!"


@dataclass(frozen=True)
class DemoAccount:
    username: str
    label: str
    email: str
    role_name: str
    role_code: str


DEMO_ACCOUNTS = (
    DemoAccount("admin", "Factory Admin", "factory-admin@fmms.local", "Factory Admin", "factory_admin"),
    DemoAccount("salesa", "Salesman A", "salesman-a@fmms.local", "Salesman", "salesman"),
    DemoAccount("salesb", "Salesman B", "salesman-b@fmms.local", "Salesman", "salesman"),
    DemoAccount("production", "Production Supervisor", "production@fmms.local", "Production Supervisor", "production_supervisor"),
    DemoAccount("accountant", "Accountant/Auditor", "accountant@fmms.local", "Accountant/Auditor", "accountant_auditor"),
    DemoAccount("owner", "Owner", "owner@fmms.local", "Owner", "owner"),
)

DEMO_ACCOUNT_BY_USERNAME = {account.username: account for account in DEMO_ACCOUNTS}
