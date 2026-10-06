"""Hotels.com search and checkout using the signed-in browser session.

Python HTTP clients are rejected by the site. These calls go through curl
with HTTP/2 and the cookie file in .secrets/.
"""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
import time
import uuid
from contextvars import ContextVar, Token
from datetime import date
from pathlib import Path
from urllib.parse import parse_qs, quote, urlparse

ROOT = Path(__file__).resolve().parents[1]
GRAPHQL = "https://www.hotels.com/graphql"
LISTING_HASH = "9fe4a0908a10b7068669f9690c19fa4da8103b2b51b5c240bfc1bac9f6fdc2e5"
OFFER_HASH = "648de57d2cda114b736e5cfc89cbde12d1f84db57d5b2edfb6aa799ea3a5caf8"
PREPARE_HASH = "eda083b60670009f18292303697b403899f5da01a9ac5c1d52591cddb83b8f11"
USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"
)
# GraphQL returns 429 when calls are fired back to back.
MIN_REQUEST_GAP = 12
AFTER_429_GAP = 90
_last_request_at = 0.0
_last_status = 0
_session_cookie: ContextVar[str | None] = ContextVar("hotels_session", default=None)


class HotelsError(RuntimeError):
    pass


def cookie_path() -> Path:
    configured = os.environ.get("HOTELS_COOKIE_FILE", ".secrets/hotels-cookies.txt")
    path = Path(configured)
    if not path.is_absolute():
        path = ROOT / path
    return path


def bind_session(header: str) -> Token:
    """Use this traveler's Hotels.com cookie for the current job."""
    return _session_cookie.set(normalize_session(header))


def reset_session(token: Token) -> None:
    _session_cookie.reset(token)


def normalize_session(header: str) -> str:
    text = (header or "").strip()
    if text.lower().startswith("cookie:"):
        text = text.split(":", 1)[1].strip()
    pairs: dict[str, str] = {}
    for part in text.split(";"):
        name, sep, value = part.strip().partition("=")
        if sep and name:
            pairs[name] = value
    if "EG_SESSIONTOKEN" not in pairs or not pairs["EG_SESSIONTOKEN"]:
        raise HotelsError("Hotels.com sign-in is missing.")
    if "EG_ANONTOKEN" in pairs:
        raise HotelsError("Hotels.com sign-in is still anonymous.")
    return "; ".join(f"{name}={value}" for name, value in pairs.items())


def stored_session() -> str | None:
    """Session from HOTELS_COOKIE, then the local cookie file."""
    raw = os.environ.get("HOTELS_COOKIE", "").strip()
    if raw:
        return normalize_session(raw)
    path = cookie_path()
    if not path.is_file():
        return None
    try:
        return normalize_session(path.read_text())
    except HotelsError:
        return None


def _cookie_header() -> str:
    override = _session_cookie.get()
    if override:
        return override
    saved = stored_session()
    if saved:
        return saved
    raise HotelsError("Hotels.com sign-in is missing.")


def context() -> dict:
    return {
        "siteId": 300000001,
        "locale": "en_US",
        "eapid": 1,
        "tpid": 3001,
        "currency": "USD",
        "device": {"type": "DESKTOP"},
        "identity": {
            "duaid": os.environ.get(
                "HOTELS_DUAID", "58349ba0-30e4-4275-a3bf-118074746312"
            ),
            "authState": "AUTHENTICATED",
        },
        "privacyTrackingState": "CAN_TRACK",
    }


def lookup_city(query: str) -> dict:
    url = (
        "https://www.hotels.com/api/v4/typeahead/"
        f"{quote(query)}?siteid=300000001&locale=en_US&maxresults=5"
        "&features=ta_hierarchy&format=json"
    )
    headers = {
        "user-agent": USER_AGENT,
        "accept": "application/json",
        "accept-language": "en-US,en;q=0.6",
    }
    headers["cookie"] = _cookie_header()
    status, raw = _impersonated("GET", url, headers=headers)
    if status != 200:
        raise HotelsError(f"City lookup failed with HTTP {status}")
    payload = json.loads(raw)
    matches = payload.get("sr") or []
    if not matches:
        raise HotelsError(f"No Hotels.com city match for {query}")
    match = matches[0]
    coordinates = match["coordinates"]
    return {
        "regionName": match["regionNames"]["fullName"],
        "regionId": str(match["gaiaId"]),
        "coordinates": {
            "latitude": float(coordinates["lat"]),
            "longitude": float(coordinates["long"]),
        },
        "pinnedPropertyId": None,
        "propertyIds": None,
        "mapBounds": None,
    }


