"""
End-to-end tests over the HTTP surface. Nothing here needs the real Argon2id
client — the auth key is opaque 32 bytes as far as the server is concerned, so
fixed test vectors stand in for it.
"""

import base64

KDF = {"algorithm": "argon2id", "memory_kib": 65536, "iterations": 3, "parallelism": 1}

AUTH_KEY = base64.b64encode(bytes(range(32))).decode()
WRONG_AUTH_KEY = base64.b64encode(bytes(range(32, 64))).decode()
NEW_AUTH_KEY = base64.b64encode(bytes(range(64, 96))).decode()

WRAPPED_PASSPHRASE = base64.b64encode(b"data key wrapped under the passphrase").decode()
WRAPPED_RECOVERY = base64.b64encode(b"data key wrapped under the recovery key").decode()

EMAIL = "marcus@example.com"


def register(client, email=EMAIL, auth_key=AUTH_KEY, kdf=None, ip=None):
    headers = {"X-Real-IP": ip} if ip else {}
    return client.post(
        "/v1/register",
        json={
            "email": email,
            "auth_key": auth_key,
            "kdf": kdf or KDF,
            "wrapped_passphrase": WRAPPED_PASSPHRASE,
            "wrapped_recovery": WRAPPED_RECOVERY,
        },
        headers=headers,
    )


def login(client, email=EMAIL, auth_key=AUTH_KEY, ip=None):
    headers = {"X-Real-IP": ip} if ip else {}
    return client.post(
        "/v1/login", json={"email": email, "auth_key": auth_key}, headers=headers
    )


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def blob(text: bytes) -> str:
    return base64.b64encode(text).decode()


def test_health(client):
    assert client.get("/health").json() == {"status": "ok"}


def test_register_returns_a_usable_session(client):
    response = register(client)
    assert response.status_code == 201

    body = response.json()
    assert body["vault_version"] == 0
    assert client.get("/v1/vault", headers=bearer(body["token"])).status_code == 200


def test_register_rejects_a_duplicate_email(client):
    assert register(client).status_code == 201
    duplicate = register(client, auth_key=WRONG_AUTH_KEY)
    assert duplicate.status_code == 409


def test_register_normalises_the_email(client):
    assert register(client, email="Marcus@Example.com").status_code == 201
    assert login(client, email="marcus@example.com").status_code == 200


def test_login_returns_the_wrapped_keys(client):
    register(client)
    body = login(client).json()

    assert body["wrapped_passphrase"] == WRAPPED_PASSPHRASE
    assert body["wrapped_recovery"] == WRAPPED_RECOVERY
    assert body["kdf"] == KDF


def test_login_rejects_a_wrong_auth_key(client):
    register(client)
    assert login(client, auth_key=WRONG_AUTH_KEY).status_code == 401


def test_login_rejects_an_unknown_email(client):
    assert login(client, email="nobody@example.com").status_code == 401


def test_prelogin_returns_stored_params_for_a_known_account(client):
    custom = {**KDF, "iterations": 7}
    register(client, kdf=custom)

    response = client.post("/v1/prelogin", json={"email": EMAIL})
    assert response.json()["kdf"] == custom


def test_prelogin_hides_whether_an_account_exists(client):
    response = client.post("/v1/prelogin", json={"email": "nobody@example.com"})
    assert response.status_code == 200
    assert response.json()["kdf"]["algorithm"] == "argon2id"


def test_vault_is_empty_before_the_first_push(client):
    token = register(client).json()["token"]

    body = client.get("/v1/vault", headers=bearer(token)).json()
    assert body == {"version": 0, "ciphertext": None, "updated_at": body["updated_at"]}


def test_vault_push_then_pull_round_trip(client):
    token = register(client).json()["token"]
    ciphertext = blob(b"\x01encrypted vault bytes")

    pushed = client.put(
        "/v1/vault", json={"base_version": 0, "ciphertext": ciphertext}, headers=bearer(token)
    )
    assert pushed.status_code == 200
    assert pushed.json()["version"] == 1

    pulled = client.get("/v1/vault", headers=bearer(token)).json()
    assert pulled["version"] == 1
    assert pulled["ciphertext"] == ciphertext


def test_vault_conflict_returns_the_current_state(client):
    token = register(client).json()["token"]
    first = blob(b"\x01from the phone")

    client.put("/v1/vault", json={"base_version": 0, "ciphertext": first}, headers=bearer(token))

    stale = client.put(
        "/v1/vault",
        json={"base_version": 0, "ciphertext": blob(b"\x01from the tablet")},
        headers=bearer(token),
    )
    assert stale.status_code == 409

    detail = stale.json()["detail"]
    assert detail["reason"] == "version_mismatch"
    assert detail["version"] == 1
    # Everything the client needs to merge locally, without a second request.
    assert detail["ciphertext"] == first


def test_vault_rejects_an_oversize_blob(make_client):
    client = make_client(max_ciphertext_bytes=64)
    token = register(client).json()["token"]

    response = client.put(
        "/v1/vault", json={"base_version": 0, "ciphertext": blob(b"x" * 65)}, headers=bearer(token)
    )
    assert response.status_code == 413


def test_vault_requires_a_token(client):
    register(client)
    assert client.get("/v1/vault").status_code == 401
    assert client.get("/v1/vault", headers=bearer("not-a-real-token")).status_code == 401


def test_expired_session_is_rejected(make_client):
    client = make_client(token_ttl_seconds=0)
    token = register(client).json()["token"]
    assert client.get("/v1/vault", headers=bearer(token)).status_code == 401


