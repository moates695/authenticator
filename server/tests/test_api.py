"""
End-to-end tests over the HTTP surface. Nothing here needs the real Argon2id
client — the auth key is opaque 32 bytes as far as the server is concerned, so
fixed test vectors stand in for it.

Every account here is enrolled through both factors, because that is the only
way to get a token: `enrol` and `sign_in` do the register-then-verify and
login-then-verify pairs, reading the code out of the fixture mailbox. The key
material rides with the verify, not the register — the account is created when
the code comes back, not when it is asked for.
"""

import base64
import json
import re
import threading
import time

from app.config import DEFAULT_AUTH_KDF, DEFAULT_KDF, TEST_ACCOUNT_CODE
from app.crypto import hash_auth_key
from app.mail import MemoryMailer, SendFailed

# Deliberately not the server's defaults, so the tests that care about stored
# parameters cannot pass by accident.
KDF = {"algorithm": "argon2id", "memory_kib": 65536, "iterations": 3, "parallelism": 1}
# The auth key's own parameters, the light pass that runs before a code is sent.
AUTH_KDF = {"algorithm": "argon2id", "memory_kib": 8192, "iterations": 1, "parallelism": 1}

AUTH_KEY = base64.b64encode(bytes(range(32))).decode()
WRONG_AUTH_KEY = base64.b64encode(bytes(range(32, 64))).decode()
NEW_AUTH_KEY = base64.b64encode(bytes(range(64, 96))).decode()

WRAPPED_PASSPHRASE = base64.b64encode(b"data key wrapped under the passphrase").decode()
WRAPPED_RECOVERY = base64.b64encode(b"data key wrapped under the recovery key").decode()

EMAIL = "marcus@example.com"

# The tester account, and the code it is always given. The address is only
# special to a server configured with it — see the section further down.
TEST_ACCOUNT = "test@app.com"


def register(client, email=EMAIL, ip=None):
    headers = {"X-Real-IP": ip} if ip else {}
    return client.post("/v1/register", json={"email": email}, headers=headers)


def login(client, email=EMAIL, auth_key=AUTH_KEY, ip=None):
    headers = {"X-Real-IP": ip} if ip else {}
    return client.post(
        "/v1/login", json={"email": email, "auth_key": auth_key}, headers=headers
    )


def verify(client, challenge_id, code, auth_key=AUTH_KEY, kdf=None, auth_kdf=None):
    """
    Answers a challenge. The key material rides along by default, the way the
    real client sends it: a registration needs it and a sign-in ignores it, so
    one helper serves both.
    """
    return client.post(
        "/v1/verify",
        json={
            "challenge_id": challenge_id,
            "code": code,
            "auth_key": auth_key,
            "kdf": kdf or KDF,
            "auth_kdf": auth_kdf or AUTH_KDF,
            "wrapped_passphrase": WRAPPED_PASSPHRASE,
            "wrapped_recovery": WRAPPED_RECOVERY,
        },
    )


def resend(client, challenge_id, ip=None):
    headers = {"X-Real-IP": ip} if ip else {}
    return client.post(
        "/v1/verify/resend", json={"challenge_id": challenge_id}, headers=headers
    )


def code_in(mailbox: MemoryMailer) -> str:
    """The six digits out of the most recent message."""
    match = re.search(r"\b(\d{6})\b", mailbox.last.body)
    assert match, f"no code in: {mailbox.last.body}"
    return match.group(1)


def enrol(
    client, mailbox, email=EMAIL, auth_key=AUTH_KEY, kdf=None, auth_kdf=None, ip=None
) -> dict:
    """Registers and confirms the address. Returns the verified session body."""
    challenge = register(client, email=email, ip=ip)
    assert challenge.status_code == 202, challenge.text
    done = verify(
        client,
        challenge.json()["challenge_id"],
        code_in(mailbox),
        auth_key=auth_key,
        kdf=kdf,
        auth_kdf=auth_kdf,
    )
    assert done.status_code == 200, done.text
    return done.json()


def enrol_tester(client) -> dict:
    """`enrol` for the tester account, whose code is fixed rather than mailed."""
    challenge = register(client, email=TEST_ACCOUNT)
    assert challenge.status_code == 202, challenge.text
    done = verify(client, challenge.json()["challenge_id"], TEST_ACCOUNT_CODE)
    assert done.status_code == 200, done.text
    return done.json()


