"""Locks down which endpoints are reachable without authentication.

Resolved through FastAPI's real dependency tree rather than by reading the
route signatures, because several routers apply their guard once at the
APIRouter level (and propagate it to sub-routers they include). A signature
scan misses those and reports protected routes as open.

The point of the allowlist is that adding an unauthenticated endpoint has to
be a deliberate edit to this file, reviewed on its own terms.
"""
import pytest

from main import app

AUTH_DEPENDENCIES = {
    "require_admin",
    "require_user",
    "require_superadmin",
    "require_admin_plus_or_superadmin",
    "require_kiosk_or_admin",
    "get_current_auth",
    "verify_kiosk",
    # WebSocket-route equivalents — see auth.get_current_auth_ws's docstring
    # for why they are separate functions rather than the same ones above.
    "require_admin_ws",
    "get_current_auth_ws",
}

# (method, path) pairs that are unauthenticated on purpose.
INTENTIONALLY_PUBLIC = {
    # Credentials are what this one issues.
    ("POST", "/api/auth/login"),
    # Kiosk enrollment: a kiosk has no credentials until these complete.
    ("POST", "/api/kiosks/handshake"),
    ("POST", "/api/kiosks/enroll"),
    ("POST", "/api/kiosks/auto-handshake"),
    ("POST", "/api/kiosks/request-activation"),
    # Kiosk self-update. Serves the offline client payload; a kiosk fetches
    # these before it has a session. Exposure is the client source, on a
    # trusted network.
    ("GET", "/api/kiosks/payload-hash"),
    ("GET", "/api/kiosks/payload-archive"),
    # A freshly restored node reports back in before it has been re-enrolled.
    ("POST", "/api/nodes/checkin-restored"),
    # Build identifier, used by the frontend to pick kiosk vs orchestrator UI.
    ("GET", "/api/version"),
}


def _api_routes():
    """Every endpoint in the app, with its fully resolved dependency tree.

    `app.routes` used to be the flat list, so this was a one-line loop. Newer
    FastAPI keeps each `include_router` call as a single `_IncludedRouter`
    entry and resolves the endpoints underneath it on demand, which made the
    old loop find zero endpoints -- and, because "no endpoints" trivially
    satisfies "no endpoint lacks auth", turned this whole file green while
    checking nothing. `test_the_route_scan_actually_finds_routes` exists so
    that failure mode is loud rather than silent next time.

    `effective_candidates()` and not `original_router.routes`: the guard on
    the network endpoints is applied at the mount in main.py, not in the
    router, so the raw router's copy of a route does not carry it. Reading
    those would report every network endpoint as unauthenticated.

    Recursive because a router included into a router nests the wrappers, and
    the network endpoints -- the ones whose guard is hardest to verify by
    reading -- are two levels down.
    """
    def walk(routes):
        for route in routes:
            included = getattr(route, "effective_candidates", None)
            if included is not None:
                yield from walk(included())
            elif hasattr(route, "dependant"):
                yield route

    yield from walk(app.routes)


def _auth_guards(route):
    """Every auth dependency reachable from this route, at any depth."""
    root_dep = getattr(route, "dependant", None)
    if root_dep is None and hasattr(route, "original_route"):
        root_dep = getattr(route.original_route, "dependant", None)
    found, stack = set(), [root_dep] if root_dep is not None else []
    while stack:
        dep = stack.pop()
        if dep is None:
            continue
        name = getattr(dep.call, "__name__", None)
        if name:
            found.add(name)
        stack.extend(dep.dependencies)
    return found & AUTH_DEPENDENCIES


def _unauthenticated_routes():
    out = set()
    for route in _api_routes():
        if _auth_guards(route):
            continue
        # A websocket route has no .methods (there is no HTTP verb to a
        # handshake) — "WS" is a synthetic label so an unauthenticated one
        # still shows up here instead of crashing the scan or being silently
        # skipped, either of which would defeat the point of this file.
        methods = getattr(route, "methods", None)
        if methods is None:
            out.add(("WS", route.path))
            continue
        for method in methods - {"HEAD", "OPTIONS"}:
            out.add((method, route.path))
    return out


def test_the_route_scan_actually_finds_routes():
    """A guard on the guard.

    Every other assertion here is of the form "nothing in this set is bad", so
    an empty set passes them all. That is not hypothetical: a FastAPI upgrade
    changed how `app.routes` is structured and silently emptied the scan, and
    the only test that noticed was the one checking the allowlist was not
    stale -- which reads as a bookkeeping failure, not as authorization going
    unchecked.
    """
    routes = list(_api_routes())
    assert len(routes) > 50, (
        f"the route scan found only {len(routes)} endpoints, so the checks in "
        "this file are passing vacuously -- FastAPI's route structure has "
        "probably changed again, see _api_routes()"
    )

    paths = {r.path for r in routes}
    # One guarded and one deliberately public, so neither a scan that drops
    # protected routes nor one that drops open routes can satisfy this.
    assert "/api/nodes" in paths
    assert "/api/auth/login" in paths


def test_no_unexpected_unauthenticated_endpoints():
    unexpected = _unauthenticated_routes() - INTENTIONALLY_PUBLIC
    assert not unexpected, (
        "These endpoints are reachable without authentication and are not in "
        f"the allowlist: {sorted(unexpected)}. If that is deliberate, add them "
        "to INTENTIONALLY_PUBLIC with a comment explaining why."
    )


def test_allowlist_has_no_stale_entries():
    stale = INTENTIONALLY_PUBLIC - _unauthenticated_routes()
    assert not stale, (
        f"These are listed as intentionally public but now carry auth (or no "
        f"longer exist): {sorted(stale)}. Remove them from the allowlist."
    )


@pytest.mark.parametrize("path", [
    "/api/monitoring/preferences",
    "/api/notifications/preferences",
])
def test_preference_routes_require_a_user_not_just_any_principal(path):
    """Kiosk and User ids come from independent sequences and can collide.

    Any route that resolves a User row from the authenticated principal must
    depend on require_user (or require_admin), never bare get_current_auth,
    or a kiosk token can act on an unrelated user's account.
    """
    matched = [r for r in _api_routes() if r.path == path]
    # Asserted rather than assumed: this used to be a bare loop that checked
    # nothing at all when the path was absent, which is precisely what
    # happened when the route scan broke.
    assert matched, f"{path} not found — was it renamed or unmounted?"

    for route in matched:
        guards = _auth_guards(route)
        assert "require_user" in guards or "require_admin" in guards, (
            f"{path} guards={sorted(guards)} — needs require_user"
        )


def test_network_routes_are_admin_only_on_the_orchestrator():
    """The router itself declares no auth so the kiosk can mount it bare.

    That makes the orchestrator's guard a property of the mount in main.py,
    which is exactly the kind of thing that gets dropped in a refactor.
    """
    network = [r for r in _api_routes() if r.path.startswith("/api/network/")]
    assert network, "no /api/network/* routes found — did the mount move?"
    for route in network:
        assert "require_admin" in _auth_guards(route), (
            f"{route.path} is not admin-guarded; check the include_router "
            "dependencies in main.py"
        )
