"""Run one Hotels.com search or checkout from a JSON object on stdin."""

from __future__ import annotations

import json
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agent.hotels_api import HotelsError, lookup_city, open_checkout, search_stays
from agent.hotels_book import confirm_reservation


def main() -> None:
    try:
        requested = json.load(sys.stdin)
        json.dump(run(requested), sys.stdout)
    except HotelsError as exc:
        json.dump({"status": "failed", "message": str(exc)}, sys.stdout)
    except json.JSONDecodeError:
        json.dump({"status": "failed", "message": "The search input was not JSON."}, sys.stdout)


def run(input_data: dict) -> dict:
    action = (input_data.get("action") or "search").strip().lower()
    if action == "book":
        checkout_url = (input_data.get("checkout_url") or "").strip()
        if not checkout_url:
            raise HotelsError("The stay has no checkout to finish")
        return {"reservation": confirm_reservation(checkout_url)}
    destination_name = (input_data.get("destination") or "").strip()
    check_in = parse_date(input_data.get("check_in"), "check_in")
    check_out = parse_date(input_data.get("check_out"), "check_out")
    if check_out <= check_in:
        raise HotelsError("check_out must be after check_in")
    adults = int(input_data.get("adults") or 2)
    payment_type = (input_data.get("payment_type") or "PAY_LATER").strip()
    lodging = blank(input_data.get("lodging"))
    action = (input_data.get("action") or "search").strip().lower()
    if action not in {"search", "checkout", "bookable"}:
        raise HotelsError("action must be search, checkout, or bookable")
    destination = lookup_city(destination_name)
    wanted = blank(input_data.get("property_id"))
    found = search_stays(
        destination,
        check_in,
        check_out,
        adults,
        payment_type,
        lodging,
        wanted if action == "checkout" else "",
    )
    stays = [stay for stay in found["stays"] if stay["free_cancellation"]] or found["stays"]
    result = {
        "status": "completed",
        "action": action,
        "destination": destination["regionName"],
        "check_in": check_in.isoformat(),
        "check_out": check_out.isoformat(),
        "payment_type": payment_type,
        "lodging": lodging or None,
        "heading": found["heading"],
        "stays": [
            {
                "property_id": stay["property_id"],
                "name": stay["name"],
                "price": stay["price"],
                "free_cancellation": stay["free_cancellation"],
                "url": stay["url"],
            }
            for stay in stays
        ],
    }
    if action == "search":
        return result
    if action == "bookable":
        bookable = []
        skipped = []
        for chosen in stays:
            public = result["stays"][[stay["property_id"] for stay in stays].index(chosen["property_id"])]
            try:
                checkout = open_checkout(
                    destination, chosen, check_in, check_out, adults, payment_type, lodging
                )
            except HotelsError as exc:
                skipped.append({"name": chosen["name"], "price": chosen["price"], "reason": str(exc)})
                continue
            if not checkout.get("checkout_url"):
                skipped.append({
                    "name": chosen["name"],
                    "price": chosen["price"],
                    "reason": checkout.get("failure_reason") or "The selected stay has no offer to open",
                })
                continue
            bookable.append({**public, "checkout": checkout})
        result["bookable"] = bookable
        result["skipped"] = skipped
        return result
    candidates = stays
    if wanted:
        candidates = [stay for stay in stays if stay["property_id"] == wanted]
        if not candidates:
            raise HotelsError("No stay matched that property id")
    last_error = HotelsError("No stay matched that property id")
    for chosen in candidates:
        try:
            result["checkout"] = open_checkout(
                destination, chosen, check_in, check_out, adults, payment_type, lodging
            )
        except HotelsError as exc:
            last_error = exc
            continue
        return result
    result["checkout_error"] = str(last_error)
    return result


def blank(value: str | None) -> str:
    text = (value or "").strip()
    if text.lower() in {"", "string", "null", "none"}:
        return ""
    return text


def parse_date(value: str | None, name: str):
    try:
        return datetime.strptime((value or "").strip(), "%Y-%m-%d").date()
    except ValueError as exc:
        raise HotelsError(f"{name} must be YYYY-MM-DD") from exc


if __name__ == "__main__":
    main()
