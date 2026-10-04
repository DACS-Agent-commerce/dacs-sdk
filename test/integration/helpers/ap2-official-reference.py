#!/usr/bin/env python3
"""Generate and verify DACS AP2 presentations with the official AP2 Python SDK.

This is an opt-in integration helper, not an independent AP2 implementation.
It must be run with the upstream ``ap2`` package installed from the commit
recorded in ``OFFICIAL_AP2_COMMIT`` below. JSON is read from stdin and written
to stdout; private keys are generated in-memory and are never returned.
"""

from __future__ import annotations

import base64
import hashlib
import json
import sys

from typing import Any

from ap2.sdk.checkout_mandate_chain import CheckoutMandateChain
from ap2.sdk.generated.checkout_mandate import CheckoutMandate
from ap2.sdk.generated.open_checkout_mandate import OpenCheckoutMandate
from ap2.sdk.generated.open_payment_mandate import OpenPaymentMandate
from ap2.sdk.generated.payment_mandate import PaymentMandate
from ap2.sdk.generated.types.amount import Amount
from ap2.sdk.generated.types.checkout import Checkout, Status
from ap2.sdk.generated.types.item import Item
from ap2.sdk.generated.types.line_item import LineItem
from ap2.sdk.generated.types.link import Link
from ap2.sdk.generated.types.merchant import Merchant
from ap2.sdk.generated.types.payment_instrument import PaymentInstrument
from ap2.sdk.generated.types.total import Total
from ap2.sdk.jwt_helper import create_jwt, verify_jwt
from ap2.sdk.mandate import MandateClient
from ap2.sdk.payment_mandate_chain import PaymentMandateChain
from cryptography.hazmat.primitives.asymmetric import ec
from jwcrypto.jwk import JWK


OFFICIAL_AP2_COMMIT = "e1ea56db72a6385bce3e5c1112b3a56ce60acb43"
PROTOCOL_VERSION = "0.2"
AUDIENCE = "dacs-ap2-merchant"
NONCE = "dacs-ap2-reference-nonce-v1"


def _fail(message: str) -> None:
    raise ValueError(message)