def sign_in(client, mailbox, email=EMAIL, auth_key=AUTH_KEY, ip=None):
    """Both factors of a sign-in. Returns the response to the second one."""
    challenge = login(client, email=email, auth_key=auth_key, ip=ip)
    assert challenge.status_code == 200, challenge.text
    return verify(client, challenge.json()["challenge_id"], code_in(mailbox))


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def blob(text: bytes) -> str:
    return base64.b64encode(text).decode()


def test_health(client):
    assert client.get("/health").json() == {"status": "ok"}


# --- the second factor ---------------------------------------------------


def test_register_sends_a_code_instead_of_a_session(client, mailbox):
    response = register(client)
    assert response.status_code == 202

    body = response.json()
    assert "token" not in body
    assert body["email"] == EMAIL
    assert body["purpose"] == "register"
    assert body["code_expires_at"] <= body["expires_at"]

    assert len(mailbox.sent) == 1
    assert mailbox.last.to == EMAIL
    assert code_in(mailbox)


def test_register_creates_no_account_until_the_code_comes_back(client, mailbox):
    """
    The register request carries nothing but the address, so there is nothing
    on the server to sign in to — not even for whoever asked.
    """
    register(client)
    assert login(client).status_code == 401


def test_a_registration_cannot_be_verified_without_its_key_material(client, mailbox):
    challenge = register(client).json()["challenge_id"]
    code = code_in(mailbox)

    bare = client.post("/v1/verify", json={"challenge_id": challenge, "code": code})
    assert bare.status_code == 400
    assert bare.json()["detail"]["reason"] == "material_required"

    # The right code was not spent on the incomplete request.
    assert verify(client, challenge, code).status_code == 200


def test_a_bare_code_says_whether_it_is_right_without_spending_a_right_one(
    client, mailbox
):
    """
    What the client leans on to check a code before it waits out its own key
    derivation: the code is checked before the material is looked for, so the
    answer to a request carrying only a code is the answer about the code.
    """
    challenge = register(client).json()["challenge_id"]
    code = code_in(mailbox)

    wrong = client.post(
        "/v1/verify",
        json={"challenge_id": challenge, "code": f"{(int(code) + 1) % 1000000:06d}"},
    )
    assert wrong.status_code == 401

    right = client.post("/v1/verify", json={"challenge_id": challenge, "code": code})
    assert right.status_code == 400
    assert right.json()["detail"]["reason"] == "material_required"

    # Asking cost the code nothing, so it still completes the registration.
    assert verify(client, challenge, code).status_code == 200


def test_a_registration_names_the_parameters_for_both_of_its_keys(client, mailbox):
    """
    Both sets are stored per account, so both have to arrive. Without the auth
    key's, a later sign-in would have no way to learn what to derive before
    `/v1/login` will look at it.
    """
    challenge = register(client).json()["challenge_id"]
    code = code_in(mailbox)

    partial = client.post(
        "/v1/verify",
        json={
            "challenge_id": challenge,
            "code": code,
            "auth_key": AUTH_KEY,
            "kdf": KDF,
            "wrapped_passphrase": WRAPPED_PASSPHRASE,
            "wrapped_recovery": WRAPPED_RECOVERY,
        },
    )
    assert partial.status_code == 400

    # Still unspent, so the same code completes once the client sends both.
    assert verify(client, challenge, code).status_code == 200
    assert client.post("/v1/prelogin", json={"email": EMAIL}).json()["auth_kdf"] == AUTH_KDF


def test_the_code_completes_the_registration(client, mailbox):
    body = enrol(client, mailbox)

    assert body["vault_version"] == 0
    assert body["wrapped_passphrase"] == WRAPPED_PASSPHRASE
    assert client.get("/v1/vault", headers=bearer(body["token"])).status_code == 200


def test_a_code_works_only_once(client, mailbox):
    challenge = register(client).json()["challenge_id"]
    code = code_in(mailbox)

    assert verify(client, challenge, code).status_code == 200
    # The challenge went with it, so there is nothing left to replay against.
    assert verify(client, challenge, code).status_code == 410


def test_an_expired_code_is_refused(make_client, mailbox):
    client = make_client(code_ttl_seconds=0)
    challenge = register(client).json()["challenge_id"]

    assert verify(client, challenge, code_in(mailbox)).status_code == 410