def search_stays(
    destination: dict,
    check_in: date,
    check_out: date,
    adults: int = 2,
    payment_type: str = "PAY_LATER",
    lodging: str = "",
    property_id: str = "",
) -> dict:
    destination = dict(destination)
    if property_id:
        destination["pinnedPropertyId"] = property_id
        destination["propertyIds"] = [property_id]
    search_id = str(uuid.uuid4())
    product_offers_id = str(uuid.uuid4())
    selections = [
        {"id": "paymentType", "value": payment_type},
        {"id": "privacyTrackingState", "value": "CAN_TRACK"},
        {"id": "productOffersId", "value": product_offers_id},
        {"id": "searchId", "value": search_id},
        {"id": "sort", "value": "PRICE_LOW_TO_HIGH"},
        {"id": "useRewards", "value": "SHOP_WITHOUT_POINTS"},
    ]
    if lodging:
        selections.extend(
            [
                {"id": "lodging", "value": lodging},
                {"id": "structureTypes", "value": lodging},
            ]
        )
    body = {
        "operationName": "PropertyListingQuery",
        "variables": {
            "context": context(),
            "criteria": {
                "primary": {
                    "dateRange": _date_range(check_in, check_out),
                    "destination": destination,
                    "rooms": [{"adults": adults, "children": []}],
                },
                "secondary": {
                    "counts": [
                        {"id": "resultsStartingIndex", "value": 0},
                        {"id": "resultsSize", "value": 8},
                    ],
                    "booleans": [],
                    "selections": selections,
                    "ranges": [],
                },
            },
            "shoppingContext": {
                "multiItem": None,
                "queryTriggeredBy": "FILTER_MODAL_APPLIED",
                "typeaheadCollationId": None,
            },
        },
        "extensions": {
            "persistedQuery": {"version": 1, "sha256Hash": LISTING_HASH}
        },
    }
    referer = (
        "https://www.hotels.com/Hotel-Search"
        f"?regionId={destination['regionId']}"
        f"&d1={check_in.isoformat()}&d2={check_out.isoformat()}"
        f"&adults={adults}&rooms=1&sort=PRICE_LOW_TO_HIGH"
        f"&paymentType={payment_type}"
    )
    payload = _graphql(
        body,
        operation="PropertyListingQuery",
        operation_type="query",
        referer=referer,
        page_id="page.Hotel-Search,H,20",
        client_info="shopping-pwa,00cd657c0a746cb3a71ac0b0370ed6edad9403f3,us-west-2",
        extra_headers={
            "x-enable-apq": "true",
            "x-shopping-product-line": "lodging",
        },
    )
    search = payload["data"]["propertySearch"]
    stays = []
    for card in search.get("propertySearchListings") or []:
        if card.get("__typename") != "LodgingCard":
            continue
        stay = _stay_from_card(card)
        if stay:
            stay["search_id"] = stay.get("search_id") or search_id
            stay["product_offers_id"] = product_offers_id
            stays.append(stay)
    return {
        "heading": (search.get("summary") or {}).get("resultsHeading"),
        "stays": stays,
    }


def open_checkout(
    destination: dict,
    stay: dict,
    check_in: date,
    check_out: date,
    adults: int,
    payment_type: str,
    lodging: str,
) -> dict:
    offer = _single_offer(
        destination, stay, check_in, check_out, adults, payment_type, lodging
    )
    pay_later = _pay_later_action(offer)
    if pay_later is None:
        raise HotelsError("The selected stay has no pay-later rate")
    prepared = _prepare_checkout(pay_later["action"])
    prepared_data = prepared.get("data") or {}
    checkout = (
        prepared_data.get("prepareCheckout")
        or prepared_data.get("lodgingPropertyCheckoutPrepareCheckout")
        or {}
    )
    return {
        "property_id": stay["property_id"],
        "name": stay["name"],
        "price": stay["price"],
        "free_cancellation": stay["free_cancellation"],
        "payment_model": "PAY_LATER",
        "total": pay_later["total"],
        "trip_id": checkout.get("tripId"),
        "checkout_url": checkout.get("checkoutUrl"),
        "failure_reason": checkout.get("failureReason"),
    }


def _stay_from_card(card: dict) -> dict | None:
    link = ((card.get("cardLink") or {}).get("resource") or {}).get("value") or ""
    query = parse_qs(urlparse(link).query)
    property_id = (query.get("expediaPropertyId") or [card.get("id")])[0]
    if not property_id:
        return None
    price = (
        card.get("priceSection", {})
        .get("priceSummary", {})
        .get("options", [{}])[0]
        .get("displayPrice", {})
        .get("formatted")
    )
    return {
        "property_id": str(property_id),
        "name": (card.get("headingSection") or {}).get("heading"),
        "price": price,
        "free_cancellation": _free_cancellation(card),
        "room_type_id": (query.get("selectedRoomType") or [None])[0],
        "rate_plan_id": (query.get("selectedRatePlan") or [None])[0],
        "search_id": (query.get("searchId") or [None])[0],
        "url": link,
    }