def _object(value: Any, name: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        _fail(f"{name} must be an object")
    return value


def _string(value: Any, name: str) -> str:
    if not isinstance(value, str) or not value:
        _fail(f"{name} must be a non-empty string")
    return value


def _positive_integer(value: Any, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        _fail(f"{name} must be a positive integer")
    return value


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _sha256_b64url(value: str) -> str:
    return _b64url(hashlib.sha256(value.encode("utf-8")).digest())


def _new_jwk(kid: str) -> JWK:
    key = JWK.from_pyca(ec.generate_private_key(ec.SECP256R1()))
    value = json.loads(key.export())
    value["kid"] = kid
    return JWK.from_json(json.dumps(value))


def _public_jwk(key: JWK) -> dict[str, Any]:
    return json.loads(key.export_public())


def _cnf(key: JWK) -> dict[str, Any]:
    return {"jwk": _public_jwk(key)}


def _canonical_json(value: Any) -> str:
    # The evidence hash is local diagnostic material, not a DACS artifact hash.
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _read_input() -> dict[str, Any]:
    raw = sys.stdin.buffer.read()
    if not raw:
        return {}
    value = json.loads(raw)
    return _object(value, "input")


def _verify(input_value: dict[str, Any]) -> dict[str, Any]:
    presentation = _object(input_value.get("presentation"), "presentation")
    trust = _object(input_value.get("trust"), "trust")
    checkout_token = _string(
        presentation.get("checkoutPresentation"), "checkoutPresentation"
    )
    payment_token = _string(
        presentation.get("paymentPresentation"), "paymentPresentation"
    )
    user_public_key = JWK.from_json(
        json.dumps(_object(trust.get("userPublicJwk"), "userPublicJwk"))
    )
    merchant_public_key = JWK.from_json(
        json.dumps(_object(trust.get("merchantPublicJwk"), "merchantPublicJwk"))
    )
    audience = _string(input_value.get("expectedAudience"), "expectedAudience")
    nonce = _string(input_value.get("expectedNonce"), "expectedNonce")
    generation = _string(
        input_value.get("merchantSignatureGeneration"),
        "merchantSignatureGeneration",
    )
    if generation != "non-deterministic":
        _fail("DACS requires non-deterministic merchant signature generation")

    client = MandateClient()
    checkout_payloads = client.verify(
        token=checkout_token,
        key_or_provider=lambda _token: user_public_key,
        expected_aud=audience,
        expected_nonce=nonce,
    )
    payment_payloads = client.verify(
        token=payment_token,
        key_or_provider=lambda _token: user_public_key,
        expected_aud=audience,
        expected_nonce=nonce,
    )
    if not isinstance(checkout_payloads, list) or not isinstance(
        payment_payloads, list
    ):
        _fail("official AP2 verifier returned an unexpected mandate shape")

    checkout_chain = CheckoutMandateChain.parse(checkout_payloads)
    payment_chain = PaymentMandateChain.parse(payment_payloads)
    checkout_jwt = checkout_chain.closed_mandate.checkout_jwt

    merchant_payload = verify_jwt(checkout_jwt, merchant_public_key)
    Checkout.model_validate(merchant_payload)
    checkout_violations = checkout_chain.verify(
        expected_checkout_hash=_sha256_b64url(checkout_jwt),
        checkout_jwt=checkout_jwt,
    )
    transaction_id = _sha256_b64url(checkout_jwt)
    payment_violations = payment_chain.verify(
        expected_transaction_id=transaction_id
    )
    violations = checkout_violations + payment_violations
    if violations:
        _fail("official AP2 chain verification failed: " + "; ".join(violations))

    closed_checkout = checkout_payloads[-1]
    sd_alg = closed_checkout.get("_sd_alg")
    if sd_alg is not None and not isinstance(sd_alg, str):
        _fail("verified CheckoutMandate _sd_alg must be a string")
    payment = payment_chain.closed_mandate
    payment_jws = client.get_closed_mandate_jwt(payment_token)
    mandate_id = _sha256_b64url(payment_jws)
    evidence_input = {
        "checkoutPresentation": checkout_token,
        "paymentPresentation": payment_token,
        "merchantCheckoutJwt": checkout_jwt,
        "userKid": trust["userPublicJwk"].get("kid"),
        "merchantKid": trust["merchantPublicJwk"].get("kid"),
    }
    evidence_hash = hashlib.sha256(
        _canonical_json(evidence_input).encode("utf-8")
    ).hexdigest()

    checkout_projection: dict[str, Any] = {
        "vct": checkout_chain.closed_mandate.vct,
        "checkoutJwt": checkout_jwt,
        "checkoutHash": checkout_chain.closed_mandate.checkout_hash,
    }
    if sd_alg is not None:
        checkout_projection["sdAlg"] = sd_alg

    return {
        "checkout": checkout_projection,
        "payment": {
            "vct": payment.vct,
            "mandateId": mandate_id,
            "protocolVersion": PROTOCOL_VERSION,
            "transactionId": payment.transaction_id,
            "payee": payment.payee.model_dump(mode="json", exclude_none=True),
            "paymentAmount": payment.payment_amount.model_dump(
                mode="json", exclude_none=True
            ),
            "paymentInstrument": payment.payment_instrument.model_dump(
                mode="json", exclude_none=True
            ),
        },
        "merchantSignature": {
            "algorithm": "ES256",
            "generation": generation,
        },
        "verifierEvidenceHash": evidence_hash,
    }


def _generate(input_value: dict[str, Any]) -> dict[str, Any]:
    amount_minor = _positive_integer(input_value.get("amountMinor", 50), "amountMinor")
    currency = _string(input_value.get("currency", "USD"), "currency").upper()
    if len(currency) != 3 or not currency.isascii() or not currency.isalpha():
        _fail("currency must be three ASCII letters")
    payee_id = _string(input_value.get("payeeId", "acct_dacs_reference"), "payeeId")
    payee_name = _string(input_value.get("payeeName", "DACS AP2 Reference"), "payeeName")
    instrument_id = _string(
        input_value.get("paymentInstrumentId", "pm_card_visa"),
        "paymentInstrumentId",
    )

    user_key = _new_jwk("dacs-ap2-user-v1")
    agent_key = _new_jwk("dacs-ap2-agent-v1")
    merchant_key = _new_jwk("dacs-ap2-merchant-v1")
    merchant = Merchant(id=payee_id, name=payee_name)
    line_item = LineItem(
        id="li_dacs_ap2_reference",
        item=Item(
            id="dacs-ap2-reference",
            title="DACS AP2 reference settlement",
            price=amount_minor,
        ),
        quantity=1,
        totals=[
            Total(type="subtotal", amount=amount_minor),
            Total(type="total", amount=amount_minor),
        ],
    )
    checkout = Checkout(
        id="chk_dacs_ap2_reference",
        merchant=merchant,
        line_items=[line_item],
        status=Status.ready_for_complete,
        currency=currency,
        totals=[
            Total(type="subtotal", amount=amount_minor),
            Total(type="total", amount=amount_minor),
        ],
        links=[
            Link(type="privacy_policy", url="https://dacs.sh/privacy"),
            Link(type="terms_of_service", url="https://dacs.sh/terms"),
        ],
    )
    checkout_payload = checkout.model_dump(mode="json", exclude_none=True)
    checkout_header = {
        "alg": "ES256",
        "kid": "dacs-ap2-merchant-v1",
        "typ": "JWT",
    }
    checkout_jwt = create_jwt(checkout_header, checkout_payload, merchant_key)
    second_checkout_jwt = create_jwt(checkout_header, checkout_payload, merchant_key)
    if checkout_jwt == second_checkout_jwt:
        _fail("merchant JWS implementation produced deterministic signatures")
    checkout_hash = _sha256_b64url(checkout_jwt)

    client = MandateClient()
    open_checkout = client.create(
        [OpenCheckoutMandate(constraints=[], cnf=_cnf(agent_key))],
        user_key,
    )
    checkout_presentation = client.present(
        holder_key=agent_key,
        mandate_token=open_checkout,
        payloads=[
            CheckoutMandate(
                checkout_jwt=checkout_jwt,
                checkout_hash=checkout_hash,
            )
        ],
        aud=AUDIENCE,
        nonce=NONCE,
    )

    open_payment = client.create(
        [OpenPaymentMandate(constraints=[], cnf=_cnf(agent_key))],
        user_key,
    )
    payment_presentation = client.present(
        holder_key=agent_key,
        mandate_token=open_payment,
        payloads=[
            PaymentMandate(
                transaction_id=checkout_hash,
                payee=merchant,
                payment_amount=Amount(amount=amount_minor, currency=currency),
                payment_instrument=PaymentInstrument(
                    id=instrument_id,
                    type="card",
                ),
            )
        ],
        aud=AUDIENCE,
        nonce=NONCE,
    )
    request = {
        "presentation": {
            "checkoutPresentation": checkout_presentation,
            "paymentPresentation": payment_presentation,
        },
        "trust": {
            "userPublicJwk": _public_jwk(user_key),
            "merchantPublicJwk": _public_jwk(merchant_key),
        },
        "expectedAudience": AUDIENCE,
        "expectedNonce": NONCE,
        "merchantSignatureGeneration": "non-deterministic",
    }
    return {
        "officialAp2Commit": OFFICIAL_AP2_COMMIT,
        "request": request,
        "verified": _verify(request),
    }


def main() -> None:
    if len(sys.argv) != 2 or sys.argv[1] not in {"generate", "verify"}:
        raise SystemExit("usage: ap2-official-reference.py generate|verify")
    input_value = _read_input()
    output = _generate(input_value) if sys.argv[1] == "generate" else _verify(input_value)
    sys.stdout.write(_canonical_json(output) + "\n")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # fail closed at the process boundary
        sys.stderr.write(f"AP2 verification failed: {error}\n")
        raise SystemExit(1) from error