def test_a_wrong_code_is_refused_but_the_challenge_survives(client, mailbox):
    challenge = register(client).json()["challenge_id"]
    wrong = f"{(int(code_in(mailbox)) + 1) % 1000000:06d}"

    assert verify(client, challenge, wrong).status_code == 401
    assert verify(client, challenge, code_in(mailbox)).status_code == 200


def test_too_many_wrong_codes_destroy_the_challenge(make_client, mailbox):
    client = make_client(max_code_attempts=2)
    challenge = register(client).json()["challenge_id"]
    wrong = f"{(int(code_in(mailbox)) + 1) % 1000000:06d}"

    assert verify(client, challenge, wrong).status_code == 401
    assert verify(client, challenge, wrong).status_code == 429

    # Even the right code cannot revive it, which is the point of the cap.
    assert verify(client, challenge, code_in(mailbox)).status_code == 410


def test_a_new_code_replaces_the_one_before_it(client, mailbox):
    challenge = register(client).json()["challenge_id"]
    first = code_in(mailbox)

    again = resend(client, challenge)
    assert again.status_code == 200
    second = code_in(mailbox)
    assert first != second

    # Same account, so the resent challenge supersedes rather than accumulating.
    assert verify(client, challenge, first).status_code == 410
    assert verify(client, again.json()["challenge_id"], first).status_code == 401
    assert verify(client, again.json()["challenge_id"], second).status_code == 200


def test_a_new_code_can_be_asked_for_after_the_old_one_expires(make_client, mailbox):
    """
    The challenge outlives the code deliberately. Otherwise a five minute expiry
    would cost the user a passphrase and several seconds of Argon2id to get past.
    """
    client = make_client(code_ttl_seconds=0)
    challenge = register(client).json()["challenge_id"]

    assert verify(client, challenge, code_in(mailbox)).status_code == 410
    assert resend(client, challenge).status_code == 200


def test_an_expired_challenge_cannot_be_resent(make_client, mailbox):
    client = make_client(challenge_ttl_seconds=0)
    challenge = register(client).json()["challenge_id"]

    assert resend(client, challenge).status_code == 410


def test_a_code_is_only_good_for_its_own_challenge(client, mailbox):
    first = register(client, email="one@example.com").json()["challenge_id"]
    first_code = code_in(mailbox)
    register(client, email="two@example.com")
    other_code = code_in(mailbox)
    assert first_code != other_code, "a one-in-a-million collision — re-run"

    assert verify(client, first, other_code).status_code == 401


def test_verify_rejects_an_unknown_challenge(client):
    assert verify(client, "0" * 32, "123456").status_code == 410


def test_a_code_may_be_typed_with_spaces(client, mailbox):
    challenge = register(client).json()["challenge_id"]
    code = code_in(mailbox)

    assert verify(client, challenge, f"{code[:3]} {code[3:]}").status_code == 200


def test_a_malformed_code_is_a_validation_error(client):
    challenge = register(client).json()["challenge_id"]
    assert verify(client, challenge, "12345").status_code == 422
    assert verify(client, challenge, "abcdef").status_code == 422


def test_a_send_failure_leaves_no_usable_challenge(make_client, mailbox):
    class BrokenMailer:
        def send(self, message):
            raise SendFailed("the provider is down")

    client = make_client(mailer=BrokenMailer())
    response = register(client)
    assert response.status_code == 502

    # The account is still there to be registered over, but nothing is pending.
    working = make_client()
    assert register(working).status_code == 202


def test_the_code_throttle_is_per_address(make_client, mailbox):
    client = make_client(max_codes_per_email=1)

    assert register(client, email="one@example.com").status_code == 202
    assert register(client, email="one@example.com").status_code == 429
    assert register(client, email="two@example.com").status_code == 202


# --- the tester account --------------------------------------------------
#
# One address, set by TEST_ACCOUNT_EMAIL, whose code is fixed and never sent. See
# TESTER_ACCOUNT.md. What these check is that the exception is exactly as narrow
# as it claims: the fixed code opens that address and nothing else, the
# passphrase is still checked, and no mail goes out for it.


def with_tester_account(make_client, **overrides):
    """A client whose server has the tester address configured. Not `tester_client`:
    pytest would collect anything starting with `test` as a test of its own."""
    return make_client(test_account_email=TEST_ACCOUNT, **overrides)