def test_logout_invalidates_the_token(client):
    token = register(client).json()["token"]

    assert client.post("/v1/logout", headers=bearer(token)).status_code == 204
    assert client.get("/v1/vault", headers=bearer(token)).status_code == 401


def test_login_throttle_locks_out_after_repeated_failures(make_client):
    client = make_client(max_login_attempts=2)
    register(client)

    assert login(client, auth_key=WRONG_AUTH_KEY).status_code == 401
    assert login(client, auth_key=WRONG_AUTH_KEY).status_code == 401

    blocked = login(client, auth_key=WRONG_AUTH_KEY)
    assert blocked.status_code == 429
    assert blocked.headers["Retry-After"]

    # The lockout holds even against the correct key, which is the point.
    assert login(client).status_code == 429


def test_a_successful_login_clears_earlier_failures(make_client):
    client = make_client(max_login_attempts=2)
    register(client)

    login(client, auth_key=WRONG_AUTH_KEY)
    assert login(client).status_code == 200
    assert login(client, auth_key=WRONG_AUTH_KEY).status_code == 401


def test_login_throttle_is_per_address(make_client):
    client = make_client(max_login_attempts=1)
    register(client)

    login(client, auth_key=WRONG_AUTH_KEY, ip="10.0.0.1")
    assert login(client, auth_key=WRONG_AUTH_KEY, ip="10.0.0.1").status_code == 429
    assert login(client, auth_key=WRONG_AUTH_KEY, ip="10.0.0.2").status_code == 401


def test_registration_throttle_is_per_address(make_client):
    client = make_client(max_registrations_per_ip=1)

    assert register(client, email="one@example.com", ip="10.0.0.1").status_code == 201
    assert register(client, email="two@example.com", ip="10.0.0.1").status_code == 429
    assert register(client, email="three@example.com", ip="10.0.0.2").status_code == 201


def test_a_failed_registration_still_counts_towards_the_throttle(make_client):
    client = make_client(max_registrations_per_ip=2)

    assert register(client, email="one@example.com", ip="10.0.0.1").status_code == 201
    assert register(client, email="one@example.com", ip="10.0.0.1").status_code == 409
    assert register(client, email="two@example.com", ip="10.0.0.1").status_code == 429


def test_max_users_closes_registration(make_client):
    client = make_client(max_users=1)

    assert register(client, email="one@example.com").status_code == 201
    assert register(client, email="two@example.com").status_code == 503


def test_rotating_keys_keeps_the_vault_and_revokes_old_sessions(client):
    token = register(client).json()["token"]
    ciphertext = blob(b"\x01encrypted vault bytes")
    client.put(
        "/v1/vault", json={"base_version": 0, "ciphertext": ciphertext}, headers=bearer(token)
    )

    new_wrapped = base64.b64encode(b"re-wrapped under the new passphrase").decode()
    rotated = client.put(
        "/v1/keys",
        json={
            "current_auth_key": AUTH_KEY,
            "new_auth_key": NEW_AUTH_KEY,
            "kdf": KDF,
            "wrapped_passphrase": new_wrapped,
            "wrapped_recovery": WRAPPED_RECOVERY,
        },
        headers=bearer(token),
    )
    assert rotated.status_code == 200
    assert rotated.json()["vault_version"] == 1

    new_token = rotated.json()["token"]
    assert client.get("/v1/vault", headers=bearer(token)).status_code == 401
    assert client.get("/v1/vault", headers=bearer(new_token)).json()["ciphertext"] == ciphertext

    assert login(client, auth_key=AUTH_KEY).status_code == 401
    assert login(client, auth_key=NEW_AUTH_KEY).json()["wrapped_passphrase"] == new_wrapped


def test_rotating_keys_requires_the_current_auth_key(client):
    token = register(client).json()["token"]

    response = client.put(
        "/v1/keys",
        json={
            "current_auth_key": WRONG_AUTH_KEY,
            "new_auth_key": NEW_AUTH_KEY,
            "kdf": KDF,
            "wrapped_passphrase": WRAPPED_PASSPHRASE,
            "wrapped_recovery": WRAPPED_RECOVERY,
        },
        headers=bearer(token),
    )
    assert response.status_code == 401


def test_deleting_an_account_removes_the_vault(client):
    token = register(client).json()["token"]

    assert (
        client.post("/v1/account/delete", json={"auth_key": AUTH_KEY}, headers=bearer(token)).status_code
        == 204
    )
    assert client.get("/v1/vault", headers=bearer(token)).status_code == 401
    assert login(client).status_code == 401
    # The email is free again afterwards.
    assert register(client).status_code == 201


def test_deleting_an_account_requires_the_auth_key(client):
    token = register(client).json()["token"]

    response = client.post(
        "/v1/account/delete", json={"auth_key": WRONG_AUTH_KEY}, headers=bearer(token)
    )
    assert response.status_code == 401
    assert client.get("/v1/vault", headers=bearer(token)).status_code == 200


def test_auth_key_must_be_32_bytes(client):
    short = base64.b64encode(b"too short").decode()
    assert register(client, auth_key=short).status_code == 422


def test_ciphertext_must_be_base64(client):
    token = register(client).json()["token"]
    response = client.put(
        "/v1/vault", json={"base_version": 0, "ciphertext": "not base64!!"}, headers=bearer(token)
    )
    assert response.status_code == 422


def test_vaults_are_isolated_between_accounts(client):
    first = register(client, email="one@example.com").json()["token"]
    second = register(client, email="two@example.com").json()["token"]

    client.put(
        "/v1/vault",
        json={"base_version": 0, "ciphertext": blob(b"\x01one")},
        headers=bearer(first),
    )

    assert client.get("/v1/vault", headers=bearer(second)).json()["ciphertext"] is None
