from __future__ import annotations

from dataclasses import dataclass

@dataclass
class Identity:
    ec_number: str
    name: str
    role: str

MOCK_USERS = {
    "admin@zetdc": ("ZETDC2026!", Identity("ze9160517", "Farai Makova", "admin")),
    "ze9160517": ("ZETDC2026!", Identity("ze9160517", "Farai Makova", "admin")),
    "viewer@zetdc": ("ZETDC2026!", Identity("EC-01477", "Rudo Ncube", "viewer")),
    "ec-01477": ("ZETDC2026!", Identity("EC-01477", "Rudo Ncube", "viewer")),
}

def authenticate_ec_number(ec_number: str, password: str) -> Identity | None:
    """TODO: replace this provider call when ZETDC SSO details are supplied."""
    record = MOCK_USERS.get(ec_number.strip().lower())
    return record[1] if record and record[0] == password else None