def test_the_tester_account_registers_with_the_fixed_code(make_client, mailbox):
    client = with_tester_account(make_client)

    challenge = register(client, email=TEST_ACCOUNT)
    assert challenge.status_code == 202
    assert mailbox.sent == []

    done = verify(client, challenge.json()["challenge_id"], TEST_ACCOUNT_CODE)
    assert done.status_code == 200, done.text
    assert done.json()["token"]


def test_the_tester_account_signs_in_with_the_fixed_code(make_client, mailbox):
    client = with_tester_account(make_client)
    enrol_tester(client)

    challenge = login(client, email=TEST_ACCOUNT)
    assert challenge.status_code == 200
    assert mailbox.sent == []

    done = verify(client, challenge.json()["challenge_id"], TEST_ACCOUNT_CODE)
    assert done.status_code == 200, done.text


def test_the_tester_account_still_needs_its_passphrase(make_client):
    client = with_tester_account(make_client)
    enrol_tester(client)

    assert login(client, email=TEST_ACCOUNT, auth_key=WRONG_AUTH_KEY).status_code == 401


def test_a_wrong_code_is_still_refused_for_the_tester_account(make_client):
    client = with_tester_account(make_client)
    enrol_tester(client)

    challenge = login(client, email=TEST_ACCOUNT)
    assert verify(client, challenge.json()["challenge_id"], "000000").status_code == 401


def test_the_fixed_code_opens_no_other_account(make_client, mailbox):
    client = with_tester_account(make_client)
    enrol(client, mailbox)

    challenge = login(client)
    assert verify(client, challenge.json()["challenge_id"], TEST_ACCOUNT_CODE).status_code == 401


def test_the_tester_address_is_ordinary_until_it_is_configured(client, mailbox):
    """Without TEST_ACCOUNT_EMAIL the address is mailed a random code like any other."""
    challenge = register(client, email=TEST_ACCOUNT)

    assert mailbox.last.to == TEST_ACCOUNT
    assert code_in(mailbox) != TEST_ACCOUNT_CODE
    assert verify(client, challenge.json()["challenge_id"], TEST_ACCOUNT_CODE).status_code == 401


def test_the_tester_account_is_not_charged_to_the_code_throttle(make_client, mailbox):
    """
    A tester signs in far more often than a real user, and no inbox is being
    protected — the limit exists for mail that is never sent here.
    """
    client = with_tester_account(make_client, max_codes_per_email=1)

    for _ in range(3):
        assert register(client, email=TEST_ACCOUNT).status_code == 202
    assert register(client, email="someone@example.com").status_code == 202
    assert register(client, email="someone@example.com").status_code == 429


def test_login_sends_a_code_instead_of_a_session(client, mailbox):
    enrol(client, mailbox)

    response = login(client)
    assert response.status_code == 200

    body = response.json()
    assert "token" not in body
    assert body["purpose"] == "login"
    # Nothing about the account comes back before the second factor.
    assert "wrapped_passphrase" not in body


def test_verifying_a_login_returns_the_wrapped_keys(client, mailbox):
    enrol(client, mailbox)

    body = sign_in(client, mailbox).json()
    assert body["wrapped_passphrase"] == WRAPPED_PASSPHRASE
    assert body["wrapped_recovery"] == WRAPPED_RECOVERY
    assert body["kdf"] == KDF


def test_a_session_is_refused_while_the_address_is_unverified(client, mailbox, db):
    """
    Simulates an account created before verification existed: the migration
    leaves `verified_at` NULL, and every session has to stop working until a
    code has come back.
    """
    token = enrol(client, mailbox)["token"]
    assert client.get("/v1/vault", headers=bearer(token)).status_code == 200

    db.execute("UPDATE users SET verified_at = NULL")

    assert client.get("/v1/vault", headers=bearer(token)).status_code == 403
    # Including the renewal a device would otherwise ride indefinitely.
    assert client.post("/v1/session/refresh", headers=bearer(token)).status_code == 403

    # Signing in again is what puts it right, through the same path as any login.
    restored = sign_in(client, mailbox).json()["token"]
    assert client.get("/v1/vault", headers=bearer(restored)).status_code == 200


def test_an_abandoned_registration_is_finished_by_registering_again(client, mailbox):
    """
    Walking away from the code screen leaves nothing behind, so the way back is
    the same two requests — which now cost a round trip each, not a derivation.
    """
    register(client)
    assert enrol(client, mailbox)["vault_version"] == 0