def _free_cancellation(card: dict) -> bool:
    messages = ((card.get("cardLink") or {}).get("analytics") or {}).get(
        "uisPrimeMessages"
    ) or []
    for message in messages:
        if message.get("schemaName") != "allHotelProducts":
            continue
        content = json.loads(message["messageContent"])
        products = content.get("hotelProducts") or []
        if products:
            return bool(products[0].get("freeCancellation"))
    return False


def _single_offer(
    destination: dict,
    stay: dict,
    check_in: date,
    check_out: date,
    adults: int,
    payment_type: str,
    lodging: str,
) -> dict:
    if not stay.get("room_type_id") or not stay.get("rate_plan_id"):
        raise HotelsError("The listing did not include a room and rate to open")
    selections = [
        {"id": "paymentType", "value": payment_type},
        {"id": "privacyTrackingState", "value": "CAN_TRACK"},
        {"id": "sort", "value": "PRICE_LOW_TO_HIGH"},
        {"id": "useRewards", "value": "SHOP_WITHOUT_POINTS"},
    ]
    if stay.get("product_offers_id"):
        selections.append({"id": "productOffersId", "value": stay["product_offers_id"]})
    if stay.get("search_id"):
        selections.append({"id": "searchId", "value": stay["search_id"]})
    if lodging:
        selections.extend(
            [
                {"id": "lodging", "value": lodging},
                {"id": "structureTypes", "value": lodging},
            ]
        )
    criteria = {
        "primary": {
            "dateRange": _date_range(check_in, check_out),
            "destination": destination,
            "rooms": [{"adults": adults, "children": []}],
        },
        "secondary": {
            "counts": [],
            "booleans": [],
            "selections": selections,
            "ranges": [],
        },
    }
    amount = _amount(stay.get("price"))
    body = [
        {
            "operationName": "SingleOfferQuery",
            "variables": {
                "skipRatePlans": False,
                "propertyId": stay["property_id"],
                "searchCriteria": criteria,
                "shoppingContext": {"multiItem": None, "queryTriggeredBy": "OTHER"},
                "travelAdTrackingInfo": None,
                "searchOffer": {
                    "offerPrice": {
                        "offerTimestamp": str(_now_ms()),
                        "price": {"amount": amount, "currency": "USD"},
                        "pointsApplied": False,
                    },
                    "roomTypeId": stay["room_type_id"],
                    "ratePlanId": stay["rate_plan_id"],
                    "offerDetails": [],
                },
                "referrer": "HSR",
                "selectedSavedQuoteInput": None,
                "productIdentifier": {
                    "id": stay["property_id"],
                    "type": "PROPERTY_ID",
                    "travelSearchCriteria": {"property": criteria},
                    "shoppingContext": {"multiItem": None, "queryTriggeredBy": "OTHER"},
                },
                "context": context(),
            },
            "extensions": {
                "persistedQuery": {"version": 1, "sha256Hash": OFFER_HASH}
            },
        }
    ]
    payload = _graphql(
        body,
        operation="SingleOfferQuery",
        operation_type="query",
        referer="https://www.hotels.com/",
        page_id="page.Hotels.Infosite.Information,H,30",
        client_info="shopping-pwa,1406cb168a3ca179f09ab3ac5c5aaa78ec369173,us-west-2",
        extra_headers={
            "x-hcom-origin-id": "page.Hotels.Infosite.Information,H,30",
            "x-shopping-product-line": "lodging",
        },
    )
    offers = (payload.get("data") or {}).get("propertyOffers") or {}
    unit = offers.get("singleUnitOffer")
    if not unit:
        raise HotelsError("The selected stay has no offer to open")
    return unit


def _pay_later_action(offer: dict) -> dict | None:
    for plan in offer.get("ratePlans") or []:
        for detail in plan.get("priceDetails") or []:
            if detail.get("paymentModel") != "PAY_LATER":
                continue
            action = (detail.get("lodgingPrepareCheckout") or {}).get("action")
            if not action:
                continue
            total = action.get("totalPrice") or {}
            currency = total.get("currency") or (total.get("currencyInfo") or {}).get(
                "code"
            )
            return {
                "action": action,
                "total": {"amount": total.get("amount"), "currency": currency},
            }
    return None


