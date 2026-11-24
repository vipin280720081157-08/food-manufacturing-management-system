from app.api.routes.auth import _role_code


def test_database_role_names_map_to_frontend_role_codes():
    assert _role_code("Factory Admin") == "factory_admin"
    assert _role_code("Salesman") == "salesman"
    assert _role_code("Production Supervisor") == "production_supervisor"
    assert _role_code("Accountant/Auditor") == "accountant_auditor"
    assert _role_code("Owner") == "owner"