def test_signing_in_to_a_legacy_unverified_account_confirms_it(client, mailbox, db):
    """
    An account created before registration became two requests may sit
    unverified with its keys already stored. Its next sign-in doubles as the
    confirmation its address never gave, through the same path as any login.
    """
    now = int(time.time())
    db.execute(
        "INSERT INTO users (id, email, auth_key_hash, kdf_params, auth_kdf_params,"
        " wrapped_passphrase, wrapped_recovery, created_at, updated_at, verified_at)"
        " VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, NULL)",
        (
            "legacy-user",
            EMAIL,
            hash_auth_key(base64.b64decode(AUTH_KEY)),
            json.dumps(KDF),
            json.dumps(AUTH_KDF),
            WRAPPED_PASSPHRASE,
            WRAPPED_RECOVERY,
            now,
            now,
        ),
    )
    db.execute(
        "INSERT INTO vaults (user_id, version, ciphertext, updated_at) VALUES (%s, 0, NULL, %s)",
        ("legacy-user", now),
    )

    challenge = login(client)
    assert challenge.status_code == 200
    assert challenge.json()["purpose"] == "register"

    body = verify(client, challenge.json()["challenge_id"], code_in(mailbox)).json()
    assert client.get("/v1/vault", headers=bearer(body["token"])).status_code == 200


# --- accounts ------------------------------------------------------------


def test_register_rejects_a_duplicate_of_a_verified_email(client, mailbox):
    enrol(client, mailbox)
    assert register(client).status_code == 409


def test_register_replaces_a_pending_registration(client, mailbox):
    """
    Nobody proved they own the address the first time, and there is nothing
    stored under it. Refusing here would let a stranger reserve an address they
    cannot read, permanently.
    """
    first = register(client).json()["challenge_id"]
    first_code = code_in(mailbox)
    second = register(client).json()["challenge_id"]

    # The earlier registration is dead, code and all.
    assert verify(client, first, first_code).status_code == 410
    assert verify(client, second, code_in(mailbox), auth_key=NEW_AUTH_KEY).status_code == 200

    # The account that answers is the second one, with the second passphrase.
    assert login(client, auth_key=AUTH_KEY).status_code == 401
    assert sign_in(client, mailbox, auth_key=NEW_AUTH_KEY).status_code == 200


def test_register_normalises_the_email(client, mailbox):
    challenge = register(client, email="Marcus@Example.com")
    assert challenge.status_code == 202
    assert challenge.json()["email"] == "marcus@example.com"

    assert verify(client, challenge.json()["challenge_id"], code_in(mailbox)).status_code == 200
    assert login(client, email="marcus@example.com").status_code == 200


def test_login_rejects_a_wrong_auth_key(client, mailbox):
    enrol(client, mailbox)
    assert login(client, auth_key=WRONG_AUTH_KEY).status_code == 401


def test_login_rejects_an_unknown_email(client):
    assert login(client, email="nobody@example.com").status_code == 401


def test_a_wrong_passphrase_sends_no_email(client, mailbox):
    enrol(client, mailbox)
    before = len(mailbox.sent)

    login(client, auth_key=WRONG_AUTH_KEY)
    assert len(mailbox.sent) == before


def test_prelogin_returns_stored_params_for_a_known_account(client, mailbox):
    custom = {**KDF, "iterations": 7}
    custom_auth = {**AUTH_KDF, "iterations": 2}
    enrol(client, mailbox, kdf=custom, auth_kdf=custom_auth)

    response = client.post("/v1/prelogin", json={"email": EMAIL})
    assert response.json()["kdf"] == custom
    assert response.json()["auth_kdf"] == custom_auth


def test_prelogin_hides_whether_an_account_exists(client, mailbox):
    """
    The decoy only hides anything while it matches what a real registration
    stores. A client whose own defaults have drifted from DEFAULT_KDF or
    DEFAULT_AUTH_KDF turns this endpoint into an account oracle, so the two
    sides are pinned together here.
    """
    enrol(client, mailbox, kdf=DEFAULT_KDF, auth_kdf=DEFAULT_AUTH_KDF)

    known = client.post("/v1/prelogin", json={"email": EMAIL})
    unknown = client.post("/v1/prelogin", json={"email": "nobody@example.com"})

    assert known.status_code == 200
    assert unknown.status_code == 200
    assert unknown.json() == known.json()
    assert unknown.json()["kdf"] == DEFAULT_KDF
    assert unknown.json()["auth_kdf"] == DEFAULT_AUTH_KDF