def _prepare_checkout(action: dict) -> dict:
    natural = _strip(action["propertyNaturalKeys"][0])
    body = [
        {
            "operationName": "lodgingPropertyCheckoutPrepareCheckout",
            "variables": {
                "context": context(),
                "properties": [natural],
                "checkoutOptions": _strip(action.get("checkoutOptions") or []),
                "offerTokens": _strip(action.get("offerTokens") or []),
                "totalPrice": {
                    "amount": (action.get("totalPrice") or {}).get("amount"),
                    "currency": (
                        (action.get("totalPrice") or {}).get("currency")
                        or ((action.get("totalPrice") or {}).get("currencyInfo") or {}).get(
                            "code"
                        )
                    ),
                },
                "responseOptions": ["ALTERNATIVE_ACTION_ON_FAILURE"],
            },
            "extensions": {
                "persistedQuery": {"version": 1, "sha256Hash": PREPARE_HASH}
            },
        }
    ]
    return _graphql(
        body,
        operation="lodgingPropertyCheckoutPrepareCheckout",
        operation_type="mutation",
        referer="https://www.hotels.com/",
        page_id="page.Hotels.Infosite.Information,H,30",
        client_info="shopping-pwa,1406cb168a3ca179f09ab3ac5c5aaa78ec369173,us-west-2",
        extra_headers={
            "x-hcom-origin-id": "page.Hotels.Infosite.Information,H,30",
            "x-shopping-product-line": "lodging",
        },
    )


def _graphql(
    body: dict | list,
    operation: str,
    operation_type: str,
    referer: str,
    page_id: str,
    client_info: str,
    extra_headers: dict | None = None,
) -> dict:
    headers = {
        "accept": "application/json, multipart/mixed",
        "accept-language": "en-US,en;q=0.6",
        "content-type": "application/json",
        "client-info": client_info,
        "ctx-view-id": str(uuid.uuid4()),
        "x-apollo-operation-name": operation,
        "x-apollo-operation-type": operation_type,
        "x-page-id": page_id,
    }
    headers.update(extra_headers or {})
    headers["cookie"] = _cookie_header()
    status, raw = _impersonated("POST", GRAPHQL, headers=headers, json_body=body)
    if status != 200:
        raise HotelsError(f"{operation} failed with HTTP {status}")
    payload = json.loads(raw)
    if isinstance(payload, list):
        payload = payload[0]
    if payload.get("errors"):
        message = payload["errors"][0].get("message", "GraphQL error")
        raise HotelsError(f"{operation} failed: {message}")
    return payload


def _impersonated(
    method: str,
    url: str,
    headers: dict,
    json_body: dict | list | None = None,
) -> tuple[int, bytes]:
    """Stock curl is rejected with a 429. Chrome's TLS fingerprint is accepted."""
    from curl_cffi import requests

    response = requests.request(
        method,
        url,
        headers=headers,
        json=json_body,
        impersonate="chrome",
        timeout=30,
    )
    return response.status_code, response.content


def _curl(
    url: str,
    method: str = "GET",
    headers: dict | None = None,
    body_file: str | None = None,
) -> tuple[int, bytes]:
    _pace()
    with tempfile.NamedTemporaryFile() as out:
        cmd = [
            "curl",
            "--http2",
            "--silent",
            "--show-error",
            "--compressed",
            "--output",
            out.name,
            "--write-out",
            "%{http_code}",
            "-X",
            method,
            url,
        ]
        for key, value in (headers or {}).items():
            cmd.extend(["-H", f"{key}: {value}"])
        if body_file:
            cmd.extend(["--data-binary", f"@{body_file}"])
        result = subprocess.run(cmd, check=False, capture_output=True, text=True)
        if result.returncode != 0:
            raise HotelsError(result.stderr.strip()[:300] or "curl failed")
        code = int(result.stdout.strip() or "0")
        _note_request(code)
        return code, Path(out.name).read_bytes()


def _pace() -> None:
    global _last_request_at
    if not _last_request_at:
        return
    gap = AFTER_429_GAP if _last_status == 429 else MIN_REQUEST_GAP
    remaining = gap - (time.monotonic() - _last_request_at)
    if remaining > 0:
        time.sleep(remaining)


def _note_request(status: int) -> None:
    global _last_request_at, _last_status
    _last_request_at = time.monotonic()
    _last_status = status


def _date_range(check_in: date, check_out: date) -> dict:
    return {
        "checkInDate": {"day": check_in.day, "month": check_in.month, "year": check_in.year},
        "checkOutDate": {
            "day": check_out.day,
            "month": check_out.month,
            "year": check_out.year,
        },
    }


def _amount(formatted: str | None) -> int:
    digits = "".join(ch for ch in (formatted or "") if ch.isdigit())
    return int(digits or "0")


def _now_ms() -> int:
    from time import time

    return int(time() * 1000)


def _strip(value):
    if isinstance(value, dict):
        return {key: _strip(item) for key, item in value.items() if key != "__typename"}
    if isinstance(value, list):
        return [_strip(item) for item in value]
    return value