def test_prelogin_does_not_reveal_a_pending_registration(client, mailbox):
    """A registration mid-flight holds no parameters, so the decoy answers for it."""
    register(client)

    response = client.post("/v1/prelogin", json={"email": EMAIL})
    assert response.json()["kdf"] == DEFAULT_KDF
    assert response.json()["auth_kdf"] == DEFAULT_AUTH_KDF


def test_prelogin_answers_with_both_derivations(client, mailbox):
    """
    A device signing in needs the light parameters before it can call
    `/v1/login` and the heavy ones once the code has come back, and one request
    is what it has to get them in.
    """
    enrol(client, mailbox)

    body = client.post("/v1/prelogin", json={"email": EMAIL}).json()
    assert body["kdf"] == KDF
    assert body["auth_kdf"] == AUTH_KDF
    # Light in front of the code, heavy after it. The other way round would put
    # the wait where nothing is on screen to explain it.
    assert (
        body["auth_kdf"]["memory_kib"] * body["auth_kdf"]["iterations"]
        < body["kdf"]["memory_kib"] * body["kdf"]["iterations"]
    )


# --- the vault -----------------------------------------------------------


def test_vault_is_empty_before_the_first_push(client, mailbox):
    token = enrol(client, mailbox)["token"]

    body = client.get("/v1/vault", headers=bearer(token)).json()
    assert body == {"version": 0, "ciphertext": None, "updated_at": body["updated_at"]}


def test_vault_push_then_pull_round_trip(client, mailbox):
    token = enrol(client, mailbox)["token"]
    ciphertext = blob(b"\x01encrypted vault bytes")

    pushed = client.put(
        "/v1/vault", json={"base_version": 0, "ciphertext": ciphertext}, headers=bearer(token)
    )
    assert pushed.status_code == 200
    assert pushed.json()["version"] == 1

    pulled = client.get("/v1/vault", headers=bearer(token)).json()
    assert pulled["version"] == 1
    assert pulled["ciphertext"] == ciphertext


def test_vault_conflict_returns_the_current_state(client, mailbox):
    token = enrol(client, mailbox)["token"]
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


def test_vault_rejects_an_oversize_blob(make_client, mailbox):
    client = make_client(max_ciphertext_bytes=64)
    token = enrol(client, mailbox)["token"]

    response = client.put(
        "/v1/vault", json={"base_version": 0, "ciphertext": blob(b"x" * 65)}, headers=bearer(token)
    )
    assert response.status_code == 413


def test_vault_requires_a_token(client, mailbox):
    enrol(client, mailbox)
    assert client.get("/v1/vault").status_code == 401
    assert client.get("/v1/vault", headers=bearer("not-a-real-token")).status_code == 401


def test_expired_session_is_rejected(make_client, mailbox):
    client = make_client(token_ttl_seconds=0)
    token = enrol(client, mailbox)["token"]
    assert client.get("/v1/vault", headers=bearer(token)).status_code == 401


def test_logout_invalidates_the_token(client, mailbox):
    token = enrol(client, mailbox)["token"]

    assert client.post("/v1/logout", headers=bearer(token)).status_code == 204
    assert client.get("/v1/vault", headers=bearer(token)).status_code == 401


def test_vaults_are_isolated_between_accounts(client, mailbox):
    first = enrol(client, mailbox, email="one@example.com")["token"]
    second = enrol(client, mailbox, email="two@example.com")["token"]

    client.put(
        "/v1/vault",
        json={"base_version": 0, "ciphertext": blob(b"\x01one")},
        headers=bearer(first),
    )

    assert client.get("/v1/vault", headers=bearer(second)).json()["ciphertext"] is None


def test_two_devices_pushing_at_once_leave_one_of_them_a_conflict(make_client, mailbox):
    """
    The version check is only worth something if it cannot be read by both
    devices before either writes. Two PUTs naming the same base version must
    resolve to one 200 and one 409, never two 200s — the second of which would
    silently discard whatever the first had just stored.

    Each device gets its own app, so they are two connections racing rather than
    one client used from two threads.
    """
    devices = [make_client(), make_client()]
    token = enrol(devices[0], mailbox)["token"]

    for version in range(5):
        start = threading.Barrier(len(devices))
        outcomes: list[tuple[int, str]] = []
        lock = threading.Lock()

        def push(device, tag: str) -> None:
            payload = {"base_version": version, "ciphertext": blob(f"\x01{tag}".encode())}
            start.wait()
            response = device.put("/v1/vault", json=payload, headers=bearer(token))
            with lock:
                outcomes.append((response.status_code, tag))

        threads = [
            threading.Thread(target=push, args=(device, f"device{index}"))
            for index, device in enumerate(devices)
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        codes = sorted(code for code, _ in outcomes)
        assert codes == [200, 409], f"round {version}: {outcomes}"

        # And the vault holds the winner's bytes, not a mix or the loser's.
        winner = next(tag for code, tag in outcomes if code == 200)
        stored = devices[0].get("/v1/vault", headers=bearer(token)).json()
        assert stored["version"] == version + 1
        assert base64.b64decode(stored["ciphertext"]) == f"\x01{winner}".encode()


# --- staying signed in ---------------------------------------------------


def expiries(db) -> list[int]:
    return sorted(row["expires_at"] for row in db.execute("SELECT expires_at FROM sessions"))


def age_sessions(db, expires_at: int) -> None:
    """Moves every session's deadline, so a test need not wait out a real one."""
    db.execute("UPDATE sessions SET expires_at = %s", (expires_at,))


def test_refreshing_puts_the_full_term_back(client, mailbox, db):
    """
    The device passed its own unlock check, so the session is renewed. Nothing is
    reissued: the token in the keystore is the one that keeps working.
    """
    token = enrol(client, mailbox)["token"]
    nearly_out = int(time.time()) + 30
    age_sessions(db, nearly_out)

    response = client.post("/v1/session/refresh", headers=bearer(token))
    assert response.status_code == 200, response.text

    body = response.json()
    assert body["expires_at"] > nearly_out
    assert expiries(db) == [body["expires_at"]]
    assert client.get("/v1/vault", headers=bearer(token)).status_code == 200


def test_a_lapsed_session_cannot_be_refreshed(client, mailbox, db):
    """The renewal keeps a session alive; it cannot raise one from the dead."""
    token = enrol(client, mailbox)["token"]
    age_sessions(db, int(time.time()) - 1)

    assert client.post("/v1/session/refresh", headers=bearer(token)).status_code == 401


def test_refreshing_requires_a_token(client):
    assert client.post("/v1/session/refresh").status_code == 401
    assert client.post("/v1/session/refresh", headers=bearer("not-a-real-token")).status_code == 401


def test_refreshing_touches_only_the_device_that_asked(client, mailbox, db):
    """A phone being used every day must not keep a forgotten one signed in."""
    first = enrol(client, mailbox)["token"]
    second = sign_in(client, mailbox).json()["token"]

    nearly_out = int(time.time()) + 30
    age_sessions(db, nearly_out)
    assert client.post("/v1/session/refresh", headers=bearer(first)).status_code == 200

    moved = expiries(db)
    assert len(moved) == 2
    assert nearly_out in moved, "the other device's session should not have moved"
    assert max(moved) > nearly_out
    assert client.get("/v1/vault", headers=bearer(second)).status_code == 200


def test_logging_out_ends_the_renewal(client, mailbox):
    token = enrol(client, mailbox)["token"]
    client.post("/v1/logout", headers=bearer(token))

    assert client.post("/v1/session/refresh", headers=bearer(token)).status_code == 401


# --- throttles -----------------------------------------------------------


def test_login_throttle_locks_out_after_repeated_failures(make_client, mailbox):
    client = make_client(max_login_attempts=2)
    enrol(client, mailbox)

    assert login(client, auth_key=WRONG_AUTH_KEY).status_code == 401
    assert login(client, auth_key=WRONG_AUTH_KEY).status_code == 401

    blocked = login(client, auth_key=WRONG_AUTH_KEY)
    assert blocked.status_code == 429
    assert blocked.headers["Retry-After"]

    # The lockout holds even against the correct key, which is the point.
    assert login(client).status_code == 429


def test_a_successful_login_clears_earlier_failures(make_client, mailbox):
    client = make_client(max_login_attempts=2)
    enrol(client, mailbox)

    login(client, auth_key=WRONG_AUTH_KEY)
    assert login(client).status_code == 200
    assert login(client, auth_key=WRONG_AUTH_KEY).status_code == 401


def test_login_throttle_is_per_address(make_client, mailbox):
    client = make_client(max_login_attempts=1)
    enrol(client, mailbox)

    login(client, auth_key=WRONG_AUTH_KEY, ip="10.0.0.1")
    assert login(client, auth_key=WRONG_AUTH_KEY, ip="10.0.0.1").status_code == 429
    assert login(client, auth_key=WRONG_AUTH_KEY, ip="10.0.0.2").status_code == 401


def test_registration_throttle_is_per_address(make_client):
    client = make_client(max_registrations_per_ip=1)

    assert register(client, email="one@example.com", ip="10.0.0.1").status_code == 202
    assert register(client, email="two@example.com", ip="10.0.0.1").status_code == 429
    assert register(client, email="three@example.com", ip="10.0.0.2").status_code == 202


def test_a_failed_registration_still_counts_towards_the_throttle(make_client, mailbox):
    client = make_client(max_registrations_per_ip=2)
    enrol(client, mailbox, email="one@example.com", ip="10.0.0.1")

    assert register(client, email="one@example.com", ip="10.0.0.1").status_code == 409
    assert register(client, email="two@example.com", ip="10.0.0.1").status_code == 429


def test_max_users_closes_registration(make_client, mailbox):
    client = make_client(max_users=1)

    enrol(client, mailbox, email="one@example.com")
    assert register(client, email="two@example.com").status_code == 503


def test_max_users_holds_at_verification_too(make_client, mailbox):
    """Two registrations racing for the last seat: the second code loses."""
    client = make_client(max_users=1)

    first = register(client, email="one@example.com").json()["challenge_id"]
    first_code = code_in(mailbox)
    second = register(client, email="two@example.com").json()["challenge_id"]
    second_code = code_in(mailbox)

    assert verify(client, first, first_code).status_code == 200
    assert verify(client, second, second_code).status_code == 503


# --- key rotation and deletion -------------------------------------------


def test_rotating_keys_keeps_the_vault_and_revokes_old_sessions(client, mailbox):
    token = enrol(client, mailbox)["token"]
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
            "auth_kdf": AUTH_KDF,
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
    assert sign_in(client, mailbox, auth_key=NEW_AUTH_KEY).json()["wrapped_passphrase"] == new_wrapped


def test_rotating_keys_requires_the_current_auth_key(client, mailbox):
    token = enrol(client, mailbox)["token"]

    response = client.put(
        "/v1/keys",
        json={
            "current_auth_key": WRONG_AUTH_KEY,
            "new_auth_key": NEW_AUTH_KEY,
            "kdf": KDF,
            "auth_kdf": AUTH_KDF,
            "wrapped_passphrase": WRAPPED_PASSPHRASE,
            "wrapped_recovery": WRAPPED_RECOVERY,
        },
        headers=bearer(token),
    )
    assert response.status_code == 401


def test_deleting_an_account_removes_the_vault(client, mailbox):
    token = enrol(client, mailbox)["token"]

    assert (
        client.post("/v1/account/delete", json={"auth_key": AUTH_KEY}, headers=bearer(token)).status_code
        == 204
    )
    assert client.get("/v1/vault", headers=bearer(token)).status_code == 401
    assert login(client).status_code == 401
    # The email is free again afterwards.
    assert register(client).status_code == 202


def test_deleting_an_account_requires_the_auth_key(client, mailbox):
    token = enrol(client, mailbox)["token"]

    response = client.post(
        "/v1/account/delete", json={"auth_key": WRONG_AUTH_KEY}, headers=bearer(token)
    )
    assert response.status_code == 401
    assert client.get("/v1/vault", headers=bearer(token)).status_code == 200


# --- validation ----------------------------------------------------------


def test_auth_key_must_be_32_bytes(client, mailbox):
    challenge = register(client).json()["challenge_id"]
    short = base64.b64encode(b"too short").decode()
    assert verify(client, challenge, code_in(mailbox), auth_key=short).status_code == 422


def test_ciphertext_must_be_base64(client, mailbox):
    token = enrol(client, mailbox)["token"]
    response = client.put(
        "/v1/vault", json={"base_version": 0, "ciphertext": "not base64!!"}, headers=bearer(token)
    )
    assert response.status_code == 422
